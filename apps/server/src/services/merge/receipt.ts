/**
 * A review-only scope's acceptance (R-B7): a slice verification's or a parent acceptance's
 * receipt, recorded under the same worktree guard, phase reservation and merge lane as a merge,
 * after the review's evidence and the integration snapshot it inspected are checked.
 */

import type { RoadmapCheck } from '../roadmap-actor.js';
import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  verificationFollowUps,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { CommandContext } from '../auth-service.js';
import type { BranchService } from '../branch-service.js';
import { ExecutionRequestError, NotFoundError } from '../errors.js';
import { requireScope, scopeEvidenceIssues } from '../execution-scope.js';
import { scopeReviewerRoles } from '../map-adoption-policy.js';
import { needsNativeVerification } from '../native-verification-policy.js';
import { withPhaseReservation } from '../phase-resources.js';
import { latestReviewReport } from '../run-lineage.js';
import { integratedSlice } from '../scope-lineage.js';
import { acceptedEvidence } from '../runtime-evidence-policy.js';
import type { RuntimeEvidenceService } from '../runtime-evidence-service.js';
import type { WorkItemService } from '../work-item-service.js';
import { requireGit } from '../git-required.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { WorkspaceService } from '../workspace-service.js';
import type { WorktreeMutationGuard } from '../worktree-mutation-guard.js';

export class ScopeReceipts {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly git: GitOperations | undefined,
    private readonly workItemService: WorkItemService,
    private readonly now: () => Date,
    private readonly mutations: WorktreeMutationGuard,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    private readonly branches: BranchService,
  ) {}

  async recordScopeReceipt(
    context: CommandContext,
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    expectedWorktreeVersion: number,
    /** The roadmap's actor, when its scheduler records the receipt (R-B7). */
    delegation?: { readonly actor: RoadmapCheck },
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    return this.mutations.during(worktreeId, 'scope-receipt', async () => {
      const tree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
      if (!tree?.workItemId || !tree.executionScope) throw new NotFoundError();
      delegation?.actor.check();
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
      const verification = scope.kind === 'slice-verification';
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
          const git = requireGit(this.git);
          requireScope(this.storage, workspaceId, workItemId, scope, phase);
          if (
            tree.integrationBranch !== resolved.binding.integrationBranch ||
            tree.repositoryId !== resolved.binding.repositoryId
          )
            throw new ExecutionRequestError(
              'conflict',
              'The worktree differs from its frozen scope binding.',
            );
          await this.runtimeEvidence.assertFreshTree(tree, phase);
          if (run) this.runtimeEvidence.assertRun(tree, run.id);
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
            (verification
              ? verificationFollowUps(report) === undefined
              : report.report.verdict !== 'mergeable' ||
                !report.report.exitGate.met ||
                report.report.findings.some((f) => f.status === 'open' && f.severity !== 'nit'))
          )
            throw new ExecutionRequestError(
              'conflict',
              verification
                ? 'A finished, successful independent verification with a met gate, a mergeable verdict and no open blocking or major findings is required.'
                : 'A finished, successful independent review with no open blocking, major or minor findings is required.',
            );
          // R-C7 D7: what a passing slice verification left open is kept on its evidence.
          const followUps = verification ? (verificationFollowUps(report) ?? []) : [];
          const reviewerRoles = scopeReviewerRoles(this.storage, workspaceId, scope, run.id);
          if (
            !resolved.profile.reviewer_roles.every((role) => reviewerRoles.includes(role)) &&
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
          const reported = report.report.scopeEvidence;
          const issues = scopeEvidenceIssues(resolved, reported);
          const evidence = reported && (followUps.length ? { ...reported, followUps } : reported);
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
              const merged = integratedSlice(this.storage, workspaceId, workItemId, scope);
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
              const merged = integratedSlice(this.storage, workspaceId, workItemId, {
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
          // An approval that landed across the Git inspection changed the review's packet: it
          // is refused here, not recorded stale (R-B6 increment 3 review L-1).
          this.runtimeEvidence.assertRun(tree, run.id);
          delegation?.actor.check();
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
}
