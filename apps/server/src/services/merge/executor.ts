/**
 * The merge executor (R-B7; CTRL-13): a reviewed worktree's merge into its integration target,
 * under the worktree guard, the phase reservation and the repository's merge lane, with the check
 * adoption a person approves with it, the recovery of a merge a restart interrupted, the record's
 * transaction and the cleanup after. What it may merge is the gate's (`merge/gate.ts`); the Git
 * reads and the writes are its own.
 */
import {
  type CheckDeclarationProposal,
  definitionChangeReason,
  type MergeAdoption,
  proposalDigest,
  type RepositoryChecksService,
} from '../repository-checks-service.js';
import type { RoadmapActor } from '../roadmap-actor.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  type AgentRun,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  asMergeOperationId,
  asRepositoryCheckDeclarationId,
  evaluateCycleCompletion,
  type FinalizationId,
  type MergeOperation,
  type RepositoryCheckDeclaration,
  required,
  type RoadmapId,
  type SourceRepository,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ExecutionConfig } from '../../config.js';
import type { CommandContext } from '../auth-service.js';
import type { BranchService } from '../branch-service.js';
import {
  CheckAdoptionRequiredError,
  CheckDefinitionChangedError,
  ExecutionRequestError,
  gitRefusalDetail,
  NotFoundError,
} from '../errors.js';
import { requireTreeScope, resolveScope, scopedReviewIssue } from '../execution-scope.js';
import { stagedPromotionIssue } from '../finalization-stage-policy.js';
import {
  automationApproved,
  finalCandidateMoved,
  finalReviewReady,
  MERGE_GATE_MESSAGES,
  mergeGateFor,
  planPromotionUnapproved,
  retargetRequired,
} from './gate.js';
import { withPhaseReservation } from '../phase-resources.js';
import { latestReviewReport } from '../run-lineage.js';
import type { RuntimeEvidenceService } from '../runtime-evidence-service.js';
import type { WorkItemService } from '../work-item-service.js';
import { securityReviewCurrent } from '../workflow-policy.js';
import { requireGit } from '../git-required.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { WorkspaceService } from '../workspace-service.js';
import type { WorktreeMutationGuard } from '../worktree-mutation-guard.js';

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

export class MergeExecutor {
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
    private readonly repositoryChecks: RepositoryChecksService,
    private readonly branches: BranchService,
  ) {}

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
    delegation?: { roadmapId: RoadmapId; definitionRevision: number; actor: RoadmapActor },
    finalApproval?: {
      finalizationId: FinalizationId;
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
    return this.mutations.during(worktreeId, 'merge', async () => {
      const git = requireGit(this.git);
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
            delegation?.actor.check();
            const review = this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0];
            if (review)
              this.runtimeEvidence.assertMergeRun(
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
            await this.runtimeEvidence.assertFreshTree(worktree, 'merge');
            const review = this.storage.execution.runs.listForWorktree(workspaceId, worktreeId)[0];
            adoption = review
              ? await this.checkAdoption(worktree, review, input.adoptChecks, !!delegation)
              : undefined;
            if (review)
              this.runtimeEvidence.assertMergeRun(
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
          // A worktree that checked the target out as its ref moved (R-G10 review F5).
          let checkedOutDuringMerge: string | undefined;
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
            if (planPromotionUnapproved(worktree, finalApproval, !!context.session, !!delegation))
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
              if (!finalization || !finalReviewReady(finalization, worktreeId, cycle))
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
              this.storage.execution.runs.listForWorktree(workspaceId, worktreeId, {
                investigations: true,
              }),
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
            if (!automationApproved(cycle, gate.reviewRunId, state.value.headSha))
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
            if (retargetRequired(input.targetBranch, reviewed))
              throw new ExecutionRequestError(
                'conflict',
                'Retarget the worktree explicitly and review again before merging elsewhere',
              );
            if (finalCandidateMoved(finalApproval, reviewed))
              throw new ExecutionRequestError(
                'conflict',
                'Final candidate or destination changed. Refresh and review the exact commits before approving.',
              );
            check();
            operation = {
              id: asMergeOperationId(randomUUID()),
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
                throw new ExecutionRequestError(
                  'conflict',
                  merged.failure.message,
                  gitRefusalDetail(merged.failure),
                );
              mergeSha = recovered.value;
            } else {
              mergeSha = merged.value.mergeSha;
              checkedOutDuringMerge = merged.value.checkedOutDuringMerge;
            }
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
                ...(checkedOutDuringMerge ? { checkedOutDuringMerge } : {}),
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

  /**
   * What merging a slice adopts (R-G13 increment 5, operator decision 2026-09-30): nothing
   * when the slice changes no check definition. Otherwise only a person's approval naming the
   * proposal they were shown may merge it, never a roadmap's, and a merge whose result cannot
   * be adopted is refused.
   */
  async checkAdoption(
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
    const environment = this.storage.runtimeEvidence.run(worktree.workspaceId, review.id);
    if (
      worktree.executionScope?.kind !== 'slice' ||
      !review.reviewBranchContext ||
      !environment?.checkDeclarationId ||
      // A check-only run's merge adopts nothing, as its approval offers nothing (R-G13
      // increment 4): its changed definitions are adopted on the Repositories page.
      environment.runtimeId === undefined
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
    this.runtimeEvidence.assertRun(
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
  async mergeProposal(
    repository: SourceRepository,
    mergeSha: string,
    approved: string,
  ): Promise<{ proposal?: CheckDeclarationProposal; refused?: string }> {
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
  recordMergeAdoption(
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
      id: asRepositoryCheckDeclarationId(randomUUID()),
      workspaceId: worktree.workspaceId,
      repositoryId: worktree.repositoryId,
      version: (declarations[0]?.version ?? 0) + 1,
      sourceCommit: merge.mergeSha,
      sourcePath: proposal.sourcePath,
      checks: proposal.checks,
      definitionDigests: proposal.definitionDigests,
      rationale: required(merge.checkAdoption, "the merge's check adoption").rationale,
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

  async recoverMergeScratch(
    repository: SourceRepository,
    operation: import('@craftingtable/domain').MergeOperation,
  ): Promise<void> {
    const git = requireGit(this.git);
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

  async cleanupMerge(
    operation: import('@craftingtable/domain').MergeOperation,
    repository: SourceRepository,
    tree: Worktree,
  ): Promise<void> {
    const git = requireGit(this.git);
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
}
