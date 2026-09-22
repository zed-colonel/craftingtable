import { createHash } from 'node:crypto';
import { asWorktreeId, type EvidenceSubmission, type ExecutionScope } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
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
  const run = runs[0];
  const turn = run && tx.execution.runEvents.latestOfKind(s.workspaceId, run.id, 'turn-completed');
  const build = run && tx.runtimeEvidence.build(s.workspaceId, run.id);
  const issues: string[] = [];

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
    const receipts = (build?.receipts ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !receipts.some(
        (r) =>
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
