import { historicalReviewerRoles } from './roadmap-delegation-policy.js';
import { createHash } from 'node:crypto';
import { asWorktreeId, type EvidenceSubmission, type ExecutionScope } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { assignedReviewMatches } from './agent-profile-policy.js';
import {
  declaredCheckGaps,
  parseBuildReceipts,
  receiptKindEstablishes,
} from './build-receipt-policy.js';
import { worktreePlan } from './repository-policy.js';

export const checkpointDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Cheap durable checks used by projections and again inside acceptance transactions. */
export function candidateCheckpointIssues(
  tx: StorageRepositories,
  s: EvidenceSubmission,
): string[] {
  const c = s.candidateCheckpoint;
  if (!c) return [];
  const tree = tx.execution.worktrees.find(s.workspaceId, asWorktreeId(c.worktreeId));
  const runs = tree ? tx.execution.runs.listForWorktree(s.workspaceId, tree.id) : [];
  const run = c.delegatedReview ? runs.find((r) => r.id === c.runId) : runs[0];
  const turn = run && tx.execution.runEvents.latestOfKind(s.workspaceId, run.id, 'turn-completed');
  const build = run && tx.runtimeEvidence.build(s.workspaceId, run.id);
  const issues: string[] = [];
  if (c.delegatedReview) {
    const a = c.delegatedReview;
    const saved = tx.roadmaps.definition(s.workspaceId, a.roadmapId, a.definitionRevision);
    const roadmap = tx.roadmaps.find(s.workspaceId, a.roadmapId);
    const attempt = roadmap?.attempts.find((x) => x.cycleId === a.cycleId);
    const entry = saved?.entries.find((e) => e.id === attempt?.entryId);
    if (
      !entry ||
      entry.executionScope?.sourceId !== c.sliceId ||
      a.roles.some(
        (r) => !roadmap || !run || !historicalReviewerRoles(roadmap, entry, run).includes(r),
      ) ||
      !run ||
      !roadmap ||
      !assignedReviewMatches(roadmap, entry, run)
    )
      issues.push('Checkpoint review no longer matches its saved delegation.');
    const newer = run
      ? runs.slice(
          0,
          runs.findIndex((r) => r.id === run.id),
        )
      : runs;
    if (
      newer.some(
        (r) =>
          r.role !== 'review' ||
          r.status !== 'finished' ||
          r.verdict !== 'mergeable' ||
          r.reviewBranchContext?.headSha !== c.headSha ||
          r.reviewBranchContext.targetSha !== c.integrationSha,
      )
    )
      issues.push('A later run changed or invalidated the checkpoint candidate review.');
  }

  if (
    !tree ||
    tx.amendments.retired(s.workspaceId, tree.id) ||
    tx.amendments.superseded(s.workspaceId, s.definitionId, s.bindingRevision) ||
    tree.executionScope?.definitionId !== s.definitionId ||
    tree.executionScope.bindingRevision !== s.bindingRevision ||
    tree.executionScope.kind !== 'slice' ||
    tree.executionScope.sourceId !== c.sliceId
  )
    issues.push('The checkpoint candidate no longer belongs to this active slice binding.');
  if (
    !run ||
    run.id !== c.runId ||
    run.status !== 'finished' ||
    run.role !== 'review' ||
    run.verdict !== 'mergeable' ||
    run.reviewBranchContext?.headSha !== c.headSha ||
    run.reviewBranchContext.targetSha !== c.integrationSha ||
    turn?.kind !== 'turn-completed' ||
    checkpointDigest(turn.payload) !== c.reportDigest ||
    !build ||
    build.error ||
    build.digest !== c.buildDigest
  )
    issues.push(
      'The checkpoint needs the unchanged latest successful review and frozen build record.',
    );
  try {
    const receipts = parseBuildReceipts(build?.receipts ?? '');
    // A review held to declared checks (R-G13) meets its gate only with them, beside the
    // controller receipt its mode needs: for a current-upstream candidate, a pinned build
    // (increment 2). The receipts' manifest digest fixes the mode they ran under.
    const declarationId = run && tx.runtimeEvidence.run(s.workspaceId, run.id)?.checkDeclarationId;
    const declaration =
      declarationId && tx.runtimeEvidence.checkDeclaration(s.workspaceId, declarationId);
    if (declarationId && !declaration)
      issues.push('The declared checks this review was held to are unavailable.');
    if (declaration) {
      const gaps = declaredCheckGaps(
        declaration,
        receipts,
        (r) =>
          r.kind === 'scoped-check' &&
          r.success === true &&
          r.clean === true &&
          r.headSha === c.headSha &&
          r.runId === c.runId &&
          r.runtimeId === build?.runtimeId &&
          r.manifestDigest === build?.manifestDigest,
        tx.runtimeEvidence.checkDeclarations(s.workspaceId, declaration.repositoryId)[0],
      );
      for (const changed of gaps.changed)
        issues.push(
          `The declared check ${changed.checkId} ran with definitions that differ from the adopted ones (${changed.paths.join(', ')}).`,
        );
      if (gaps.missing.length)
        issues.push(
          `The checkpoint needs a successful run of each declared check on the exact clean candidate: ${gaps.missing.join(', ')}.`,
        );
    }
    if (
      !receipts.some(
        (r) =>
          receiptKindEstablishes(
            r,
            r.verificationMode === 'scoped-checks' ? 'scoped-checks' : 'current-upstream-build',
          ) &&
          r.success === true &&
          r.clean === true &&
          r.headSha === c.headSha &&
          r.runId === c.runId &&
          r.runtimeId === build?.runtimeId &&
          r.manifestDigest === build?.manifestDigest,
      )
    )
      issues.push(
        'The checkpoint needs a successful controller receipt on the exact clean candidate.',
      );
  } catch {
    issues.push('The checkpoint build receipts are unavailable or invalid.');
  }
  if (
    tree &&
    !tree.mergeSha &&
    (tree.status !== 'active' || tree.version !== run?.reviewBranchContext?.worktreeVersion)
  )
    issues.push('The candidate worktree changed after its review.');
  // After its merge the integration tree must stay the reviewed tree (ADR-060). A later
  // controller merge changes it; transition commands also compare the live branch.
  if (
    tree?.mergedAt &&
    tree.integrationBranch &&
    tx.execution.worktrees.mergedIntoAfter(
      s.workspaceId,
      tree.repositoryId,
      tree.integrationBranch,
      tree.mergedAt,
    )
  )
    issues.push(
      'Integration changed after this candidate was merged. Prepare fresh checkpoint evidence.',
    );
  const plan = tree && worktreePlan(tx, tree);
  if (tree && plan) {
    const binding = tx.imports
      .bindings(s.workspaceId, s.definitionId)
      .find((b) => b.revision === s.bindingRevision)
      ?.bindings.find((b) => b.planVersionId === plan);
    const settings = tx.execution.branchSettings.find(s.workspaceId, plan);
    const item = tree.workItemId && tx.planning.workItems.find(s.workspaceId, tree.workItemId);
    if (
      !binding ||
      settings?.version !== binding.branchSettingsVersion ||
      settings?.repositoryId !== tree.repositoryId ||
      settings?.integrationBranch !== tree.integrationBranch ||
      (item &&
        tx.planning.projects.find(s.workspaceId, item.projectId)?.activePlanVersionId !== plan)
    )
      issues.push(
        'The candidate plan or repository/branch binding changed. Reconcile the binding first.',
      );
  }
  if (
    plan &&
    run?.reviewBranchContext?.repositoryPolicyVersion !==
      tx.execution.branchSettings.policy(s.workspaceId, plan)?.version
  )
    issues.push('Repository policy changed after the candidate review.');
  return issues;
}

/** An unmerged candidate is evidence for its own merge, never a global checkpoint pass. */
export function candidateApplies(
  tx: StorageRepositories,
  s: EvidenceSubmission,
  scope?: ExecutionScope,
) {
  const c = s.candidateCheckpoint;
  if (!c) return true;
  const tree = tx.execution.worktrees.find(s.workspaceId, asWorktreeId(c.worktreeId));
  return (
    !!tree?.mergeSha ||
    (scope?.kind === 'slice' &&
      scope.definitionId === s.definitionId &&
      scope.bindingRevision === s.bindingRevision &&
      scope.sourceId === c.sliceId)
  );
}
