import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  asAuditEventId,
  asEventId,
  asRepositoryCleanupId,
  type CleanupAction,
  type CleanupPreview,
  type JsonValue,
  type RepositoryCleanup,
  type RepositoryCleanupView,
  type Roadmap,
  type SourceRepository,
  startedAttempts,
  type WorkspaceId,
  type Worktree,
  type RoadmapId,
  type SourceRepositoryId,
  type WorktreeId,
} from '@craftingtable/domain';
import type { GitFailure, GitOperations, GitResult, RepositoryIdentity } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { RepositoryMutationBusyError } from './branch-service.js';
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  NotFoundError,
  windDownRefused,
} from './errors.js';
import type { ExecutionService } from './execution-service.js';
import { worktreeVersion } from './retired-versions.js';
import { WorktreeMutationBusyError } from './worktree-mutation-guard.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * Cleaning up a wound-down roadmap's repositories (R-B11, ADR-073), the only part of a wind-down
 * that touches Git. What it touches is selected by record, never by branch pattern: the worktrees
 * of the versions its wind-down retired, of its attempts and of its preparations. Worktrees are
 * removed under the normal rules; each branch is deleted by compare-and-swap at the tip the plan
 * recorded, while its integration branch at a pinned commit keeps it or, for unmerged work, after
 * a new parked tag keeps it. Default and integration branches, existing tags and the operator's
 * `craftingtable/checks` branches are never touched. The plan is persisted with each action's
 * state, audited `authorized` before its Git step and `done`, `kept` or `refused` after it, and a
 * repeated command resumes it.
 */

/** Told at each point of an action; a test injects a crash by throwing (R-B11 done-when 3). */
export type CleanupObserver = (index: number, point: 'authorized' | 'performed') => void;

/** The operator's own branches, such as `craftingtable/checks` for adopted checks (R-G13). */
const OPERATOR_BRANCH_PREFIX = 'craftingtable/';
const TAG_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** A busy repository (a merge or another mutation holds it) is tried this many times. */
const BUSY_ATTEMPTS = 6;
const BUSY_DELAY_MS = 250;

type BranchAction = Extract<CleanupAction, { kind: 'delete-branch' }>;
type RemovalAction = Extract<CleanupAction, { kind: 'remove-worktree' }>;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ended = (roadmap: Pick<Roadmap, 'status'>) =>
  roadmap.status === 'stopped' || roadmap.status === 'completed';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const finished = (action: CleanupAction) =>
  action.state === 'done' || action.state === 'kept' || action.state === 'refused';

/** The tag that keeps a branch's unmerged work: `<repository directory>/parked/<last segment>`. */
export function parkedTag(repository: Pick<SourceRepository, 'rootPath'>, branch: string) {
  const tail = branch.slice(branch.lastIndexOf('/') + 1);
  const name = basename(repository.rootPath);
  return TAG_SEGMENT.test(tail) && TAG_SEGMENT.test(name) ? `${name}/parked/${tail}` : undefined;
}

/**
 * With discard chosen, a worktree the preview found dirty is removed with its changes (it stays
 * `planned` with code `dirty`, which alone allows the forced removal), and its branch is no
 * longer kept checked out.
 */
function discarding(actions: readonly CleanupAction[]): CleanupAction[] {
  const freed = new Set(
    actions
      .filter((a) => a.kind === 'remove-worktree' && a.code === 'dirty')
      .map((a) => `${a.repositoryId}\0${a.branchName}`),
  );
  return actions.map((a): CleanupAction => {
    if (a.kind === 'remove-worktree' && a.code === 'dirty') {
      const { note: _note, ...rest } = a;
      return { ...rest, state: 'planned' };
    }
    if (
      a.kind === 'delete-branch' &&
      a.code === 'checked-out' &&
      freed.has(`${a.repositoryId}\0${a.branchName}`)
    ) {
      const { code: _code, note: _note, ...rest } = a;
      return { ...rest, state: 'planned' };
    }
    return a;
  });
}

function removal(
  tree: Worktree,
  state: RemovalAction['state'],
  code?: RemovalAction['code'],
  note?: string,
): RemovalAction {
  return {
    kind: 'remove-worktree',
    worktreeId: tree.id,
    repositoryId: tree.repositoryId,
    branchName: tree.branchName,
    state,
    ...(code ? { code } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Why removing a worktree's checkout could lose work (review F1): it cannot be inspected, its
 * HEAD is off its branch (a rebase or a detached checkout holds commits no branch has), or it has
 * changes. Only the last is something the operator may choose to discard.
 */
function removalRisk(
  tree: Worktree,
  inspected: GitResult<RepositoryIdentity>,
): Pick<RemovalAction, 'code' | 'note'> | undefined {
  if (!inspected.ok)
    return {
      code: 'git-failed',
      note: `It could not be inspected: ${inspected.failure.message}`.slice(0, 4000),
    };
  if (inspected.value.branch !== tree.branchName)
    return {
      code: 'ref-moved',
      note: `Its checkout is not on ${tree.branchName} (a rebase or a detached HEAD); commits only it holds would be lost.`,
    };
  if (!inspected.value.clean)
    return { code: 'dirty', note: 'It has uncommitted or untracked changes.' };
  return undefined;
}

/** What other roadmaps still name: their worktrees, and those worktrees' branches by checkout. */
interface OthersNamed {
  readonly trees: ReadonlySet<string>;
  readonly branches: ReadonlySet<string>;
}

/** How a Git refusal leaves a branch action. */
function refusedBy(failure: GitFailure): Pick<BranchAction, 'state' | 'code' | 'note'> {
  return {
    state: 'refused',
    code:
      failure.kind === 'target-checked-out'
        ? 'checked-out'
        : failure.kind === 'target-moved'
          ? 'ref-moved'
          : 'git-failed',
    note: failure.message.slice(0, 4000),
  };
}

export class RepositoryCleanupService {
  private readonly busy = new Set<string>();
  private observer: CleanupObserver | undefined;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly execution: ExecutionService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date,
  ) {}

  observe(observer: CleanupObserver | undefined): void {
    this.observer = observer;
  }

  /**
   * A cleanup still `running` when the daemon starts was interrupted: it asks the operator, who
   * resumes it by repeating the command. The daemon never moves a ref on its own after a start.
   */
  recoverInterrupted(): void {
    for (const cleanup of this.storage.windDowns.runningCleanups())
      if (!cleanup.incomplete)
        this.incomplete(
          cleanup,
          'The daemon restarted during this cleanup. Clean up again to resume it.',
        );
  }

  async view(
    context: AuthContext,
    ws: WorkspaceId,
    roadmapId: RoadmapId,
  ): Promise<RepositoryCleanupView> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor', 'viewer']);
    const roadmap = this.storage.roadmaps.find(ws, roadmapId);
    if (!roadmap) throw new NotFoundError();
    const running = this.storage.windDowns.runningCleanup(ws, roadmapId);
    const latest = this.storage.windDowns.latestCleanup(ws, roadmapId);
    return {
      ...(running ? { running } : {}),
      ...(latest ? { latest } : {}),
      ...(running ? {} : { preview: await this.preview(roadmap) }),
    };
  }

  /** Plans or resumes the cleanup; owner only, with the password again (the route asks). */
  async clean(
    context: AuthContext,
    ws: WorkspaceId,
    roadmapId: RoadmapId,
    input: { readonly expectedDigest: string; readonly discardDirty: boolean },
  ): Promise<RepositoryCleanupView> {
    this.workspaces.requireRole(context, ws, ['owner']);
    const roadmap = this.storage.roadmaps.find(ws, roadmapId);
    if (!roadmap) throw new NotFoundError();
    if (this.busy.has(roadmapId))
      windDownRefused('wind-down-in-progress', 'This cleanup is already running.');
    const running = this.storage.windDowns.runningCleanup(ws, roadmapId);
    if (running) {
      if (
        running.planDigest !== input.expectedDigest ||
        running.discardDirty !== input.discardDirty
      )
        windDownRefused(
          'preview-stale',
          'A cleanup is in progress with another plan. Resume that one.',
        );
      await this.run(running, context);
      return this.view(context, ws, roadmapId);
    }
    const preview = await this.preview(roadmap);
    const refused = preview.refusals[0];
    if (refused) windDownRefused(refused.code, refused.message);
    if (preview.digest !== input.expectedDigest)
      windDownRefused(
        'preview-stale',
        'The repositories changed since the preview. Review it again and try again.',
      );
    const cleanup: RepositoryCleanup = {
      id: asRepositoryCleanupId(randomUUID()),
      workspaceId: ws,
      roadmapId: roadmap.id,
      version: 1,
      status: 'running',
      planDigest: preview.digest,
      discardDirty: input.discardDirty,
      actions: input.discardDirty ? discarding(preview.actions) : [...preview.actions],
      requestedAt: this.now().toISOString(),
      requestedByUserId: context.user.id,
    };
    this.storage.transaction((tx) => {
      // Two commands that both previewed: the second finds the first's plan (review F15).
      if (tx.windDowns.runningCleanup(ws, roadmapId))
        windDownRefused('wind-down-in-progress', 'This cleanup is already running.');
      tx.windDowns.insertCleanup(cleanup);
      this.audit(tx, cleanup, context, 'repository-cleanup.updated', {
        phase: 'requested',
        planDigest: cleanup.planDigest,
        discardDirty: cleanup.discardDirty,
        actions: cleanup.actions.length,
      });
      this.event(tx, cleanup, context);
    });
    this.notifier.notify();
    await this.run(cleanup, context);
    return this.view(context, ws, roadmapId);
  }

  /** What a cleanup would do now: selected from the records, classified from Git. */
  async preview(roadmap: Roadmap): Promise<CleanupPreview> {
    const ws = roadmap.workspaceId;
    const record = this.storage.windDowns.find(ws, roadmap.id);
    if (record?.status !== 'settled' || !ended(roadmap))
      return {
        roadmapId: roadmap.id,
        digest: hash({ roadmapId: roadmap.id, refused: 'roadmap-not-wound-down' }),
        actions: [],
        refusals: [
          {
            code: 'roadmap-not-wound-down',
            message: 'Wind this roadmap down first; only a wound-down roadmap is cleaned up.',
          },
        ],
      };
    const git = this.git;
    if (!git) throw new ExecutionRequestError('unavailable', 'Git is unavailable.');
    const others = this.othersNamed(roadmap.id);
    const { trees, inUse } = this.storage.readTransaction((tx) =>
      this.selected(tx, roadmap, others),
    );
    const byRepository = new Map<string, Worktree[]>();
    for (const tree of trees)
      byRepository.set(tree.repositoryId, [...(byRepository.get(tree.repositoryId) ?? []), tree]);
    const actions: CleanupAction[] = [];
    for (const repositoryId of [...byRepository.keys()].sort()) {
      const repoTrees = byRepository.get(repositoryId)!;
      const repository = this.storage.execution.sourceRepositories.find(
        ws,
        repoTrees[0]!.repositoryId,
      );
      if (repository?.status !== 'active') continue;
      actions.push(...(await this.repositoryPlan(git, repository, repoTrees, inUse, others)));
    }
    return {
      roadmapId: roadmap.id,
      digest: hash({ roadmapId: roadmap.id, windDown: record.id, actions }),
      actions,
      refusals: [],
    };
  }

  /** One repository's actions: its removals first, then its branches, each in a stable order. */
  private async repositoryPlan(
    git: GitOperations,
    repository: SourceRepository,
    trees: readonly Worktree[],
    inUse: ReadonlySet<string>,
    others: OthersNamed,
  ): Promise<CleanupAction[]> {
    const heads = await git.branchHeads(repository.rootPath);
    if (!heads.ok)
      throw new ExecutionRequestError(
        'conflict',
        `${repository.displayName}: ${heads.failure.message}`,
      );
    const refs = heads.value.heads;
    const protectedBranches = this.protectedBranches(repository);
    const actions: CleanupAction[] = [];
    // A parked tag this plan already gives another branch.
    const tagged = new Set<string>();
    // A worktree that stays keeps its branch checked out.
    const staying = new Set<string>();
    for (const tree of [...trees].sort((a, b) => a.id.localeCompare(b.id))) {
      if (tree.status !== 'active') continue;
      if (inUse.has(tree.id)) {
        staying.add(tree.branchName);
        actions.push(
          removal(
            tree,
            'kept',
            'in-use',
            'Another roadmap, an active cycle or a live run holds it.',
          ),
        );
        continue;
      }
      const risk = await this.checkoutRisk(git, repository, tree);
      if (risk) {
        staying.add(tree.branchName);
        actions.push(removal(tree, 'kept', risk.code, risk.note));
      } else actions.push(removal(tree, 'planned'));
    }
    const named = new Map<string, Worktree>();
    for (const tree of trees) if (!named.has(tree.branchName)) named.set(tree.branchName, tree);
    for (const branch of [...named.keys()].sort()) {
      const tree = named.get(branch)!;
      const tip = refs[`refs/heads/${branch}`];
      if (tip === undefined) continue;
      const integration = tree.integrationBranch ?? tree.baseBranch;
      const pinned = refs[`refs/heads/${integration}`];
      const action = (
        keeper: BranchAction['keeper'],
        fields: Pick<BranchAction, 'state' | 'code' | 'note'>,
      ) =>
        actions.push({
          kind: 'delete-branch',
          repositoryId: repository.id,
          branchName: branch,
          tipSha: tip,
          keeper,
          ...fields,
        });
      const integrationKeeper = {
        kind: 'integration' as const,
        branch: integration,
        pinnedSha: pinned ?? tip,
      };
      const guarded = this.branchGuard(repository, branch, others, protectedBranches);
      if (guarded) {
        action(integrationKeeper, { state: 'kept', ...guarded });
        continue;
      }
      let contained = false;
      if (pinned !== undefined && integration !== branch) {
        const ancestry = await git.isAncestor(repository.rootPath, tip, pinned);
        if (!ancestry.ok)
          throw new ExecutionRequestError(
            'conflict',
            `${repository.displayName}: ${ancestry.failure.message}`,
          );
        contained = ancestry.value;
      }
      const tag = parkedTag(repository, branch);
      if (!contained && tag === undefined) {
        action(integrationKeeper, {
          state: 'refused',
          code: 'git-failed',
          note: 'Its name cannot form a parked tag, so its unmerged work would be lost.',
        });
        continue;
      }
      const keeper: BranchAction['keeper'] = contained
        ? integrationKeeper
        : { kind: 'parked-tag', tag: tag! };
      const existing = tag && !contained ? refs[`refs/tags/${tag}`] : undefined;
      if ((existing !== undefined && existing !== tip) || (tag && !contained && tagged.has(tag))) {
        action(keeper, {
          state: 'refused',
          code: 'tag-exists',
          note: `Tag ${tag} already names another commit, or another branch of this plan.`,
        });
        continue;
      }
      if (tag && !contained) tagged.add(tag);
      action(
        keeper,
        staying.has(branch)
          ? { state: 'kept', code: 'checked-out', note: 'Its worktree stays.' }
          : { state: 'planned' },
      );
    }
    return actions;
  }

  /**
   * The worktrees this roadmap's records name: its attempts', its preparations' and the retired
   * versions'. One another roadmap still owns, or with an active cycle or a live run, stays.
   */
  private selected(tx: StorageRepositories, roadmap: Roadmap, others: OthersNamed) {
    const ws = roadmap.workspaceId;
    const record = tx.windDowns.find(ws, roadmap.id);
    const retired = new Set<string>(record?.retire.map((r) => r.planVersionId) ?? []);
    const named = new Set<string>([
      ...startedAttempts(roadmap).map((a) => a.worktreeId),
      ...(roadmap.decisionPreparations ?? []).map((p) => p.worktreeId),
    ]);
    const trees = tx.execution.worktrees
      .listForWorkspace(ws)
      .filter((t) => named.has(t.id) || retired.has(worktreeVersion(tx, t) ?? ''));
    const inUse = new Set<string>(
      trees
        .filter(
          (t) =>
            others.trees.has(t.id) ||
            tx.execution.cycles.activeForWorktree(ws, t.id) !== undefined ||
            tx.execution.runs.liveForWorktree(ws, t.id).length > 0,
        )
        .map((t) => t.id),
    );
    return { trees, inUse };
  }

  /**
   * Branches no cleanup touches, in any workspace that registers this checkout: its default
   * branches; every plan's integration and manual merge branches; every roadmap's integration
   * branches; active worktrees' integration (or, before branch configuration, base) branches;
   * finalizations' integration and target branches; and pending merges' targets (review F12).
   */
  private protectedBranches(repository: SourceRepository): ReadonlySet<string> {
    const execution = this.storage.execution;
    const sameRoot = (ws: WorkspaceId, id: SourceRepositoryId) =>
      execution.sourceRepositories.find(ws, id as SourceRepository['id'])?.rootPath ===
      repository.rootPath;
    const treeHere = (ws: WorkspaceId, id: WorktreeId) => {
      const tree = execution.worktrees.find(ws, id as Worktree['id']);
      return tree !== undefined && sameRoot(ws, tree.repositoryId);
    };
    return new Set<string>([
      repository.defaultBranch,
      ...execution.sourceRepositories
        .listAll()
        .filter((r) => r.rootPath === repository.rootPath)
        .map((r) => r.defaultBranch),
      ...execution.branchSettings
        .list()
        .filter((s) => sameRoot(s.workspaceId, s.repositoryId))
        .flatMap((s) => [s.integrationBranch, ...(s.manualMergeBranches ?? [])]),
      ...this.storage.roadmaps
        .list()
        .flatMap((r) => [
          ...r.definition.entries
            .filter((e) => sameRoot(r.workspaceId, e.repositoryId))
            .map((e) => e.integrationBranch),
          ...(r.decisionPreparations ?? [])
            .filter((p) => sameRoot(r.workspaceId, p.repositoryId))
            .map((p) => p.integrationBranch),
        ]),
      ...execution.worktrees
        .listActive()
        .filter((t) => sameRoot(t.workspaceId, t.repositoryId))
        .map((t) => t.integrationBranch ?? t.baseBranch),
      ...execution.finalizations
        .list()
        .filter((f) => sameRoot(f.workspaceId, f.repositoryId))
        .flatMap((f) => [f.integrationBranch, f.targetBranch]),
      ...execution.merges
        .pending()
        .filter((m) => treeHere(m.workspaceId, m.worktreeId))
        .map((m) => m.targetBranch),
    ]);
  }

  /**
   * What removing a worktree could lose (review F1, N6): its checkout, inspected; or with the
   * checkout gone, the HEAD Git still records for it, which a removal's prune would drop.
   */
  private async checkoutRisk(
    git: GitOperations,
    repository: SourceRepository,
    tree: Worktree,
  ): Promise<Pick<RemovalAction, 'code' | 'note'> | undefined> {
    if (existsSync(tree.path)) return removalRisk(tree, await git.inspectRepository(tree.path));
    const recorded = await git.worktreeHead({
      repositoryPath: repository.rootPath,
      worktreePath: tree.path,
    });
    if (!recorded.ok)
      return {
        code: 'git-failed',
        note: `Its worktree could not be read: ${recorded.failure.message}`.slice(0, 4000),
      };
    if (recorded.value && recorded.value.branch !== tree.branchName)
      return {
        code: 'ref-moved',
        note: `Its checkout is gone, and Git records its HEAD off ${tree.branchName}; removing it would drop that commit.`,
      };
    return undefined;
  }

  /** Other roadmaps that have not ended, in any workspace, keep what they name (review F2, F5). */
  private othersNamed(roadmapId: RoadmapId): OthersNamed {
    const trees = new Set<string>();
    const branches = new Set<string>();
    for (const r of this.storage.roadmaps.list()) {
      if (r.id === roadmapId || ended(r)) continue;
      for (const id of [
        ...startedAttempts(r).map((a) => a.worktreeId),
        ...(r.decisionPreparations ?? []).map((p) => p.worktreeId),
      ]) {
        trees.add(id);
        const tree = this.storage.execution.worktrees.find(r.workspaceId, id);
        const root =
          tree &&
          this.storage.execution.sourceRepositories.find(r.workspaceId, tree.repositoryId)
            ?.rootPath;
        if (tree && root) branches.add(`${root}\0${tree.branchName}`);
      }
    }
    return { trees, branches };
  }

  /** Why a branch stays whatever the plan said: protected, or another roadmap names it. */
  private branchGuard(
    repository: SourceRepository,
    branch: string,
    others: OthersNamed,
    protectedBranches = this.protectedBranches(repository),
  ): Pick<BranchAction, 'code' | 'note'> | undefined {
    if (protectedBranches.has(branch) || branch.startsWith(OPERATOR_BRANCH_PREFIX))
      return {
        code: 'protected',
        note: 'A default, integration, target or operator branch is never cleaned up.',
      };
    if (others.branches.has(`${repository.rootPath}\0${branch}`))
      return { code: 'in-use', note: 'Another roadmap that has not ended names it.' };
    return undefined;
  }

  /** Each action in order, from its persisted state; a finished one is never repeated. */
  private async run(cleanup: RepositoryCleanup, context: AuthContext): Promise<void> {
    if (this.busy.has(cleanup.roadmapId)) return;
    this.busy.add(cleanup.roadmapId);
    let current = cleanup;
    try {
      if (current.incomplete) current = this.write(current, { incomplete: undefined });
      for (let index = 0; index < current.actions.length; index++) {
        const action = current.actions[index]!;
        if (finished(action)) continue;
        if (action.state === 'planned') {
          current = this.setAction(current, index, { state: 'authorized' }, context);
          this.observer?.(index, 'authorized');
        }
        const outcome = await this.perform(current, current.actions[index]!, context);
        this.observer?.(index, 'performed');
        current = this.setAction(current, index, outcome, context);
      }
      this.finish(current, context);
    } catch (error) {
      this.incomplete(
        this.storage.windDowns.cleanup(current.workspaceId, current.id) ?? current,
        error instanceof Error ? error.message : 'The cleanup stopped.',
      );
    } finally {
      this.busy.delete(cleanup.roadmapId);
      this.notifier.notify();
    }
  }

  /** Does one authorized action, idempotently; its outcome is `done`, `kept` or `refused`. */
  private async perform(
    cleanup: RepositoryCleanup,
    action: CleanupAction,
    context: AuthContext,
  ): Promise<Pick<CleanupAction, 'state' | 'code' | 'note'>> {
    const repository = this.storage.execution.sourceRepositories.find(
      cleanup.workspaceId,
      action.repositoryId,
    );
    if (repository?.status !== 'active')
      return { state: 'refused', code: 'git-failed', note: 'The repository is unavailable.' };
    const git = this.git;
    if (!git) throw new ExecutionRequestError('unavailable', 'Git is unavailable.');
    // What the plan said is checked again now: a resumed plan never moves what a fresh preview
    // would keep (review F2).
    const others = this.othersNamed(cleanup.roadmapId);
    if (action.kind === 'remove-worktree') {
      const tree = this.storage.execution.worktrees.find(cleanup.workspaceId, action.worktreeId);
      if (tree?.status === 'active') {
        if (
          others.trees.has(tree.id) ||
          this.storage.execution.cycles.activeForWorktree(cleanup.workspaceId, tree.id) ||
          this.storage.execution.runs.liveForWorktree(cleanup.workspaceId, tree.id).length
        )
          return {
            state: 'kept',
            code: 'in-use',
            note: 'Another roadmap, an active cycle or a live run holds it.',
          };
        const risk = await this.checkoutRisk(git, repository, tree);
        // Changes go only where the plan found them and the operator chose to discard them.
        if (risk && !(risk.code === 'dirty' && cleanup.discardDirty && action.code === 'dirty'))
          return { state: 'kept', ...risk };
      }
      try {
        await this.whenFree(() =>
          this.execution.removeWorktree(
            context,
            cleanup.workspaceId,
            action.worktreeId,
            undefined,
            {
              // Only a worktree the preview showed dirty, and the operator chose to discard.
              discardChanges: cleanup.discardDirty && action.code === 'dirty',
            },
          ),
        );
        return { state: 'done' };
      } catch (error) {
        // A busy repository or worktree leaves the cleanup to resume (review F7).
        if (
          !(error instanceof ExecutionRequestError) ||
          error instanceof RepositoryMutationBusyError ||
          error instanceof WorktreeMutationBusyError
        )
          throw error;
        if (error.detail?.reason === 'worktree-has-changes')
          return { state: 'kept', code: 'dirty', note: error.message.slice(0, 4000) };
        return { state: 'kept', code: 'git-failed', note: error.message.slice(0, 4000) };
      }
    }
    const guarded = this.branchGuard(repository, action.branchName, others);
    if (guarded) return { state: 'kept', ...guarded };
    const result = await this.whenFree(() =>
      this.execution.branches.duringMerge(repository.rootPath, async () => {
        if (action.keeper.kind === 'parked-tag') {
          const kept = await git.preserveRef({
            repositoryPath: repository.rootPath,
            tag: action.keeper.tag,
            commitSha: action.tipSha,
          });
          if (!kept.ok) return kept;
        }
        return git.deleteContainedBranch({
          repositoryPath: repository.rootPath,
          branchName: action.branchName,
          expectedTipSha: action.tipSha,
          keeper:
            action.keeper.kind === 'parked-tag'
              ? { ref: `refs/tags/${action.keeper.tag}`, pinnedSha: action.tipSha }
              : { ref: `refs/heads/${action.keeper.branch}`, pinnedSha: action.keeper.pinnedSha },
        });
      }),
    );
    if (result.ok) return { state: 'done' };
    // Git's refusal keeps the branch and ends this action; the cleanup goes on, and a later one
    // plans the branch again (review F8). A busy repository threw above, to resume.
    return refusedBy(result.failure);
  }

  /** Runs a repository mutation, waiting a little while another one holds the repository. */
  private async whenFree<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof RepositoryMutationBusyError) || attempt >= BUSY_ATTEMPTS)
          throw error;
        await delay(BUSY_DELAY_MS * attempt);
      }
    }
  }

  private setAction(
    cleanup: RepositoryCleanup,
    index: number,
    outcome: Pick<CleanupAction, 'state' | 'code' | 'note'>,
    context: AuthContext,
  ): RepositoryCleanup {
    const previous = cleanup.actions[index]!;
    const { code: _code, note: _note, ...base } = previous;
    // Authorizing keeps what the plan said (a `dirty` removal the operator chose to discard);
    // an outcome replaces it.
    const action = (
      outcome.state === 'authorized'
        ? { ...previous, state: 'authorized' }
        : { ...base, ...outcome }
    ) as CleanupAction;
    const next: RepositoryCleanup = {
      ...cleanup,
      version: cleanup.version + 1,
      actions: cleanup.actions.map((a, i) => (i === index ? action : a)),
    };
    this.storage.transaction((tx) => {
      if (!tx.windDowns.replaceCleanup(next, cleanup.version))
        throw new ConcurrentModificationError('The cleanup changed while it ran.');
      this.audit(tx, next, context, 'repository-cleanup.action', {
        index,
        phase: action.state,
        kind: action.kind,
        repositoryId: action.repositoryId,
        branchName: action.branchName,
        ...(action.kind === 'remove-worktree'
          ? { worktreeId: action.worktreeId }
          : {
              tipSha: action.tipSha,
              keeper:
                action.keeper.kind === 'parked-tag'
                  ? { kind: 'parked-tag', tag: action.keeper.tag }
                  : {
                      kind: 'integration',
                      branch: action.keeper.branch,
                      pinnedSha: action.keeper.pinnedSha,
                    },
            }),
        ...(action.code ? { code: action.code } : {}),
      });
      this.event(tx, next, context);
    });
    return next;
  }

  private finish(cleanup: RepositoryCleanup, context: AuthContext): void {
    const { incomplete: _cleared, ...rest } = cleanup;
    const done: RepositoryCleanup = {
      ...rest,
      version: cleanup.version + 1,
      status: 'done',
      finishedAt: this.now().toISOString(),
    };
    const count = (state: CleanupAction['state']) =>
      done.actions.filter((a) => a.state === state).length;
    this.storage.transaction((tx) => {
      if (!tx.windDowns.replaceCleanup(done, cleanup.version))
        throw new ConcurrentModificationError('The cleanup changed while it ran.');
      this.audit(tx, done, context, 'repository-cleanup.updated', {
        phase: 'finished',
        done: count('done'),
        kept: count('kept'),
        refused: count('refused'),
      });
      this.event(tx, done, context);
    });
  }

  private write(cleanup: RepositoryCleanup, fields: Partial<RepositoryCleanup>): RepositoryCleanup {
    const { incomplete: _cleared, ...rest } = cleanup;
    const next: RepositoryCleanup = {
      ...rest,
      ...(fields.incomplete ? { incomplete: fields.incomplete } : {}),
      version: cleanup.version + 1,
    };
    this.storage.transaction((tx) => {
      if (!tx.windDowns.replaceCleanup(next, cleanup.version))
        throw new ConcurrentModificationError('The cleanup changed while it ran.');
      this.event(tx, next, undefined);
    });
    return next;
  }

  /** Records why the cleanup stopped; its item asks the operator to repeat the command. */
  private incomplete(cleanup: RepositoryCleanup, message: string): void {
    try {
      const current = this.storage.windDowns.cleanup(cleanup.workspaceId, cleanup.id);
      if (current?.status !== 'running') return;
      const next: RepositoryCleanup = {
        ...current,
        version: current.version + 1,
        incomplete: {
          at: this.now().toISOString(),
          message: (message || 'Failed.').slice(0, 4000),
        },
      };
      this.storage.transaction((tx) => {
        if (!tx.windDowns.replaceCleanup(next, current.version)) return;
        this.audit(tx, next, undefined, 'repository-cleanup.updated', {
          phase: 'incomplete',
          message: next.incomplete!.message,
        });
        this.event(tx, next, undefined);
      });
    } catch {
      // Recorded on the next attempt.
    }
  }

  private audit(
    tx: StorageRepositories,
    cleanup: RepositoryCleanup,
    context: AuthContext | undefined,
    action: 'repository-cleanup.updated' | 'repository-cleanup.action',
    metadata: Record<string, JsonValue>,
  ): void {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: this.now().toISOString(),
      workspaceId: cleanup.workspaceId,
      actorKind: context ? 'user' : 'system',
      actorUserId: context?.user.id ?? cleanup.requestedByUserId,
      ...(context ? { sessionId: context.session.id } : {}),
      action,
      targetType: 'roadmap',
      targetId: cleanup.roadmapId,
      outcome: 'succeeded',
      resultingVersion: cleanup.version,
      metadata: { cleanupId: cleanup.id, ...metadata },
    });
  }

  private event(
    tx: StorageRepositories,
    cleanup: RepositoryCleanup,
    context: AuthContext | undefined,
  ): void {
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: this.now().toISOString(),
      workspaceId: cleanup.workspaceId,
      ...(context ? { actorUserId: context.user.id } : {}),
      kind: 'repository-cleanup-changed',
      payload: { roadmapId: cleanup.roadmapId, cleanupId: cleanup.id, status: cleanup.status },
    });
  }
}
