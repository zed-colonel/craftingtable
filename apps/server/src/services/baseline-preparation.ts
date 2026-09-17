import { createHash, randomUUID } from 'node:crypto';
import {
  readdirSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { BaselinePreparation, WorkCycle } from '@craftingtable/domain';
import type { BaselinePreview, PrepareBaselineRequest } from '@craftingtable/contracts';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { GitOperations } from '@craftingtable/git';
import { prepareHistoricalCargoLauncher } from '@craftingtable/agents';
import type { ExecutionConfig } from '../config.js';
import { resolveExecutable } from './executables.js';
import { ExecutionRequestError } from './errors.js';

const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
function conflict(s: string): never {
  throw new ExecutionRequestError('conflict', s);
}
const safeName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(s);
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path))
    conflict('Historical storage contains a symlink or changed directory.');
}

/** Source-only historical environments. Never produce current-runtime verification receipts. */
export class BaselinePreparationService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly git: GitOperations | undefined,
    private readonly config: ExecutionConfig,
  ) {}
  private requireGit() {
    if (!this.git) throw new ExecutionRequestError('unavailable', 'Git is unavailable.');
    return this.git;
  }
  private context(cycle: WorkCycle) {
    const ws = cycle.workspaceId;
    const tree = this.storage.execution.worktrees.find(ws, cycle.worktreeId);
    const item = cycle.workItemId && this.storage.planning.workItems.find(ws, cycle.workItemId);
    const scope = cycle.executionScope;
    const binding =
      scope &&
      this.storage.imports
        .bindings(ws, scope.definitionId)
        .find((b) => b.revision === scope.bindingRevision);
    return hash(
      JSON.stringify({
        workItem: item && { id: item.id, planVersionId: item.planVersionId },
        worktree: tree && {
          id: tree.id,
          repositoryId: tree.repositoryId,
          baseSha: tree.baseSha,
          integrationBranch: tree.integrationBranch,
        },
        scope,
        binding,
        mapDigest: scope && this.storage.imports.definition(ws, scope.definitionId)?.digest,
      }),
    );
  }
  async preview(cycle: WorkCycle): Promise<BaselinePreview> {
    const ws = cycle.workspaceId;
    const tree = this.storage.execution.worktrees.find(ws, cycle.worktreeId);
    if (!tree) conflict('Worktree unavailable.');
    const scope = cycle.executionScope;
    const definition = scope && this.storage.imports.definition(ws, scope.definitionId);
    const binding =
      scope &&
      this.storage.imports
        .bindings(ws, scope.definitionId)
        .find((b) => b.revision === scope.bindingRevision);
    const bindings = binding?.bindings.filter((b) => b.repositoryId) ?? [
      {
        alias: 'application',
        repositoryId: tree.repositoryId,
        planVersionId: cycle.workItemId
          ? this.storage.planning.workItems.find(ws, cycle.workItemId)?.planVersionId
          : undefined,
      },
    ];
    if (bindings.length > 8)
      conflict('Historical preparation supports at most eight repositories.');
    const sources: BaselinePreview['sources'] = [];
    let consumerAlias = '';
    for (const b of bindings) {
      if (!b.repositoryId) continue;
      const repo = this.storage.execution.sourceRepositories.find(ws, b.repositoryId);
      if (repo?.status !== 'active') conflict('A bound repository is unavailable.');
      const source = definition?.source.repositories.find((r) => r.id === b.alias);
      const directoryName = source ? basename(source.repository) : basename(repo.rootPath);
      if (!safeName(directoryName))
        conflict('Repository directory name is unsupported for historical sibling provisioning.');
      const consumer = repo.id === tree.repositoryId;
      if (consumer) consumerAlias = b.alias;
      let ref = source?.source_baseline_commit ?? (consumer ? tree.baseSha : '');
      let explanation = 'Imported source baseline; review before preparing.';
      let tag = '';
      if (source?.role === 'implemented_upstream') {
        const tags = await this.requireGit().listBaselineTags(repo.rootPath);
        if (!tags.ok) conflict(tags.failure.message);
        ref = tags.value.length === 1 ? `refs/tags/${tags.value[0]}` : '';
        explanation =
          tags.value.length === 1
            ? 'Retained pre-redesign tag. Confirm this is the historical dependency baseline.'
            : 'Select an exact historical commit or local tag; no unique pre-redesign tag was found.';
      }
      if (b.planVersionId) {
        const text = this.storage.planning.artifacts
          .listForVersion(ws, b.planVersionId)
          .map((a) => this.storage.planning.artifacts.findWithContent(ws, a.id))
          .filter((a) => !!a)
          .map((a) => Buffer.from(a.content).toString('utf8'))
          .join('\n');
        const candidates = [
          ...new Set(text.match(/\b[A-Za-z0-9_-]+\/pre-[A-Za-z0-9._-]+/g) ?? []),
        ].filter((t) => t.startsWith(`${directoryName}/`));
        if (candidates.length === 1) tag = candidates[0]!;
      }
      if (ref) {
        const resolved = await this.requireGit().resolveCommit(repo.rootPath, ref);
        if (!resolved.ok) conflict(resolved.failure.message);
        if (ref.startsWith('refs/tags/')) explanation += ` Resolved ${ref}.`;
        ref = resolved.value.commitSha;
      }
      sources.push({
        alias: b.alias,
        repositoryId: repo.id,
        directoryName,
        ref,
        tag,
        explanation,
        fixed: source?.role !== 'implemented_upstream',
      });
    }
    if (!consumerAlias || new Set(sources.map((s) => s.directoryName)).size !== sources.length)
      conflict('Historical repository bindings are ambiguous.');
    return {
      expectedVersion: cycle.version,
      contextDigest: this.context(cycle),
      consumerAlias,
      sources,
      notices: [
        'Preparation retains exact source snapshots in configured worktree storage. Run-specific copies and build caches use configured run storage.',
        'Optional tags are local only, never moved or published. Remote branch protection remains an operator policy decision.',
        'Historical collection uses original lockfiles and sibling path dependencies. It cannot satisfy current dependency verification or approve architectural decisions.',
        'The selected historical commits are an explicit operator binding, not a claim that a previous build used these exact revisions.',
      ],
    };
  }
  async resolve(cycle: WorkCycle, input: PrepareBaselineRequest): Promise<BaselinePreparation> {
    const preview = await this.preview(cycle);
    if (preview.contextDigest !== input.contextDigest || cycle.version !== input.expectedVersion)
      conflict('Baseline context changed. Refresh preparation.');
    if (
      input.sources.length !== preview.sources.length ||
      new Set(input.sources.map((s) => s.alias)).size !== input.sources.length
    )
      conflict('Supply every bound historical repository exactly once.');
    const sources: BaselinePreparation['sources'][number][] = [];
    for (const selection of input.sources) {
      const p = preview.sources.find((s) => s.alias === selection.alias);
      if (!p) conflict('Unknown historical repository.');
      if ((selection.tag ?? '') !== p.tag)
        conflict('Only the exact baseline tag proposed by the bound plan can be created.');
      const repo = this.storage.execution.sourceRepositories.find(
        cycle.workspaceId,
        p.repositoryId,
      )!;
      const resolved = await this.requireGit().resolveCommit(repo.rootPath, selection.ref);
      if (!resolved.ok) conflict(resolved.failure.message);
      // Application source baselines come from the imported contract; only upstream historical refs are selectable.
      if (p.fixed && resolved.value.commitSha !== p.ref)
        conflict(`The ${p.alias} source baseline must match its imported plan.`);
      sources.push({
        alias: p.alias,
        repositoryId: p.repositoryId,
        directoryName: p.directoryName,
        commitSha: resolved.value.commitSha,
        ...(selection.tag ? { tag: selection.tag } : {}),
      });
    }
    const id = randomUUID();
    return {
      id,
      contextDigest: preview.contextDigest,
      createdAt: new Date().toISOString(),
      createdByUserId: cycle.createdByUserId,
      status: 'preparing',
      directory: join(this.config.worktreeRoot, '.baselines', cycle.workspaceId, id),
      consumerAlias: preview.consumerAlias,
      sources,
      message: 'Preparing local tags and historical source snapshots.',
    };
  }
  assertCurrent(cycle: WorkCycle, preparation: BaselinePreparation) {
    if (this.context(cycle) !== preparation.contextDigest)
      conflict('Baseline bindings changed during preparation. Refresh setup.');
  }
  evidence(cycle: WorkCycle) {
    const runs = this.storage.execution.runs
      .listForWorktree(cycle.workspaceId, cycle.worktreeId)
      .slice(0, 20);
    const artifacts: { runId: string; name: string; content: string; truncated: boolean }[] = [];
    for (const run of runs) {
      const record = this.storage.maintenance.directory(run.id);
      if (!record) continue;
      const root = join(record.path, 'historical-evidence');
      if (
        !existsSync(root) ||
        realpathSync(root) !== root ||
        !lstatSync(root).isDirectory() ||
        lstatSync(root).dev !== record.device
      )
        continue;
      for (const name of readdirSync(root)
        .filter((n) => n === 'commands.jsonl' || /^\d+-\d+\.log$/.test(n))
        .sort()
        .slice(0, 16)) {
        if (artifacts.length >= 32) break;
        const path = join(root, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || realpathSync(path) !== path) continue;
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, 32000));
          const count = readSync(fd, buffer, 0, buffer.length, 0);
          artifacts.push({
            runId: run.id,
            name,
            content: buffer.subarray(0, count).toString('utf8'),
            truncated: stat.size > count,
          });
        } finally {
          closeSync(fd);
        }
      }
    }
    return {
      artifacts,
      notice:
        'Most recent 20 runs; up to 32 artifacts, 32 KB each. Full originals remain in run storage. Historical observations do not approve current-runtime checks.',
    };
  }
  async prepare(
    cycle: WorkCycle,
    preparation: BaselinePreparation,
    guard: () => void,
    repositoryGuard: <T>(path: string, fn: () => Promise<T>) => Promise<T>,
  ) {
    privateDirectory(preparation.directory);
    for (const source of preparation.sources) {
      guard();
      const repo = this.storage.execution.sourceRepositories.find(
        cycle.workspaceId,
        source.repositoryId,
      );
      if (repo?.status !== 'active') conflict('Historical repository retired during preparation.');
      const exported = await this.requireGit().exportCommit(repo.rootPath, source.commitSha);
      if (!exported.ok) conflict(exported.failure.message);
      guard();
      const root = join(preparation.directory, source.directoryName);
      privateDirectory(root);
      for (const file of exported.value) {
        const path = join(root, file.path);
        privateDirectory(dirname(path));
        writeFileSync(path, file.content, { mode: file.executable ? 0o500 : 0o400, flag: 'wx' });
      }
      if (source.tag)
        await repositoryGuard(repo.rootPath, async () => {
          guard();
          const tagged = await this.requireGit().ensureBaselineTag(
            repo.rootPath,
            source.tag!,
            source.commitSha,
          );
          if (!tagged.ok) conflict(tagged.failure.message);
        });
    }
    guard();
    writeFileSync(
      join(preparation.directory, 'preparation.json'),
      JSON.stringify(
        {
          ...preparation,
          status: 'prepared',
          message:
            'Historical source snapshots and local tags recorded. No test results or approvals are implied.',
        },
        null,
        2,
      ),
      { mode: 0o400, flag: 'wx' },
    );
  }
  async materialize(cycle: WorkCycle, runDirectory: string) {
    const p = cycle.baselinePreparation;
    if (p?.status !== 'prepared') return;
    if (this.context(cycle) !== p.contextDigest)
      conflict('Historical preparation is stale. Refresh baseline preparation before recovery.');
    const cargoExecutable = resolveExecutable('cargo', undefined, process.env, [
      join(homedir(), '.cargo', 'bin'),
    ]);
    if (!cargoExecutable)
      throw new ExecutionRequestError(
        'unavailable',
        'Cargo is unavailable for historical collection.',
      );
    const root = join(runDirectory, 'scratch', 'historical');
    privateDirectory(root);
    const files: { path: string; digest: string }[] = [];
    for (const source of p.sources) {
      const repo = this.storage.execution.sourceRepositories.find(
        cycle.workspaceId,
        source.repositoryId,
      );
      if (repo?.status !== 'active') conflict('Historical repository unavailable.');
      // Re-export exact Git objects rather than trusting mutable files left by earlier agents.
      const exported = await this.requireGit().exportCommit(repo.rootPath, source.commitSha);
      if (!exported.ok) conflict(exported.failure.message);
      for (const file of exported.value) {
        const path = join(root, source.directoryName, file.path);
        privateDirectory(dirname(path));
        writeFileSync(path, file.content, { mode: file.executable ? 0o700 : 0o600, flag: 'wx' });
        files.push({ path, digest: hash(file.content) });
      }
    }
    const consumer = p.sources.find((s) => s.alias === p.consumerAlias)!;
    const directory = join(runDirectory, 'historical-evidence');
    privateDirectory(directory);
    const cargoHome = join(this.config.worktreeRoot, '.historical-cargo');
    privateDirectory(cargoHome);
    return {
      cargoHome,
      ...prepareHistoricalCargoLauncher(directory, {
        cargoHome,
        preparationId: p.id,
        sources: p.sources,
        sourceRoots: p.sources.map((s) => join(root, s.directoryName)),
        cargoExecutable,
        workspacePath: join(root, consumer.directoryName),
        files,
        targetDirectory: join(runDirectory, 'scratch', 'historical-target'),
        receiptPath: join(directory, 'commands.jsonl'),
        logDirectory: directory,
        timeoutMs: Math.min(cycle.policy.maxRunMinutes * 60000, 30 * 60000),
      }),
    };
  }
}
