/**
 * What a run's sandbox is given beside its worktree (R-B7): the worktree's Git directories, so a
 * sandboxed run can commit (R-G14), and its build cache.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentLaunchRequest,
  repositoryEnablesWorktreeConfig,
  worktreeGitDirectories,
} from '@craftingtable/agents';
import type { WorkspaceId, Worktree } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../../config.js';
import { WORKTREE_CACHES_DIRECTORY } from '../storage-files.js';
import { resolveExecutable } from '../executables.js';
import type { RunLog } from './shared.js';

export class RunSandbox {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly config: ExecutionConfig,
    private readonly log: RunLog,
    private readonly now: () => Date,
  ) {}

  /**
   * The worktree's Git directories as the daemon resolves them from the repository's primary
   * checkout (R-G14), or nothing when they cannot be resolved or do not agree: the run then
   * cannot commit from a sandbox, and the daemon says why in its log.
   */
  async worktreeGitDirectories(
    workspaceId: WorkspaceId,
    worktree: Pick<Worktree, 'repositoryId' | 'path'>,
  ): Promise<Pick<AgentLaunchRequest, 'gitDirectories'>> {
    const repository = this.storage.execution.sourceRepositories.find(
      workspaceId,
      worktree.repositoryId,
    );
    const gitExecutable = resolveExecutable('git', this.config.gitExecutable);
    const resolved =
      repository && gitExecutable
        ? worktreeGitDirectories(gitExecutable, worktree.path, repository.rootPath)
        : undefined;
    if (resolved === undefined) {
      this.log.warn("A worktree's Git directories could not be resolved for its run", {
        worktree: worktree.path,
      });
      return {};
    }
    // Whether the repository reads per-worktree configuration, from its own configuration
    // (operator decision 2026-10-08): Codex then gets no Git grant, as a run could create its
    // `config.worktree`.
    return {
      gitDirectories: {
        ...resolved,
        worktreeConfig:
          gitExecutable === undefined ||
          (await repositoryEnablesWorktreeConfig(gitExecutable, resolved.gitCommonDirectory)),
      },
    };
  }

  /**
   * The worktree's shared Cargo target directory (R-G7), registered at the worktree's first
   * launch and reused by every later step, so each step builds incrementally instead of from
   * cold. Cargo creates the directory on its first build, so a worktree that never builds
   * Rust leaves nothing behind. Storage cleanup removes it once the worktree is merged or
   * removed and nothing runs in it (ADR-039). Without a usable location the run builds in
   * its own scratch, as before.
   */
  worktreeBuildCache(worktree: Worktree, create: boolean): string | undefined {
    try {
      // For a worktree that builds with Cargo the daemon makes the directory before the launch:
      // a sandbox can make only an existing directory writable, and its parent is read-only to
      // the agent, so Cargo could not create it (live 2026-10-13: an off-map run's builds all
      // failed). Storage may have cleaned a recorded cache away; it is made again where it was
      // recorded. A worktree that never builds Rust still leaves nothing.
      const recorded = this.storage.maintenance.worktreeCache(worktree.id);
      if (recorded) {
        if (create) mkdirSync(recorded.path, { recursive: true, mode: 0o700 });
        else if (!existsSync(recorded.path)) return recorded.path;
        const usable =
          lstatSync(recorded.path).isDirectory() && statSync(recorded.path).dev === recorded.device;
        return usable ? recorded.path : undefined;
      }
      const parent = join(this.config.runsRoot, WORKTREE_CACHES_DIRECTORY);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const root = realpathSync(parent);
      const path = join(root, worktree.id);
      if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
      this.storage.maintenance.registerWorktreeCache({
        worktreeId: worktree.id,
        workspaceId: worktree.workspaceId,
        path,
        device: statSync(root).dev,
        createdAt: this.now().toISOString(),
      });
      return path;
    } catch {
      return undefined;
    }
  }
}
