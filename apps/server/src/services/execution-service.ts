import {
  type CheckDeclarationProposal,
  type MergeAdoption,
  definitionChangeReason,
  proposalDigest,
  type RepositoryChecksService,
} from './repository-checks-service.js';

/** A merge's adoption of changed check definitions, approved by the operator (R-G13). */
interface CheckAdoptionAtMerge {
  readonly merge: MergeAdoption & {
    readonly proposal: CheckDeclarationProposal;
    readonly proposalDigest: string;
  };
  readonly rationale: string;
  /** The adoption the definitions were compared with; a later one refuses this adoption. */
  readonly declarationId: string;
}
import { securityReviewCurrent } from './workflow-policy.js';
import { asAgentRunId } from '@craftingtable/domain';
import { needsNativeVerification } from './native-verification-policy.js';
import { scopeReviewerRoles } from './map-adoption-policy.js';
import { acceptedEvidence } from './runtime-evidence-policy.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { resourceBlockers, withPhaseReservation, PhaseGateError } from './phase-resources.js';
import { executionScopeKey } from '@craftingtable/domain';
import {
  requireScope,
  resolveScope,
  requireScopeOwnership,
  requireTreeScope,
  scopeChoices,
  scopedReviewIssue,
  scopeEvidenceIssues,
  latestSliceMerge,
} from './execution-scope.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentRun,
  type AgentRunId,
  asAuditEventId,
  asEventId,
  asSourceRepositoryId,
  asWorktreeId,
  evaluateCycleCompletion,
  isTerminalAgentRunStatus,
  mergeAdoptsChecks,
  type MergeOperation,
  type RepositoryCheckDeclaration,
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
import {
  CheckAdoptionRequiredError,
  CheckDefinitionChangedError,
  ExecutionRequestError,
  NotFoundError,
} from './errors.js';
import { stagedPromotionIssue } from './finalization-stage-policy.js';
import { latestReviewReport } from './run-handoff.js';
import type { WorkItemService } from './work-item-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationGuard } from './worktree-mutation-guard.js';

export type MergeGateReason =
  | 'ready'
  | 'no-review'
  | 'changes-requested'
  | 'automation-active'
  | 'review-pending'
  | 'superseded-by-later-run'
  | 'run-live'
  | 'worktree-removed'
  | 'branch-review-required'
  | 'merge-recovery-required'
  | 'scope-blocked'
  | 'scope-review-only'
  /** Mergeable by a person who approves the check definitions it adopts (R-G13). */
  | 'check-adoption';

export interface MergeGate {
  readonly mergeable: boolean;
  readonly reason: MergeGateReason;
  readonly reviewRunId?: AgentRunId;
}

/**
 * The pull-request rule: a worktree may be merged when its most recent run is
 * a review that returned `mergeable` and nothing is live in it. Any later run
 * of any role supersedes the review, because it may have changed the branch.
 */
export function mergeGateFor(worktree: Worktree, runs: readonly AgentRun[]): MergeGate {
  if (worktree.status !== 'active') {
    return { mergeable: false, reason: 'worktree-removed' };
  }
  const forWorktree = runs
    .filter((run) => run.worktreeId === worktree.id)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (forWorktree.some((run) => !isTerminalAgentRunStatus(run.status))) {
    const live = forWorktree.find((run) => !isTerminalAgentRunStatus(run.status));
    return live?.role === 'review' && live.verdict === undefined
      ? { mergeable: false, reason: 'review-pending', reviewRunId: live.id }
      : { mergeable: false, reason: 'run-live' };
  }
  const latest = forWorktree[0];
  const latestReview = forWorktree.find((run) => run.role === 'review');
  if (latestReview === undefined) {
    return { mergeable: false, reason: 'no-review' };
  }
  if (latest !== undefined && latest.id !== latestReview.id) {
    return { mergeable: false, reason: 'superseded-by-later-run', reviewRunId: latestReview.id };
  }
  if (latestReview.status !== 'finished') {
    return { mergeable: false, reason: 'review-pending', reviewRunId: latestReview.id };
  }
  if (
    worktree.integrationBranch === undefined ||
    latestReview.reviewBranchContext?.worktreeVersion !== worktree.version ||
    latestReview.reviewBranchContext.targetBranch !== worktree.integrationBranch
  ) {
    return { mergeable: false, reason: 'branch-review-required', reviewRunId: latestReview.id };
  }
  if (latestReview.verdict === 'mergeable') {
    return { mergeable: true, reason: 'ready', reviewRunId: latestReview.id };
  }
  return {
    mergeable: false,
    reason: latestReview.verdict === 'changes-requested' ? 'changes-requested' : 'review-pending',
    reviewRunId: latestReview.id,
  };
}

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

const MERGE_GATE_MESSAGES: Readonly<Record<MergeGateReason, string>> = {
  'merge-recovery-required': 'Recover the reserved integration merge before continuing',
  'scope-blocked': 'Execution scope requirements or scoped review evidence are unresolved',
  'scope-review-only': 'This worktree records verification or parent acceptance; it does not merge',
  'check-adoption': 'Approve the check definitions this merge adopts, with the merge',
  'branch-review-required': 'Adopt an integration branch if needed and run a fresh review',
  ready: 'Ready to merge',
  'no-review': 'Merging requires a review run with a mergeable verdict; launch a review first',
  'changes-requested': 'The latest review requested changes; address them and review again',
  'automation-active':
    'The automated cycle has not reached merge approval; stop it to use the manual merge flow',
  'review-pending': 'The latest review has not returned a verdict yet',
  'superseded-by-later-run': 'A run started after the last review; review the branch again',
  'run-live': 'A run is still live in this worktree',
  'worktree-removed': 'The worktree has been removed',
};

export interface ExecutionStatus {
  readonly git: { readonly available: boolean; readonly executable?: string };
  readonly backends: readonly {
    readonly kind: import('@craftingtable/domain').AgentBackendKind;
    readonly label: string;
    readonly available: boolean;
    readonly executable?: string;
    readonly models: readonly { readonly id: string; readonly label: string }[];
  }[];
}

/**
 * Repositories, worktrees, and diffs.
 *
 * Git authority stays behind `GitOperations`; this service owns authorization,
 * durable state, audit, and workspace events. Every mutation is one immediate
 * transaction followed by a notifier signal.
 */
export class ExecutionService {
  readonly branches: BranchService;
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly git: GitOperations | undefined,
    private readonly config: ExecutionConfig,
    private readonly workItemService: WorkItemService,
    private readonly now: () => Date = () => new Date(),
    private readonly mutations: WorktreeMutationGuard = new WorktreeMutationGuard(),
    private readonly runtimeEvidence?: RuntimeEvidenceService,
    /** Declared checks (R-G13): what a merge adopts, and why a review's definitions stop it. */
    readonly repositoryChecks?: RepositoryChecksService,
  ) {
    this.branches = new BranchService(storage, workspaceService, notifier, git, mutations, now);
  }

  /**
   * What merging a slice adopts (R-G13 increment 5, operator decision 2026-09-30): nothing
   * when the slice changes no check definition. Otherwise only a person's approval naming the
   * proposal they were shown may merge it, never a roadmap's, and a merge whose result cannot
   * be adopted is refused.
   */
  private async checkAdoption(
    worktree: Worktree,
    review: AgentRun,
    approval:
      | {
          readonly proposalDigest: string;
          readonly rationale: string;
          readonly declarationId: string;
        }
      | undefined,
    delegated: boolean,
  ): Promise<CheckAdoptionAtMerge | undefined> {
    const refuseUnneeded = () => {
      if (approval)
        throw new ExecutionRequestError(
          'conflict',
          'This merge changes no adopted check definition, so it has nothing to adopt. Reload and approve the merge alone.',
        );
      return undefined;
    };
    if (
      worktree.executionScope?.kind !== 'slice' ||
      !review.reviewBranchContext ||
      !this.repositoryChecks ||
      !this.storage.runtimeEvidence.run(worktree.workspaceId, review.id)?.checkDeclarationId
    )
      return refuseUnneeded();
    const diagnosis = await this.repositoryChecks.diagnose(worktree, review.reviewBranchContext);
    const merge = diagnosis?.merge;
    if (!diagnosis || !merge || merge.unchanged) return refuseUnneeded();
    if (merge.issues.length || !merge.proposal || !merge.proposalDigest)
      throw new CheckDefinitionChangedError(
        worktree.repositoryId,
        merge.checks[0]?.id ?? diagnosis.declaration.id,
        definitionChangeReason(diagnosis, true),
      );
    // The gate first, with the definitions the merge would adopt: an unmet gate is reported as
    // itself, not as an adoption to approve (verification of the review fixes).
    this.runtimeEvidence?.assertRun(
      worktree,
      review.id,
      this.storage,
      merge.proposal.definitionDigests,
    );
    if (delegated)
      throw new CheckAdoptionRequiredError(
        worktree.repositoryId,
        merge.proposalDigest,
        'This merge changes adopted check definitions, so a person approves it and the definitions with it.',
      );
    if (approval !== undefined && approval.declarationId !== diagnosis.declaration.id)
      throw new CheckAdoptionRequiredError(
        worktree.repositoryId,
        merge.proposalDigest,
        'The adopted checks changed since you reviewed this merge. Review the definitions again before approving.',
      );
    if (approval?.proposalDigest !== merge.proposalDigest)
      throw new CheckAdoptionRequiredError(
        worktree.repositoryId,
        merge.proposalDigest,
        approval
          ? 'The check definitions this merge adopts changed since they were shown. Review them again before approving.'
          : 'This merge changes adopted check definitions. Review them and approve adopting them with the merge.',
      );
    return {
      merge: { ...merge, proposal: merge.proposal, proposalDigest: merge.proposalDigest },
      rationale: approval.rationale,
      declarationId: diagnosis.declaration.id,
    };
  }

  /**
   * The checks a merge commit proposes, if they are exactly what the operator approved and can
   * be adopted; otherwise why not. Read with the daemon's Git, after the merge.
   */
  private async mergeProposal(
    repository: SourceRepository,
    mergeSha: string,
    approved: string,
  ): Promise<{ proposal?: CheckDeclarationProposal; refused?: string }> {
    if (!this.repositoryChecks)
      return { refused: 'Declared checks are unavailable in this daemon.' };
    try {
      const proposal = await this.repositoryChecks.proposalAt(
        repository,
        mergeSha,
        `merge ${mergeSha.slice(0, 12)}`,
      );
      if (proposal.issues.length) return { refused: proposal.issues.join(' ') };
      if (proposalDigest(proposal) !== approved)
        return { refused: 'The merge commit proposes other checks than the operator approved.' };
      return { proposal };
    } catch (error) {
      return { refused: error instanceof Error ? error.message : 'The merge could not be read.' };
    }
  }

  /**
   * Records the adoption a merge approval carried, at the merge commit, in the merge's own
   * transaction; or, if the merge commit did not propose what was approved, the refusal.
   */
  private recordMergeAdoption(
    tx: StorageRepositories,
    worktree: Worktree,
    merge: MergeOperation & { readonly mergeSha: string },
    adopting: { proposal?: CheckDeclarationProposal; refused?: string },
    at: string,
    /** The adoption the operator's diff was against, when this request read it (review F6). */
    comparedWith?: string,
  ): void {
    const declarations = tx.runtimeEvidence.checkDeclarations(
      worktree.workspaceId,
      worktree.repositoryId,
    );
    if (declarations.some((d) => d.adoptedAtMerge?.operationId === merge.id)) return;
    const outcome =
      comparedWith !== undefined && declarations[0]?.id !== comparedWith
        ? {
            refused:
              'The adopted checks changed while the merge ran, so the diff the operator approved was against an earlier adoption.',
          }
        : adopting;
    const audit = {
      id: asAuditEventId(randomUUID()),
      occurredAt: at,
      actorKind: 'user' as const,
      actorUserId: merge.authorizedByUserId,
      workspaceId: worktree.workspaceId,
      action: 'repository-checks.adopted' as const,
      targetType: 'source-repository',
      targetId: worktree.repositoryId,
    };
    const proposal = outcome.proposal;
    if (!proposal) {
      tx.audit.append({
        ...audit,
        outcome: 'failed',
        metadata: {
          via: 'merge',
          operationId: merge.id,
          mergeSha: merge.mergeSha,
          reason: (outcome.refused ?? 'Not adopted.').slice(0, 1000),
        },
      });
      return;
    }
    const record: RepositoryCheckDeclaration = {
      id: randomUUID(),
      workspaceId: worktree.workspaceId,
      repositoryId: worktree.repositoryId,
      version: (declarations[0]?.version ?? 0) + 1,
      sourceCommit: merge.mergeSha,
      sourcePath: proposal.sourcePath,
      checks: proposal.checks,
      definitionDigests: proposal.definitionDigests,
      rationale: merge.checkAdoption!.rationale,
      adoptedByUserId: merge.authorizedByUserId,
      adoptedAt: at,
      adoptedAtMerge: {
        operationId: merge.id,
        worktreeId: worktree.id,
        reviewRunId: merge.reviewRunId,
      },
    };
    tx.runtimeEvidence.addCheckDeclaration(record);
    tx.audit.append({
      ...audit,
      outcome: 'succeeded',
      metadata: {
        via: 'merge',
        operationId: merge.id,
        declarationId: record.id,
        version: record.version,
        sourceCommit: record.sourceCommit,
        checks: record.checks.map((c) => c.id),
      },
    });
  }

  private requireGit(): GitOperations {
    if (this.git === undefined) {
      throw new ExecutionRequestError(
        'unavailable',
        'No Git executable was found; set CRAFTINGTABLE_GIT_EXECUTABLE or add git to PATH',
      );
    }
    return this.git;
  }

  listRepositories(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
  ): readonly SourceRepository[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.execution.sourceRepositories.list(workspaceId);
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
    const inspection = await this.requireGit().inspectRepository(input.rootPath);
    if (!inspection.ok) {
      throw new ExecutionRequestError('invalid-request', inspection.failure.message);
    }
    const identity = inspection.value;
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
    const listed = await this.requireGit().listBranches(repository.rootPath);
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
  ): Promise<{
    readonly worktrees: readonly (Worktree & { mergeCleanupError?: string })[];
    readonly runs: readonly AgentRun[];
    readonly mergeGates: Readonly<Record<string, MergeGate>>;
  }> {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const result = this.storage.readTransaction((tx) => {
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
      return { worktrees, runs, mergeGates };
    });
    for (const worktree of result.worktrees) {
      const gate = result.mergeGates[worktree.id];
      if (this.storage.execution.merges.latest(workspaceId, worktree.id)?.status === 'reserved') {
        result.mergeGates[worktree.id] = { mergeable: true, reason: 'merge-recovery-required' };
        continue;
      }
      if (worktree.executionScope?.kind && worktree.executionScope.kind !== 'slice') {
        result.mergeGates[worktree.id] = { mergeable: false, reason: 'scope-review-only' };
        continue;
      }
      if (worktree.executionScope && gate?.mergeable) {
        // A slice whose merge adopts changed check definitions is a person's to merge with
        // them (R-G13 increment 5); the merge itself reads the definitions again.
        const adopts = mergeAdoptsChecks(
          this.storage.execution.cycles.activeForWorktree(workspaceId, worktree.id)?.attention,
        );
        try {
          requireTreeScope(this.storage, worktree, 'merge');
          const run = result.runs.find((r) => r.id === gate.reviewRunId);
          try {
            if (run) this.runtimeEvidence?.assertRun(worktree, run.id);
          } catch (error) {
            if (!adopts || !(error instanceof CheckDefinitionChangedError)) throw error;
          }
          if (
            !run ||
            scopedReviewIssue(
              this.storage,
              worktree,
              latestReviewReport(this.storage.execution, run),
            )
          )
            throw new Error('Scoped review required');
        } catch {
          result.mergeGates[worktree.id] = { mergeable: false, reason: 'scope-blocked' };
          continue;
        }
        if (adopts) result.mergeGates[worktree.id] = { ...gate, reason: 'check-adoption' };
      }
      if (!gate?.mergeable) continue;
      try {
        await this.branches.assertReview(
          worktree,
          result.runs.find((run) => run.id === gate.reviewRunId),
        );
      } catch {
        result.mergeGates[worktree.id] = {
          ...gate,
          mergeable: false,
          reason: 'branch-review-required',
        };
      }
    }
    return result;
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
    return { choices: scopeChoices(this.storage, workspaceId, workItemId) };
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

  async recordScopeReceipt(
    context: CommandContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    expectedWorktreeVersion: number,
    delegation?: { check: () => void },
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    return this.mutations.during(worktreeId, async () => {
      const tree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
      if (!tree?.workItemId || !tree.executionScope) throw new NotFoundError();
      delegation?.check();
      if (this.storage.amendments.retired(workspaceId, worktreeId))
        throw new ExecutionRequestError(
          'conflict',
          'This review worktree was retired by a reviewed amendment.',
        );
      const workItemId = tree.workItemId,
        scope = tree.executionScope;
      const repo = this.storage.execution.sourceRepositories.find(workspaceId, tree.repositoryId);
      if (!repo) throw new NotFoundError();
      const parent = scope.kind === 'parent-acceptance';
      const phase = parent ? 'accept' : 'verify';
      if (tree.version !== expectedWorktreeVersion)
        throw new ExecutionRequestError(
          'conflict',
          'The worktree changed. Refresh before recording scope evidence.',
        );
      const normalized = {
        ...scope,
        kind: parent ? ('parent-acceptance' as const) : ('slice' as const),
      };
      const run = this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0];
      const prior = this.storage.scopeReceipts
        .list(workspaceId, workItemId)
        .find((r) => r.worktreeId === worktreeId && r.reviewRunId === run?.id);
      if (prior) return { recorded: false, workItemCompleted: parent };
      const resolved = requireScope(this.storage, workspaceId, workItemId, scope, phase);
      if (scope.kind === 'slice' && needsNativeVerification(resolved.definition, scope))
        throw new ExecutionRequestError(
          'conflict',
          'Create a fresh slice-verification review to collect approved native evidence after integration.',
        );
      return withPhaseReservation(this.storage, resolved, tree, phase, () =>
        this.branches.duringMerge(repo.rootPath, async () => {
          const git = this.requireGit();
          requireScope(this.storage, workspaceId, workItemId, scope, phase);
          if (
            tree.integrationBranch !== resolved.binding.integrationBranch ||
            tree.repositoryId !== resolved.binding.repositoryId
          )
            throw new ExecutionRequestError(
              'conflict',
              'The worktree differs from its frozen scope binding.',
            );
          await this.runtimeEvidence?.assertFreshTree(tree, phase);
          if (run) this.runtimeEvidence?.assertRun(tree, run.id);
          const report = run && latestReviewReport(this.storage.execution, run);
          const turn =
            run &&
            this.storage.execution.runEvents.latestOfKind(workspaceId, run.id, 'turn-completed');
          if (
            run?.role !== 'review' ||
            run.status !== 'finished' ||
            turn?.kind !== 'turn-completed' ||
            turn.payload.outcome !== 'success' ||
            turn.payload.truncated ||
            report?.status !== 'complete' ||
            report.report.verdict !== 'mergeable' ||
            !report.report.exitGate.met ||
            report.report.findings.some((f) => f.status === 'open' && f.severity !== 'nit')
          )
            throw new ExecutionRequestError(
              'conflict',
              'A finished, successful independent review with no open blocking, major or minor findings is required.',
            );
          const reviewerRoles = scopeReviewerRoles(this.storage, workspaceId, scope, run.id);
          if (
            !resolved.profile.reviewer_roles.every((role) => reviewerRoles.includes(role)) &&
            !(
              resolved.profile.reviewer_roles.length === 1 &&
              ['review', 'independent-reviewer'].includes(resolved.profile.reviewer_roles[0] ?? '')
            ) &&
            !acceptedEvidence(
              this.storage,
              workspaceId,
              scope.definitionId,
              scope.bindingRevision,
              { kind: parent ? 'parent' : 'slice', sourceId: scope.sourceId },
            )
          )
            throw new ExecutionRequestError(
              'conflict',
              'This exact review run lacks the explicitly assigned independent reviewer roles.',
            );
          const evidence = report.report.scopeEvidence;
          const issues = scopeEvidenceIssues(resolved, evidence);
          if (issues.length || !evidence)
            throw new ExecutionRequestError(
              'conflict',
              issues.join(' ') || 'Missing scope evidence.',
            );
          const head = await git.resolveBranch(
            repo.rootPath,
            resolved.binding.integrationBranch ?? '',
          );
          if (!head.ok) throw new ExecutionRequestError('conflict', head.failure.message);
          let mergeSha = head.value;
          if (scope.kind === 'slice') {
            const merge = this.storage.execution.merges.latest(workspaceId, worktreeId);
            if (
              !tree.mergeSha ||
              tree.mergeSha !== head.value ||
              !merge ||
              merge.reviewRunId !== run.id ||
              merge.sourceSha !== run.reviewBranchContext?.headSha ||
              merge.targetSha !== run.reviewBranchContext?.targetSha
            )
              throw new ExecutionRequestError(
                'conflict',
                'Merge this reviewed slice first. If integration has advanced, create a fresh slice verification worktree.',
              );
            mergeSha = tree.mergeSha;
          } else {
            if (tree.status !== 'active')
              throw new ExecutionRequestError(
                'conflict',
                'The review worktree is no longer active.',
              );
            const reviewed = await this.branches.assertReview(tree, run);
            if (reviewed.headSha !== head.value || reviewed.targetSha !== head.value)
              throw new ExecutionRequestError(
                'conflict',
                'Acceptance and verification reviews must inspect the unchanged current integration snapshot.',
              );
            if (!parent) {
              const merged = latestSliceMerge(this.storage, workspaceId, workItemId, scope);
              if (!merged?.mergeSha)
                throw new ExecutionRequestError('conflict', 'The slice has not merged.');
              const ancestor = await git.isAncestor(repo.rootPath, merged.mergeSha, head.value);
              if (!ancestor.ok || !ancestor.value)
                throw new ExecutionRequestError(
                  'conflict',
                  'The slice merge is absent from integration.',
                );
              mergeSha = merged.mergeSha;
            }
          }
          if (parent) {
            for (const sourceId of resolved.parent.required_slices) {
              const merged = latestSliceMerge(this.storage, workspaceId, workItemId, {
                ...scope,
                kind: 'slice',
                sourceId,
              });
              const ancestor =
                merged?.mergeSha &&
                (await git.isAncestor(repo.rootPath, merged.mergeSha, head.value));
              if (typeof ancestor !== 'object' || !ancestor.ok || !ancestor.value)
                throw new ExecutionRequestError(
                  'conflict',
                  `Required slice ${sourceId} is absent from the reviewed integration snapshot.`,
                );
            }
          }
          // Recheck authority and gates after asynchronous Git inspection, before committing evidence.
          this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
          requireScope(this.storage, workspaceId, workItemId, scope, phase);
          if (
            this.storage.execution.worktrees.find(workspaceId, worktreeId)?.version !==
              expectedWorktreeVersion ||
            this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0]?.id !== run.id
          )
            throw new ExecutionRequestError(
              'conflict',
              'The execution changed while recording evidence. Refresh and try again.',
            );
          delegation?.check();
          const at = this.now().toISOString();
          const result = this.storage.transaction((tx) => {
            tx.scopeReceipts.add({
              id: randomUUID(),
              workspaceId,
              workItemId,
              scope: normalized,
              worktreeId,
              reviewRunId: run.id,
              reviewerRoles,
              headSha: run.reviewBranchContext?.headSha ?? head.value,
              integrationSha: mergeSha,
              evidence,
              recordedAt: at,
              recordedByUserId: context.user.id,
            });
            const completion = parent
              ? this.workItemService.completeWithin(tx, {
                  context,
                  workspaceId,
                  workItemId,
                  occurredAt: at,
                  worktreeId,
                  mergeSha: head.value,
                })
              : { completed: false };
            tx.audit.append({
              id: asAuditEventId(randomUUID()),
              workspaceId,
              occurredAt: at,
              actorKind: delegation ? 'system' : 'user',
              actorUserId: context.user.id,
              ...(context.session ? { sessionId: context.session.id } : {}),
              action: 'scope.evidence-recorded',
              targetType: 'worktree',
              targetId: worktreeId,
              outcome: 'succeeded',
              metadata: {
                operation: parent ? 'parent-accepted' : 'slice-verified',
                sourceId: scope.sourceId,
                definitionId: scope.definitionId,
                bindingRevision: scope.bindingRevision,
                reviewRunId: run.id,
              },
            });
            tx.workspaceEvents.appendEvent({
              id: asEventId(randomUUID()),
              workspaceId,
              occurredAt: at,
              actorUserId: context.user.id,
              kind: 'scope-evidence-recorded',
              payload: { workItemId, worktreeId, sourceId: scope.sourceId, parentAccepted: parent },
            });
            return { recorded: true, workItemCompleted: completion.completed };
          });
          this.notifier.notify();
          return result;
        }),
      );
    });
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
    reservation?: { readonly id: WorktreeId; readonly check: () => void },
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
      const git = this.requireGit();
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
      reservation?.check();
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
        reservation?.check();
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
    check: () => void,
  ): Promise<Worktree> {
    return (await this.createPlanWorktree(
      context,
      { ...value, targetBranch: value.integrationBranch },
      check,
      'decision',
    ))!;
  }

  private async createPlanWorktree(
    context: CommandContext,
    value: Pick<
      import('@craftingtable/domain').Finalization,
      | 'id'
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
      const result = await this.requireGit().createWorktree({
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
    return this.mutations.during(worktreeId, async () => {
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
          liveRuns: tx.execution.runs
            .listForWorktree(workspaceId, worktreeId)
            .filter((run) => !isTerminalAgentRunStatus(run.status)),
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
        const removed = await this.requireGit().removeWorktree({
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
    preparationId: string,
  ): Promise<boolean> {
    return this.mutations.during(worktreeId, async () => {
      const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
      if (worktree?.status !== 'active') return false;
      const repository = this.storage.execution.sourceRepositories.find(
        workspaceId,
        worktree.repositoryId,
      );
      if (
        !repository ||
        this.storage.execution.runs
          .listForWorktree(workspaceId, worktreeId)
          .some((run) => !isTerminalAgentRunStatus(run.status))
      )
        return false;
      return this.branches.duringMerge(repository.rootPath, async () => {
        const removed = await this.requireGit().removeWorktree({
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

  /**
   * Merges a reviewed worktree branch into the repository's default branch,
   * removes the worktree, and completes the work item, in that order.
   *
   * Git work happens before the transaction because it cannot be rolled back
   * by SQLite; the durable records are then written together. A failure
   * between the merge and the record leaves the merge in the primary
   * checkout and the worktree active, which the next attempt reports
   * honestly rather than repeating the merge.
   */
  async mergeWorktree(
    context: CommandContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    input: {
      readonly targetBranch?: string;
      readonly adoptChecks?: {
        readonly proposalDigest: string;
        readonly rationale: string;
        readonly declarationId: string;
      };
    } = {},
    requestId?: string,
    delegation?: { roadmapId: string; definitionRevision: number; check: () => void },
    finalApproval?: {
      finalizationId: string;
      expectedHeadSha: string;
      expectedTargetSha: string;
      removeIntegrationBranch?: boolean;
    },
  ): Promise<{
    readonly worktree: Worktree;
    readonly mergeSha: string;
    readonly targetBranch: string;
    readonly createdTarget: boolean;
    readonly workItemCompleted: boolean;
  }> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    return this.mutations.during(worktreeId, async () => {
      const git = this.requireGit();
      const worktree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
      const repository =
        worktree &&
        this.storage.execution.sourceRepositories.find(workspaceId, worktree.repositoryId);
      const item = worktree?.workItemId
        ? this.storage.planning.workItems.find(workspaceId, worktree.workItemId)
        : { sourceId: 'Finalization', title: 'Plan finalization', status: 'completed' };
      if (!worktree || !repository || !item) throw new NotFoundError();
      if (
        this.storage.roadmaps
          .list(workspaceId)
          .some((r) => r.decisionPreparations?.some((p) => p.worktreeId === worktreeId))
      )
        throw new ExecutionRequestError(
          'conflict',
          'Decision preparation worktrees cannot be merged. Approve the decision separately.',
        );
      const pending = this.storage.execution.merges.latest(workspaceId, worktreeId);
      const recovering = pending && ['reserved', 'merged', 'cleaned'].includes(pending.status);
      if (!recovering) requireTreeScope(this.storage, worktree, 'merge');
      const resolved =
        !['merged', 'cleaned'].includes(pending?.status ?? '') &&
        worktree.executionScope &&
        worktree.workItemId
          ? resolveScope(this.storage, workspaceId, worktree.workItemId, worktree.executionScope)
          : undefined;
      return withPhaseReservation(this.storage, resolved, worktree, 'merge', () =>
        this.branches.duringMerge(repository.rootPath, async () => {
          // Check definitions this merge adopts, with the operator's approval (R-G13 increment 5).
          let adoption: CheckAdoptionAtMerge | undefined;
          const check = () => {
            this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
            delegation?.check();
            const review = this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0];
            if (review)
              this.runtimeEvidence?.assertRun(
                worktree,
                review.id,
                this.storage,
                adoption?.merge.proposal.definitionDigests,
              );
            requireTreeScope(this.storage, worktree, 'merge');
            this.branches.requirePolicyMergeTarget(
              workspaceId,
              repository.id,
              worktree.integrationBranch ?? '',
              !!finalApproval,
            );
            this.branches.requireIntegrationAvailable(
              repository.rootPath,
              worktree.integrationBranch ?? '',
            );
            if (delegation)
              this.branches.requireAutomaticMergeTarget(
                workspaceId,
                repository.id,
                worktree.integrationBranch ?? '',
              );
          };
          if (!recovering) {
            await this.runtimeEvidence?.assertFreshTree(worktree, 'merge');
            const review = this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0];
            adoption = review
              ? await this.checkAdoption(worktree, review, input.adoptChecks, !!delegation)
              : undefined;
            if (review)
              this.runtimeEvidence?.assertRun(
                worktree,
                review.id,
                this.storage,
                adoption?.merge.proposal.definitionDigests,
              );
          }
          let operation = this.storage.execution.merges.latest(workspaceId, worktreeId);
          let mergeSha =
            operation?.status === 'merged' || operation?.status === 'cleaned'
              ? operation.mergeSha
              : undefined;
          if (operation?.status === 'reserved') {
            const recovered = await git.inspectMergeOperation({
              repositoryPath: repository.rootPath,
              ...operation,
            });
            if (!recovered.ok)
              throw new ExecutionRequestError('conflict', recovered.failure.message);
            mergeSha = recovered.value;
            if (!mergeSha) {
              await this.recoverMergeScratch(repository, operation);
              // No reserved commit exists. Ordinary freshness/authority checks must pass again.
              const failed = { ...operation, status: 'failed' as const };
              this.storage.transaction((tx) => tx.execution.merges.save(failed));
              operation = undefined;
            }
          }
          if (!mergeSha) {
            // A reservation that left no merge is a fresh attempt: read the definitions now.
            if (recovering) {
              const review = this.storage.execution.runs.listForWorktree(
                workspaceId,
                worktreeId,
              )[0];
              adoption = review
                ? await this.checkAdoption(worktree, review, input.adoptChecks, !!delegation)
                : undefined;
            }
            check();
            if (worktree.planVersionId && (!finalApproval || !context.session || delegation))
              throw new ExecutionRequestError(
                'conflict',
                'Plan promotion requires explicit approval from the finalization page',
              );
            const finalization =
              finalApproval &&
              this.storage.execution.finalizations.find(workspaceId, finalApproval.finalizationId);
            if (finalApproval) {
              const cycle =
                finalization &&
                this.storage.execution.cycles.find(workspaceId, finalization.cycleId);
              if (
                finalization?.status !== 'active' ||
                finalization.worktreeId !== worktreeId ||
                cycle?.polishPhase !== 'final-review' ||
                cycle.status !== 'awaiting-merge'
              )
                throw new ExecutionRequestError(
                  'conflict',
                  'Final independent review is not ready for promotion',
                );
              const finalRun = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
              const stageIssue = stagedPromotionIssue(
                finalization,
                cycle,
                finalRun && latestReviewReport(this.storage.execution, finalRun),
                finalRun?.reviewBranchContext,
              );
              if (stageIssue) throw new ExecutionRequestError('conflict', stageIssue);
              const integration = await git.resolveBranch(
                repository.rootPath,
                finalization.integrationBranch,
              );
              if (!integration.ok || integration.value !== finalization.integrationSha)
                throw new ExecutionRequestError(
                  'conflict',
                  'Integration changed after finalization began. Stop and start a new finalization for the new snapshot.',
                );
            }
            const gate = mergeGateFor(
              worktree,
              this.storage.execution.runs.listForWorktree(workspaceId, worktreeId),
            );
            if (!gate.mergeable || !gate.reviewRunId)
              throw new ExecutionRequestError('conflict', MERGE_GATE_MESSAGES[gate.reason]);
            const state = await git.inspectRepository(worktree.path);
            if (!state.ok || !state.value.clean || state.value.branch !== worktree.branchName)
              throw new ExecutionRequestError(
                'conflict',
                'Merge requires a clean worktree on its managed branch; resolve any uncommitted changes',
              );
            const cycle = this.storage.execution.cycles.activeForWorktree(workspaceId, worktreeId);
            if (
              cycle &&
              (cycle.status !== 'awaiting-merge' ||
                cycle.currentRunId !== gate.reviewRunId ||
                cycle.reviewHeadSha !== state.value.headSha)
            )
              throw new ExecutionRequestError(
                'conflict',
                'Automation has not approved this reviewed commit. Resume for a fresh review, or stop the cycle to use the manual merge flow.',
              );
            const review = this.storage.execution.runs.find(workspaceId, gate.reviewRunId);
            const reviewed = await this.branches.assertReview(worktree, review);
            const securityCycle = this.storage.execution.cycles
              .listForWorkspace(workspaceId)
              .find((c) => c.worktreeId === worktree.id && c.workflow?.securityRequired);
            if (securityCycle) {
              const receipt = securityCycle.workflow?.securityReceipt;
              const security =
                receipt &&
                this.storage.execution.runs.find(workspaceId, asAgentRunId(receipt.runId));
              if (
                !review ||
                !security ||
                !securityReviewCurrent(this.storage, securityCycle, review)
              )
                throw new ExecutionRequestError(
                  'conflict',
                  'The required separate security review must pass on this exact candidate and integration target before merge.',
                );
              await this.branches.assertReview(worktree, security);
            }

            if (
              worktree.executionScope &&
              (!review ||
                scopedReviewIssue(
                  this.storage,
                  worktree,
                  latestReviewReport(this.storage.execution, review),
                ))
            )
              throw new ExecutionRequestError(
                'conflict',
                'A complete review of this exact execution scope is required before merging.',
              );
            if (
              finalApproval &&
              cycle &&
              evaluateCycleCompletion(
                cycle,
                review ? latestReviewReport(this.storage.execution, review) : undefined,
                reviewed,
              ).action !== 'awaiting-merge'
            )
              throw new ExecutionRequestError(
                'conflict',
                'The current final review does not meet the completion policy.',
              );
            if (input.targetBranch !== undefined && input.targetBranch !== reviewed.targetBranch)
              throw new ExecutionRequestError(
                'conflict',
                'Retarget the worktree explicitly and review again before merging elsewhere',
              );
            if (
              finalApproval &&
              (reviewed.headSha !== finalApproval.expectedHeadSha ||
                reviewed.targetSha !== finalApproval.expectedTargetSha)
            )
              throw new ExecutionRequestError(
                'conflict',
                'Final candidate or destination changed. Refresh and review the exact commits before approving.',
              );
            check();
            operation = {
              id: randomUUID(),
              workspaceId,
              worktreeId,
              status: 'reserved',
              sourceSha: reviewed.headSha,
              targetSha: reviewed.targetSha,
              targetBranch: reviewed.targetBranch,
              reviewRunId: gate.reviewRunId,
              createdAt: this.now().toISOString(),
              authorizedByUserId: context.user.id,
              ...(finalApproval?.removeIntegrationBranch ? { removeIntegrationBranch: true } : {}),
              ...(adoption
                ? {
                    checkAdoption: {
                      proposalDigest: adoption.merge.proposalDigest,
                      rationale: adoption.rationale,
                    },
                  }
                : {}),
              ...(delegation
                ? {
                    roadmapId: delegation.roadmapId,
                    definitionRevision: delegation.definitionRevision,
                  }
                : {}),
            };
            const reserved = operation;
            this.storage.transaction((tx) => tx.execution.merges.save(reserved));
            const merged = await git.mergeBranch({
              sourceCommitSha: operation.sourceSha,
              expectedTargetSha: operation.targetSha,
              repositoryPath: repository.rootPath,
              branchName: worktree.branchName,
              targetBranch: operation.targetBranch,
              scratchPath: join(
                this.config.mergeRoot ?? join(this.config.worktreeRoot, '.merge'),
                operation.id,
              ),
              message: `CraftingTable integration merge ${operation.id}\n\nMerge ${worktree.branchName}: ${item.sourceId} ${item.title}\nReviewed by ${operation.reviewRunId}.`,
            });
            if (!merged.ok) {
              // Git may have committed before a later command failed. Keep the reservation
              // until an explicit retry (or the delegated scheduler) reconciles it.
              const recovered = await git.inspectMergeOperation({
                repositoryPath: repository.rootPath,
                ...operation,
              });
              if (recovered.ok && !recovered.value)
                this.storage.transaction((tx) =>
                  tx.execution.merges.save({ ...reserved, status: 'failed' }),
                );
              if (!recovered.ok || !recovered.value)
                throw new ExecutionRequestError('conflict', merged.failure.message);
              mergeSha = recovered.value;
            } else mergeSha = merged.value.mergeSha;
          }
          if (!operation || !mergeSha)
            throw new ExecutionRequestError('conflict', 'Missing merge reservation');
          // A completed Git operation must be recorded even if pause/revocation raced it.
          // No further Git merge is authorized by this reconciliation.
          const targetBranch = operation.targetBranch;
          const committed = { ...operation, status: 'merged' as const, mergeSha };
          const occurredAt = this.now().toISOString();
          // The adoption the operator approved, if the merge commit proposes exactly it.
          const adopting = committed.checkAdoption
            ? await this.mergeProposal(repository, mergeSha, committed.checkAdoption.proposalDigest)
            : undefined;
          const result = this.storage.transaction((tx) => {
            const existing = tx.execution.worktrees.find(workspaceId, worktreeId);
            if (!existing) throw new NotFoundError();
            if (existing.mergedAt) return { worktree: existing, workItemCompleted: false };
            tx.execution.merges.save(committed);
            if (worktree.planVersionId) {
              const finalization = tx.execution.finalizations
                .list(workspaceId)
                .find((f) => f.worktreeId === worktreeId);
              if (!finalization) throw new NotFoundError();
              tx.execution.finalizations.save(
                {
                  ...finalization,
                  status: 'completed',
                  version: finalization.version + 1,
                  reason: `Promoted to ${targetBranch} by explicit operator approval.`,
                  ...(committed.removeIntegrationBranch
                    ? {
                        integrationCleanup: {
                          status: 'pending' as const,
                          requestedAt: committed.createdAt,
                          requestedByUserId: committed.authorizedByUserId,
                        },
                      }
                    : {}),
                },
                finalization.version,
              );
            }
            const marked = tx.execution.worktrees.markMerged({
              workspaceId,
              worktreeId,
              occurredAt,
              mergeSha,
            });
            if (!marked) throw new NotFoundError();
            tx.audit.append({
              id: asAuditEventId(randomUUID()),
              occurredAt,
              actorKind: delegation ? 'system' : 'user',
              actorUserId: committed.authorizedByUserId,
              ...(context.session ? { sessionId: context.session.id } : {}),
              workspaceId,
              ...(requestId ? { requestId } : {}),
              action: 'worktree.merged',
              targetType: 'worktree',
              targetId: worktreeId,
              outcome: 'succeeded',
              priorVersion: worktree.version,
              resultingVersion: marked.version,
              metadata: {
                branchName: worktree.branchName,
                targetBranch,
                mergeSha,
                reviewRunId: committed.reviewRunId,
                operationId: committed.id,
                removeIntegrationBranch: committed.removeIntegrationBranch ?? false,
                ...(committed.roadmapId
                  ? {
                      roadmapId: committed.roadmapId,
                      definitionRevision: committed.definitionRevision ?? 0,
                    }
                  : {}),
              },
            });
            if (committed.checkAdoption && adopting)
              this.recordMergeAdoption(
                tx,
                worktree,
                committed,
                adopting,
                occurredAt,
                adoption?.declarationId,
              );
            tx.workspaceEvents.appendEvent({
              id: asEventId(randomUUID()),
              occurredAt,
              workspaceId,
              actorUserId: committed.authorizedByUserId,
              projectId: worktree.projectId,
              workItemId: worktree.workItemId,
              kind: 'worktree-merged',
              payload: {
                worktreeId,
                ...(worktree.workItemId
                  ? { workItemId: worktree.workItemId }
                  : { planVersionId: worktree.planVersionId }),
                branchName: worktree.branchName,
                targetBranch,
                mergeSha,
              },
            });
            const completion =
              worktree.workItemId && !worktree.executionScope && item.status === 'admitted'
                ? this.workItemService.completeWithin(tx, {
                    context,
                    workspaceId,
                    workItemId: worktree.workItemId,
                    occurredAt,
                    ...(requestId ? { requestId } : {}),
                    worktreeId,
                    mergeSha,
                  })
                : { completed: false };
            return { worktree: marked, workItemCompleted: completion.completed };
          });
          this.notifier.notify();
          await this.cleanupMerge(committed, repository, worktree);
          return { ...result, mergeSha, targetBranch, createdTarget: false };
        }),
      );
    });
  }

  private async recoverMergeScratch(
    repository: SourceRepository,
    operation: import('@craftingtable/domain').MergeOperation,
  ): Promise<void> {
    const git = this.requireGit();
    const path = join(
      this.config.mergeRoot ?? join(this.config.worktreeRoot, '.merge'),
      operation.id,
    );
    const identity = await git.inspectRepository(path);
    if (identity.ok) {
      if (
        identity.value.branch !== operation.targetBranch ||
        identity.value.headSha !== operation.targetSha
      )
        throw new ExecutionRequestError(
          'conflict',
          'Interrupted merge scratch changed unexpectedly; its contents were retained.',
        );
      const input = {
        worktreePath: path,
        branchName: operation.targetBranch,
        headSha: operation.targetSha,
        targetSha: operation.sourceSha,
      };
      const state = await git.inspectIntegrationResolution(input);
      if (!state.ok || state.value.untracked.length || state.value.unstaged)
        throw new ExecutionRequestError(
          'conflict',
          'Interrupted merge scratch contains unresolved or unexpected edits; its contents were retained.',
        );
      const aborted = await git.abortIntegrationResolution(input);
      if (!aborted.ok) throw new ExecutionRequestError('conflict', aborted.failure.message);
    }
    const removed = await git.removeWorktree({
      repositoryPath: repository.rootPath,
      worktreePath: path,
      force: false,
    });
    if (!removed.ok) throw new ExecutionRequestError('conflict', removed.failure.message);
  }

  private async cleanupMerge(
    operation: import('@craftingtable/domain').MergeOperation,
    repository: SourceRepository,
    tree: Worktree,
  ): Promise<void> {
    const git = this.requireGit();
    const scratch = await git.removeWorktree({
      repositoryPath: repository.rootPath,
      worktreePath: join(
        this.config.mergeRoot ?? join(this.config.worktreeRoot, '.merge'),
        operation.id,
      ),
      force: false,
    });
    // A recovered merge never authorizes removing later edits or commits.
    const identity = await git.inspectRepository(tree.path);
    const changed =
      identity.ok &&
      (identity.value.headSha !== operation.sourceSha || identity.value.branch !== tree.branchName);
    const removed = changed
      ? {
          ok: false as const,
          failure: {
            message:
              'The merged worktree now contains a different branch or commit. Its checkout and branch were retained.',
          },
        }
      : await git.removeWorktree({
          repositoryPath: repository.rootPath,
          worktreePath: tree.path,
          force: false,
        });
    const deleted = removed.ok
      ? await git.deleteBranch({
          repositoryPath: repository.rootPath,
          branchName: tree.branchName,
          mergedInto: operation.targetBranch,
          // Compare-and-delete: a commit added after the merge keeps the branch.
          expectedHeadSha: operation.sourceSha,
        })
      : undefined;
    const error = !removed.ok
      ? removed.failure.message
      : !scratch.ok
        ? scratch.failure.message
        : deleted && !deleted.ok
          ? deleted.failure.message
          : undefined;
    const { cleanupError: _priorError, ...cleanOperation } = operation;
    this.storage.transaction((tx) =>
      tx.execution.merges.save({
        ...cleanOperation,
        status: error ? 'merged' : 'cleaned',
        ...(error ? { cleanupError: error.slice(0, 4000) } : {}),
      }),
    );
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
    const git = this.requireGit();
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
