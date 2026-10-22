import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  type AgentRun,
  asAuditEventId,
  asEventId,
  asSourceRepositoryId,
  asWorktreeId,
  type DecisionPreparationId,
  executionScopeKey,
  type FinalizationId,
  heldStop,
  mergeAdoptsChecks,
  required,
  type SourceRepository,
  type SourceRepositoryId,
  type WorkItemId,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { GitOperations, WorktreeDiff } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import { BranchService } from './branch-service.js';
import { checkedOutBranches } from './checkout-fact.js';
import { CheckDefinitionChangedError, ExecutionRequestError, NotFoundError } from './errors.js';
import {
  requireScope,
  requireScopeOwnership,
  requireTreeScope,
  resolveScope,
  scopeChoices,
  scopedReviewIssue,
} from './execution-scope.js';
import { requireGit } from './git-required.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { MergeExecutor } from './merge/executor.js';
import { type MergeGate, mergeGateFor } from './merge/gate.js';
import { ScopeReceipts } from './merge/receipt.js';
import { PhaseGateError, resourceBlockers } from './phase-resources.js';
import type { RepositoryChecksService } from './repository-checks-service.js';
import type { RoadmapCheck } from './roadmap-actor.js';
import { latestReviewReport } from './run-lineage.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import type { WorkItemService } from './work-item-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorktreeMutationGuard } from './worktree-mutation-guard.js';

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function isValidBranchName(value: string): boolean {
  return (
    BRANCH_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    !value.includes('@{')
  );
}

function slug(value: string, maximum = 40): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (cleaned.length === 0 ? 'item' : cleaned).slice(0, maximum).replace(/-+$/g, '');
}

export interface ExecutionStatus {
  readonly git: { readonly available: boolean; readonly executable?: string };
  readonly backends: readonly {
    readonly kind: import('@craftingtable/domain').AgentBackendKind;
    readonly label: string;
    readonly available: boolean;
    readonly executable?: string;
    readonly models: readonly import('@craftingtable/domain').AgentModel[];
    /** Where the models came from; a missing backend has none (R-G15). */
    readonly catalog: import('@craftingtable/domain').ModelCatalogStatus;
  }[];
  /** The outside sources sandboxed agent commands may reach, as read at start (R-G14). */
  readonly outsideSources: readonly import('@craftingtable/agents').OutsideSource[];
  /** The check units' caps and the Python profile's tools as last read (R-G17). */
  readonly toolchains: import('./toolchain-service.js').ToolchainStatus;
}

/**
 * Repositories, worktrees, and diffs.
 *
 * Git authority stays behind `GitOperations`; this service owns authorization,
 * durable state, audit, and workspace events. Every mutation is one immediate
 * transaction followed by a notifier signal.
 */
/** A work item's worktrees, runs and merge gates, as its page reads them. */
export interface WorkItemExecution {
  readonly worktrees: readonly (Worktree & { mergeCleanupError?: string })[];
  readonly runs: readonly AgentRun[];
  readonly mergeGates: Readonly<Record<string, MergeGate>>;
}

export class ExecutionService {
  readonly branches: BranchService;
  private readonly merges: MergeExecutor;
  private readonly receipts: ScopeReceipts;
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly git: GitOperations | undefined,
    private readonly config: ExecutionConfig,
    private readonly workItemService: WorkItemService,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    /** Declared checks (R-G13): what a merge adopts, and why a review's definitions stop it. */
    readonly repositoryChecks: RepositoryChecksService,
  ) {
    this.branches = new BranchService(storage, workspaceService, notifier, git, mutations, now);
    this.merges = new MergeExecutor(
      storage,
      workspaceService,
      notifier,
      git,
      config,
      workItemService,
      now,
      mutations,
      runtimeEvidence,
      repositoryChecks,
      this.branches,
    );
    this.receipts = new ScopeReceipts(
      storage,
      workspaceService,
      notifier,
      git,
      workItemService,
      now,
      mutations,
      runtimeEvidence,
      this.branches,
    );
  }

  /**
   * Whether merging this worktree promotes into its repository's default branch, which needs the
   * operator's password again (R-G9 review): the access guard asks after the caller's role.
   */
  mergesIntoDefaultBranch(workspaceId: WorkspaceId, worktreeId: WorktreeId): boolean {
    const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
    if (worktree?.integrationBranch === undefined) return false;
    const repository = this.storage.execution.sourceRepositories.find(
      workspaceId,
      worktree.repositoryId,
    );
    return repository !== undefined && worktree.integrationBranch === repository.defaultBranch;
  }

  listRepositories(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
  ): readonly SourceRepository[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.execution.sourceRepositories.list(workspaceId);
  }

  /**
   * Refuses a path that is not inside one of `CRAFTINGTABLE_REPOSITORY_ROOTS`, links resolved;
   * returns the resolved path.
   */
  private requireUnderRepositoryRoots(path: string): string {
    const real = (value: string) => {
      try {
        return realpathSync(value);
      } catch {
        return resolve(value);
      }
    };
    const target = real(path);
    const inside = (this.config.repositoryRoots ?? []).some((root) => {
      const base = real(root);
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
    });
    if (!inside)
      throw new ExecutionRequestError(
        'invalid-request',
        'Repositories can be registered only under CRAFTINGTABLE_REPOSITORY_ROOTS',
        { reason: 'repository-outside-roots' },
      );
    return target;
  }

  async registerRepository(
    context: AuthContext,
    workspaceId: WorkspaceId,
    input: { readonly rootPath: string; readonly displayName?: string },
    requestId?: string,
  ): Promise<{ readonly repository: SourceRepository; readonly created: boolean }> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    // Only under the configured roots (R-G9): the path, links resolved, is checked before Git
    // reads it, and Git is given that resolved path; the top level it answers is checked again,
    // so a link changed in between cannot move the repository outside them (R-G9 review).
    const resolved = this.requireUnderRepositoryRoots(input.rootPath);
    const inspection = await requireGit(this.git).inspectRepository(resolved);
    if (!inspection.ok) {
      throw new ExecutionRequestError('invalid-request', inspection.failure.message);
    }
    const identity = inspection.value;
    this.requireUnderRepositoryRoots(identity.topLevel);
    const existing = this.storage.execution.sourceRepositories.findActiveByPath(
      workspaceId,
      identity.topLevel,
    );
    if (existing !== undefined) {
      return { repository: existing, created: false };
    }
    const occurredAt = this.now().toISOString();
    const displayName =
      input.displayName?.trim() ||
      identity.topLevel.split('/').filter(Boolean).at(-1) ||
      'repository';
    const repository = this.storage.transaction((tx) => {
      const again = tx.execution.sourceRepositories.findActiveByPath(
        workspaceId,
        identity.topLevel,
      );
      if (again !== undefined) {
        return { repository: again, created: false };
      }
      const created = tx.execution.sourceRepositories.insert({
        id: asSourceRepositoryId(randomUUID()),
        workspaceId,
        displayName,
        rootPath: identity.topLevel,
        defaultBranch: identity.branch === 'HEAD' ? 'main' : identity.branch,
        registeredHeadSha: identity.headSha,
        registeredAt: occurredAt,
        registeredByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'source-repository.register',
        targetType: 'source-repository',
        targetId: created.id,
        outcome: 'succeeded',
        metadata: { rootPath: created.rootPath, headSha: created.registeredHeadSha },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        kind: 'source-repository-registered',
        payload: {
          sourceRepositoryId: created.id,
          displayName: created.displayName,
          rootPath: created.rootPath,
          defaultBranch: created.defaultBranch,
        },
      });
      return { repository: created, created: true };
    });
    if (repository.created) {
      this.notifier.notify();
    }
    return repository;
  }

  retireRepository(
    context: AuthContext,
    workspaceId: WorkspaceId,
    repositoryId: SourceRepositoryId,
    requestId?: string,
  ): { readonly repository: SourceRepository; readonly changed: boolean } {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const repository = tx.execution.sourceRepositories.find(workspaceId, repositoryId);
      if (repository === undefined) {
        throw new NotFoundError();
      }
      if (repository.status === 'retired') {
        return { repository, changed: false };
      }
      const liveWorktrees = tx.execution.worktrees
        .listActive(workspaceId)
        .filter((worktree) => worktree.repositoryId === repositoryId);
      if (liveWorktrees.length > 0) {
        throw new ExecutionRequestError(
          'conflict',
          `Repository still has ${liveWorktrees.length} active worktree(s); remove them first`,
        );
      }
      const retired = tx.execution.sourceRepositories.retire({
        workspaceId,
        repositoryId,
        occurredAt,
      });
      if (retired === undefined) {
        throw new NotFoundError();
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'source-repository.retire',
        targetType: 'source-repository',
        targetId: repositoryId,
        outcome: 'succeeded',
        priorVersion: repository.version,
        resultingVersion: retired.version,
        metadata: {},
      });
      return { repository: retired, changed: true };
    });
    if (result.changed) {
      this.notifier.notify();
    }
    return result;
  }

  /** Local branches of a registered repository, for choosing a merge target. */
  async listBranches(
    context: AuthContext,
    workspaceId: WorkspaceId,
    repositoryId: SourceRepositoryId,
    requestId?: string,
  ): Promise<{ readonly branches: readonly string[]; readonly checkedOut?: string }> {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const repository = this.storage.execution.sourceRepositories.find(workspaceId, repositoryId);
    if (repository === undefined) {
      throw new NotFoundError();
    }
    const listed = await requireGit(this.git).listBranches(repository.rootPath);
    if (!listed.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Repository is not available: ${listed.failure.message}`,
      );
    }
    return listed.value;
  }

  async workItemExecution(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ): Promise<WorkItemExecution> {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const read = this.storage.readTransaction((tx) =>
      this.executionIn(mapReadSnapshot(tx), workspaceId, workItemId),
    );
    return this.confirmGates(read);
  }

  /**
   * A work item's worktrees, runs and merge gates, read in the caller's transaction (R-D5): all
   * but Git's check that a mergeable gate's reviewed branches are still where its review saw
   * them, which `confirmGates` adds after the read.
   */
  executionIn(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
  ): WorkItemExecution {
    if (tx.planning.workItems.find(workspaceId, workItemId) === undefined) {
      throw new NotFoundError();
    }
    const worktrees = tx.execution.worktrees
      .listForWorkItem(workspaceId, workItemId)
      .map((tree) => ({
        ...tree,
        mergeCleanupError: tx.execution.merges.latest(workspaceId, tree.id)?.cleanupError,
      }));
    const runs = tx.execution.runs.listForWorkItem(workspaceId, workItemId);
    const mergeGates: Record<string, MergeGate> = {};
    for (const worktree of worktrees) {
      if (worktree.status === 'active') {
        const cycle = tx.execution.cycles.activeForWorktree(workspaceId, worktree.id);
        mergeGates[worktree.id] =
          cycle !== undefined && cycle.status !== 'awaiting-merge'
            ? { mergeable: false, reason: 'automation-active' }
            : mergeGateFor(worktree, runs);
      }
    }
    for (const worktree of worktrees) {
      const gate = mergeGates[worktree.id];
      if (tx.execution.merges.latest(workspaceId, worktree.id)?.status === 'reserved') {
        mergeGates[worktree.id] = { mergeable: true, reason: 'merge-recovery-required' };
        continue;
      }
      if (worktree.executionScope?.kind && worktree.executionScope.kind !== 'slice') {
        mergeGates[worktree.id] = { mergeable: false, reason: 'scope-review-only' };
        continue;
      }
      if (worktree.executionScope && gate?.mergeable) {
        // A slice whose merge adopts changed check definitions is a person's to merge with
        // them (R-G13 increment 5); the merge itself reads the definitions again.
        const active = tx.execution.cycles.activeForWorktree(workspaceId, worktree.id);
        const adopts = mergeAdoptsChecks(active && heldStop(active));
        try {
          requireTreeScope(tx, worktree, 'merge');
          const run = runs.find((r) => r.id === gate.reviewRunId);
          try {
            if (run) this.runtimeEvidence.assertMergeRun(worktree, run.id, tx);
          } catch (error) {
            if (!adopts || !(error instanceof CheckDefinitionChangedError)) throw error;
          }
          if (!run || scopedReviewIssue(tx, worktree, latestReviewReport(tx.execution, run)))
            throw new Error('Scoped review required');
        } catch {
          mergeGates[worktree.id] = { mergeable: false, reason: 'scope-blocked' };
          continue;
        }
        if (adopts) mergeGates[worktree.id] = { ...gate, reason: 'check-adoption' };
      } else if (!worktree.executionScope && gate?.mergeable && gate.reviewRunId) {
        // A check-only review (R-G13 increment 4), or one with no record in a repository with
        // adopted checks (operator decision 2026-10-07), is gated on them: the listing says so
        // rather than offering a merge the gate refuses.
        const env = tx.runtimeEvidence.run(workspaceId, gate.reviewRunId);
        if (!env || env.runtimeId === undefined)
          try {
            this.runtimeEvidence.assertMergeRun(worktree, gate.reviewRunId, tx);
          } catch {
            mergeGates[worktree.id] = { mergeable: false, reason: 'scope-blocked' };
          }
      }
    }
    return { worktrees, runs, mergeGates };
  }

  /**
   * Closes each mergeable gate whose reviewed branches have moved since the review (Git), and
   * says on each that stays open whether its target is the primary checkout's (R-G10 D3).
   */
  async confirmGates(read: WorkItemExecution): Promise<WorkItemExecution> {
    const mergeGates = { ...read.mergeGates };
    const checkout = checkedOutBranches(this.git);
    for (const worktree of read.worktrees) {
      const gate = mergeGates[worktree.id];
      if (!gate?.mergeable || gate.reason === 'merge-recovery-required') continue;
      try {
        await this.branches.assertReview(
          worktree,
          read.runs.find((run) => run.id === gate.reviewRunId),
        );
      } catch {
        mergeGates[worktree.id] = { ...gate, mergeable: false, reason: 'branch-review-required' };
        continue;
      }
      const root = this.storage.execution.sourceRepositories.find(
        worktree.workspaceId,
        worktree.repositoryId,
      )?.rootPath;
      const branch = root === undefined ? undefined : await checkout.branch(root);
      if (branch) mergeGates[worktree.id] = { ...gate, checkedOutBranch: branch };
    }
    return { ...read, mergeGates };
  }

  /** Live runs first, then recent ones, with the context to list them anywhere. */
  listRuns(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
    filter: { readonly live?: boolean } = {},
  ) {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => {
      // Live runs sort first, so filtering the recent page keeps every live run it can hold.
      const recent = tx.execution.runs.listRecent(workspaceId, 50);
      const runs = filter.live
        ? recent.filter((run) => ['starting', 'running', 'waiting'].includes(run.status))
        : recent;
      const items = runs.flatMap((run) => {
        const item = run.workItemId
          ? tx.planning.workItems.find(workspaceId, run.workItemId)
          : { sourceId: 'Finalization', title: 'Plan conformance, simplification and polish' };
        const project = tx.planning.projects.find(workspaceId, run.projectId);
        const worktree = tx.execution.worktrees.find(workspaceId, run.worktreeId);
        if (item === undefined || project === undefined || worktree === undefined) {
          return [];
        }
        return [
          {
            run,
            workItemSourceId: item.sourceId,
            workItemTitle: item.title,
            projectName: project.name,
            branchName: worktree.branchName,
          },
        ];
      });
      return { runs: items, liveCount: tx.execution.runs.countLive(workspaceId) };
    });
  }

  executionScopes(context: AuthContext, workspaceId: WorkspaceId, workItemId: WorkItemId) {
    this.workspaceService.requireAuthorized(context, workspaceId);
    if (!this.storage.planning.workItems.find(workspaceId, workItemId)) throw new NotFoundError();
    return this.scopesIn(this.storage, workspaceId, workItemId);
  }

  /** A work item's execution slices, read in the caller's transaction (R-D5). */
  scopesIn(tx: StorageRepositories, workspaceId: WorkspaceId, workItemId: WorkItemId) {
    return { choices: scopeChoices(tx, workspaceId, workItemId) };
  }

  authorizeEarlyDevelopment(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    scope: import('@craftingtable/domain').ExecutionScope,
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    this.storage.transaction((tx) => {
      const r = resolveScope(tx, workspaceId, workItemId, scope);
      if (scope.kind !== 'slice' || !r.slice?.early_start_exception || r.slice.decision_refs.length)
        throw new ExecutionRequestError(
          'conflict',
          'This slice has no independently authorizable early-development rule. Scheduling proposals require separate adoption.',
        );
      const settings = tx.execution.branchSettings.find(workspaceId, r.item.planVersionId);
      if (
        settings?.version !== r.binding.branchSettingsVersion ||
        settings?.repositoryId !== r.binding.repositoryId ||
        settings?.integrationBranch !== r.binding.integrationBranch ||
        tx.planning.projects.find(workspaceId, r.item.projectId)?.activePlanVersionId !==
          r.item.planVersionId
      )
        throw new ExecutionRequestError(
          'conflict',
          'The frozen scope binding is no longer current.',
        );
      const key = executionScopeKey(scope);
      if (tx.phaseScheduling.authorized(workspaceId, workItemId, key)) return;
      const at = this.now().toISOString();
      tx.phaseScheduling.authorize(workspaceId, workItemId, key, context.user.id, at);
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: at,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        action: 'scope.scheduling-authorized',
        targetType: 'work-item',
        targetId: workItemId,
        outcome: 'succeeded',
        metadata: { scope: { ...scope } },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        workspaceId,
        occurredAt: at,
        actorUserId: context.user.id,
        kind: 'scope-scheduling-authorized',
        payload: { workItemId, sourceId: scope.sourceId },
      });
    });
    this.notifier.notify();
    return this.executionScopes(context, workspaceId, workItemId);
  }

  /** The merge executor's (R-B7); an `input` left out takes the executor's default. */
  mergeWorktree(
    context: CommandContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    input?: Parameters<MergeExecutor['mergeWorktree']>[3],
    requestId?: string,
    delegation?: Parameters<MergeExecutor['mergeWorktree']>[5],
    finalApproval?: Parameters<MergeExecutor['mergeWorktree']>[6],
  ): ReturnType<MergeExecutor['mergeWorktree']> {
    return this.merges.mergeWorktree(
      context,
      workspaceId,
      worktreeId,
      input,
      requestId,
      delegation,
      finalApproval,
    );
  }
  recordScopeReceipt(
    context: CommandContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    expectedWorktreeVersion: number,
    /** The roadmap's actor, when its scheduler records the receipt (R-B7). */
    delegation?: { readonly actor: RoadmapCheck },
  ) {
    return this.receipts.recordScopeReceipt(
      context,
      workspaceId,
      worktreeId,
      expectedWorktreeVersion,
      delegation,
    );
  }
  async createWorktree(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: {
      readonly repositoryId: SourceRepositoryId;
      readonly branchName?: string;
      readonly executionScope?: import('@craftingtable/domain').ExecutionScope;
    },
    requestId?: string,
    reservation?: { readonly id: WorktreeId; readonly actor: RoadmapCheck },
  ): Promise<Worktree> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    return this.workItemService.duringWorktreeCreation(workItemId, async () => {
      requireScopeOwnership(this.storage, workspaceId, workItemId, input.executionScope);
      const scoped = input.executionScope
        ? requireScope(
            this.storage,
            workspaceId,
            workItemId,
            input.executionScope,
            input.executionScope.kind === 'slice'
              ? 'start'
              : input.executionScope.kind === 'slice-verification'
                ? 'verify'
                : 'accept',
          )
        : undefined;
      if (scoped) {
        const issues = resourceBlockers(
          this.storage,
          scoped,
          input.executionScope?.kind === 'slice'
            ? 'start'
            : input.executionScope?.kind === 'slice-verification'
              ? 'verify'
              : 'accept',
        );
        if (issues.length) throw new PhaseGateError(issues);
      }
      if (scoped && !['admitted', 'completed'].includes(scoped.item.status))
        throw new ExecutionRequestError(
          'conflict',
          'Admit the parent before starting scoped execution.',
        );
      const git = requireGit(this.git);
      const { item, repository } = this.storage.readTransaction((tx) => {
        const found = tx.planning.workItems.find(workspaceId, workItemId);
        const repo = tx.execution.sourceRepositories.find(workspaceId, input.repositoryId);
        if (found === undefined || repo === undefined) {
          throw new NotFoundError();
        }
        return { item: found, repository: repo };
      });
      if (repository.status !== 'active') {
        throw new ExecutionRequestError('conflict', 'Repository is retired');
      }
      reservation?.actor.check();
      const shortId = (reservation?.id ?? randomUUID()).slice(0, 8);
      const branchName =
        input.branchName ??
        `ct/${slug(input.executionScope?.sourceId ?? item.sourceId)}-${shortId}`;
      if (!isValidBranchName(branchName)) {
        throw new ExecutionRequestError('invalid-request', 'Branch name is not well formed');
      }
      const path = join(
        this.config.worktreeRoot,
        slug(repository.displayName, 60),
        `${slug(item.sourceId)}-${shortId}`,
      );

      return this.branches.duringMerge(repository.rootPath, async () => {
        const base = await this.branches.creationBase(
          workspaceId,
          workItemId,
          repository.id,
          input.executionScope,
        );
        reservation?.actor.check();
        if (input.executionScope)
          requireScope(
            this.storage,
            workspaceId,
            workItemId,
            input.executionScope,
            input.executionScope.kind === 'slice'
              ? 'start'
              : input.executionScope.kind === 'slice-verification'
                ? 'verify'
                : 'accept',
          );
        const created = await git.createWorktree({
          repositoryPath: repository.rootPath,
          worktreePath: path,
          branchName,
          baseRef: base.headSha,
        });
        if (!created.ok) {
          throw new ExecutionRequestError(
            'invalid-request',
            `Could not create worktree: ${created.failure.message}${
              created.failure.stderr
                ? ` (${created.failure.stderr.trim().split('\n').at(-1) ?? ''})`
                : ''
            }`,
          );
        }

        const occurredAt = this.now().toISOString();
        const worktree = this.storage.transaction((tx) => {
          const inserted = tx.execution.worktrees.insert({
            id: reservation?.id ?? asWorktreeId(randomUUID()),
            workspaceId,
            repositoryId: repository.id,
            projectId: item.projectId,
            workItemId,
            ...(input.executionScope ? { executionScope: input.executionScope } : {}),
            branchName,
            baseSha: base.headSha,
            baseBranch: base.branch,
            integrationBranch: base.branch,
            path,
            createdAt: occurredAt,
            createdByUserId: context.user.id,
          });
          tx.audit.append({
            id: asAuditEventId(randomUUID()),
            occurredAt,
            actorKind: context.session === undefined ? 'system' : 'user',
            actorUserId: context.user.id,
            ...(context.session === undefined ? {} : { sessionId: context.session.id }),
            workspaceId,
            ...(requestId === undefined ? {} : { requestId }),
            action: 'worktree.create',
            targetType: 'worktree',
            targetId: inserted.id,
            outcome: 'succeeded',
            metadata: {
              workItemId,
              repositoryId: repository.id,
              branchName,
              baseSha: inserted.baseSha,
            },
          });
          tx.workspaceEvents.appendEvent({
            id: asEventId(randomUUID()),
            occurredAt,
            workspaceId,
            actorUserId: context.user.id,
            projectId: item.projectId,
            workItemId,
            kind: 'worktree-created',
            payload: {
              worktreeId: inserted.id,
              sourceRepositoryId: repository.id,
              workItemId,
              branchName,
              baseSha: inserted.baseSha,
            },
          });
          return inserted;
        });
        this.notifier.notify();
        return worktree;
      });
    });
  }

  async createFinalizationWorktree(
    context: CommandContext,
    value: import('@craftingtable/domain').Finalization,
    check: () => void,
    recoverOnly = false,
  ): Promise<Worktree | undefined> {
    return this.createPlanWorktree(context, value, check, 'finalization', recoverOnly);
  }

  async createDecisionWorktree(
    context: CommandContext,
    value: import('@craftingtable/domain').DecisionPreparation,
    actor: RoadmapCheck,
  ): Promise<Worktree> {
    return required(
      await this.createPlanWorktree(
        context,
        { ...value, targetBranch: value.integrationBranch },
        () => actor.check(),
        'decision',
      ),
      'the decision worktree',
    );
  }

  private async createPlanWorktree(
    context: CommandContext,
    /** A finalization's, or a decision preparation's: its id names the worktree's path and branch. */
    value: { readonly id: FinalizationId | DecisionPreparationId } & Pick<
      import('@craftingtable/domain').Finalization,
      | 'workspaceId'
      | 'repositoryId'
      | 'worktreeId'
      | 'projectId'
      | 'planVersionId'
      | 'integrationSha'
      | 'integrationBranch'
      | 'targetBranch'
    >,
    check: () => void,
    purpose: 'finalization' | 'decision',
    recoverOnly = false,
  ): Promise<Worktree | undefined> {
    this.workspaceService.requireRole(context, value.workspaceId, ['owner', 'editor']);
    const existing = this.storage.execution.worktrees.find(value.workspaceId, value.worktreeId);
    if (existing) return existing;
    const repository = this.storage.execution.sourceRepositories.find(
      value.workspaceId,
      value.repositoryId,
    );
    if (!repository) throw new NotFoundError();
    return this.branches.duringMerge(repository.rootPath, async () => {
      check();
      const path = join(
        this.config.worktreeRoot,
        purpose === 'decision' ? 'decisions' : 'finalizations',
        value.id,
      );
      const branchName = `ct/${purpose === 'decision' ? 'decision' : 'finalize'}-${value.id}`;
      if (recoverOnly && !existsSync(path)) return undefined;
      const result = await requireGit(this.git).createWorktree({
        recoverExisting: true,
        repositoryPath: repository.rootPath,
        worktreePath: path,
        branchName,
        baseRef: value.integrationSha,
      });
      if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
      // Preserve a worktree created during a stop/restart gap; no agent launches here.
      const tree = this.storage.transaction((tx) => {
        const inserted = tx.execution.worktrees.insert({
          id: value.worktreeId,
          workspaceId: value.workspaceId,
          repositoryId: value.repositoryId,
          projectId: value.projectId,
          planVersionId: value.planVersionId,
          branchName,
          baseSha: value.integrationSha,
          baseBranch: value.integrationBranch,
          integrationBranch: value.targetBranch,
          path,
          createdAt: this.now().toISOString(),
          createdByUserId: context.user.id,
        });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt: this.now().toISOString(),
          workspaceId: value.workspaceId,
          actorKind: context.session ? 'user' : 'system',
          actorUserId: context.user.id,
          ...(context.session ? { sessionId: context.session.id } : {}),
          action: 'worktree.create',
          targetType: 'worktree',
          targetId: inserted.id,
          outcome: 'succeeded',
          metadata: {
            purpose,
            ...(purpose === 'decision'
              ? { preparationId: value.id }
              : { finalizationId: value.id }),
            planVersionId: value.planVersionId,
            branchName,
          },
        });
        return inserted;
      });
      this.notifier.notify();
      return tree;
    });
  }

  async removeWorktree(
    context: AuthContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    requestId?: string,
    options: { readonly discardChanges?: boolean } = {},
  ): Promise<{ readonly worktree: Worktree; readonly changed: boolean }> {
    if (this.storage.execution.merges.latest(workspaceId, worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError(
        'conflict',
        'Recover the reserved integration merge before removing the worktree',
      );
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (this.storage.execution.worktrees.find(workspaceId, worktreeId) === undefined)
      throw new NotFoundError();
    return this.mutations.during(worktreeId, 'removal', async () => {
      const { worktree, repository, liveRuns } = this.storage.readTransaction((tx) => {
        const found = tx.execution.worktrees.find(workspaceId, worktreeId);
        if (found === undefined) {
          throw new NotFoundError();
        }
        const repo = tx.execution.sourceRepositories.find(workspaceId, found.repositoryId);
        if (repo === undefined) {
          throw new NotFoundError();
        }
        return {
          worktree: found,
          repository: repo,
          liveRuns: tx.execution.runs.liveForWorktree(workspaceId, worktreeId),
        };
      });
      if (worktree.status === 'removed') {
        return { worktree, changed: false };
      }
      if (this.storage.execution.cycles.activeForWorktree(workspaceId, worktreeId) !== undefined) {
        throw new ExecutionRequestError(
          'conflict',
          'Stop the automated cycle before removing its worktree',
        );
      }
      if (liveRuns.length > 0) {
        throw new ExecutionRequestError('conflict', 'A run is still live in this worktree');
      }
      return this.branches.duringMerge(repository.rootPath, async () => {
        // Only an explicit operator choice discards uncommitted or untracked work.
        const removed = await requireGit(this.git).removeWorktree({
          repositoryPath: repository.rootPath,
          worktreePath: worktree.path,
          force: options.discardChanges === true,
        });
        if (!removed.ok && removed.failure.kind === 'worktree-dirty') {
          throw new ExecutionRequestError(
            'conflict',
            `${removed.failure.message}. Commit them, or remove the worktree again choosing to discard them.`,
            {
              reason: 'worktree-has-changes',
              paths: removed.failure.changedPaths ?? [],
              ...(removed.failure.changedPathCount === undefined
                ? {}
                : { pathCount: removed.failure.changedPathCount }),
            },
          );
        }
        if (!removed.ok) {
          throw new ExecutionRequestError(
            'invalid-request',
            `Could not remove worktree: ${removed.failure.message}`,
          );
        }
        const occurredAt = this.now().toISOString();
        const result = this.storage.transaction((tx) => {
          const marked = tx.execution.worktrees.markRemoved({
            workspaceId,
            worktreeId,
            occurredAt,
          });
          if (marked === undefined) {
            const current = tx.execution.worktrees.find(workspaceId, worktreeId);
            if (current === undefined) throw new NotFoundError();
            return { worktree: current, changed: false };
          }
          tx.audit.append({
            id: asAuditEventId(randomUUID()),
            occurredAt,
            actorKind: 'user',
            actorUserId: context.user.id,
            sessionId: context.session.id,
            workspaceId,
            ...(requestId === undefined ? {} : { requestId }),
            action: 'worktree.remove',
            targetType: 'worktree',
            targetId: worktreeId,
            outcome: 'succeeded',
            priorVersion: worktree.version,
            resultingVersion: marked.version,
            metadata: {
              branchName: worktree.branchName,
              ...(options.discardChanges === true ? { discardChanges: true } : {}),
            },
          });
          tx.workspaceEvents.appendEvent({
            id: asEventId(randomUUID()),
            occurredAt,
            workspaceId,
            actorUserId: context.user.id,
            projectId: worktree.projectId,
            workItemId: worktree.workItemId,
            kind: 'worktree-removed',
            payload: {
              worktreeId,
              ...(worktree.workItemId
                ? { workItemId: worktree.workItemId }
                : { planVersionId: worktree.planVersionId }),
              branchName: worktree.branchName,
            },
          });
          return { worktree: marked, changed: true };
        });
        if (result.changed) {
          this.notifier.notify();
        }
        return result;
      });
    });
  }

  /**
   * Removes a decision preparation's worktree once its decision is accepted (LIVE-16). The
   * daemon's own act: the preparation is read-only, its brief lives on its run, and nothing of
   * the worktree is needed any more. A worktree with a live run, or with changes, is left alone
   * (it holds no slice capacity either way); `true` when it was removed.
   */
  async releaseDecisionWorktree(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    preparationId: DecisionPreparationId,
  ): Promise<boolean> {
    return this.mutations.during(worktreeId, 'decision-release', async () => {
      const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
      if (worktree?.status !== 'active') return false;
      const repository = this.storage.execution.sourceRepositories.find(
        workspaceId,
        worktree.repositoryId,
      );
      if (
        !repository ||
        this.storage.execution.runs.liveForWorktree(workspaceId, worktreeId).length > 0
      )
        return false;
      return this.branches.duringMerge(repository.rootPath, async () => {
        const removed = await requireGit(this.git).removeWorktree({
          repositoryPath: repository.rootPath,
          worktreePath: worktree.path,
          force: false,
        });
        if (!removed.ok) return false;
        const occurredAt = this.now().toISOString();
        const changed = this.storage.transaction((tx) => {
          const marked = tx.execution.worktrees.markRemoved({
            workspaceId,
            worktreeId,
            occurredAt,
          });
          if (!marked) return false;
          tx.audit.append({
            id: asAuditEventId(randomUUID()),
            occurredAt,
            actorKind: 'system',
            workspaceId,
            action: 'worktree.remove',
            targetType: 'worktree',
            targetId: worktreeId,
            outcome: 'succeeded',
            priorVersion: worktree.version,
            resultingVersion: marked.version,
            metadata: {
              branchName: worktree.branchName,
              reason: 'decision-accepted',
              preparationId,
            },
          });
          tx.workspaceEvents.appendEvent({
            id: asEventId(randomUUID()),
            occurredAt,
            workspaceId,
            projectId: worktree.projectId,
            workItemId: worktree.workItemId,
            kind: 'worktree-removed',
            payload: {
              worktreeId,
              planVersionId: worktree.planVersionId,
              branchName: worktree.branchName,
            },
          });
          return true;
        });
        if (changed) this.notifier.notify();
        return changed;
      });
    });
  }

  async worktreeDiff(
    context: AuthContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    requestId?: string,
  ): Promise<{ readonly worktree: Worktree; readonly diff: WorktreeDiff }> {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
    if (worktree === undefined) {
      throw new NotFoundError();
    }
    if (worktree.status !== 'active') {
      throw new ExecutionRequestError('conflict', 'Worktree has been removed');
    }
    const git = requireGit(this.git);
    let baseSha = worktree.baseSha;
    if (worktree.integrationBranch !== undefined) {
      const repository = this.storage.execution.sourceRepositories.find(
        workspaceId,
        worktree.repositoryId,
      );
      if (repository === undefined) throw new NotFoundError();
      const target = await git.resolveBranch(repository.rootPath, worktree.integrationBranch);
      const state = await git.inspectRepository(worktree.path);
      if (!target.ok || !state.ok)
        throw new ExecutionRequestError(
          'unavailable',
          'The integration branch or worktree is unavailable',
        );
      const base = await git.commonAncestor(repository.rootPath, target.value, state.value.headSha);
      if (!base.ok) throw new ExecutionRequestError('conflict', base.failure.message);
      baseSha = base.value;
    }
    const diff = await git.worktreeDiff({
      worktreePath: worktree.path,
      baseSha,
      maxPatchBytes: this.config.maxPatchBytes,
    });
    if (!diff.ok) {
      throw new ExecutionRequestError(
        'unavailable',
        `Could not compute diff: ${diff.failure.message}`,
      );
    }
    return { worktree, diff: diff.value };
  }
}
