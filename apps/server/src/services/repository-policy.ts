import type { RepositoryPolicyEvidence } from '@craftingtable/contracts';
import type { PlanVersionId, Worktree, WorkspaceId } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { StorageRepositories } from '@craftingtable/storage';

export function worktreePlan(tx: StorageRepositories, tree: Worktree): PlanVersionId | undefined {
  return (
    tree.planVersionId ??
    (tree.workItemId
      ? tx.planning.workItems.find(tree.workspaceId, tree.workItemId)?.planVersionId
      : undefined)
  );
}

/** Fresh local observations plus an immutable operator policy, never fabricated hosting evidence. */
export async function repositoryPolicyEvidence(
  tx: StorageRepositories,
  git: GitOperations,
  workspaceId: WorkspaceId,
  planVersionId: PlanVersionId,
  observedAt: string,
  freezeBranch?: string,
): Promise<RepositoryPolicyEvidence> {
  const settings = tx.execution.branchSettings.find(workspaceId, planVersionId);
  const policy = tx.execution.branchSettings.policy(workspaceId, planVersionId);
  const issues: string[] = [];
  const result: RepositoryPolicyEvidence = {
    kind: 'repository-policy-evidence-v1',
    observedAt,
    settingsVersion: settings?.version ?? 0,
    ...(policy ? { policy } : {}),
    ...(settings ? { integrationBranch: settings.integrationBranch } : {}),
    issues,
    manualApprovalBranches: ['main', 'master'],
    controls: [
      'CraftingTable launches work in managed work-item/slice branches and records each integration destination.',
      'A recorded experimental freeze blocks ordinary CraftingTable merges into that branch; only explicitly approved final plan promotion can update it through the controller.',
      'CraftingTable integration merges require a completed qualifying review of the exact current source and target commits, under operator approval or recorded roadmap delegation.',
      'Final plan promotion requires explicit operator approval. main, master, the repository default, and configured manual-merge branches are excluded from automatic integration.',
    ],
    limitations: [
      'These are CraftingTable workflow controls, not GitHub rules, filesystem isolation, or protection against direct Git commands outside CraftingTable.',
      'No remote protection, publication, or remote freeze was inspected or performed. An authentication failure is not proof that remote protection is missing.',
      'A matching frozen branch is a timestamped observation. The recorded freeze is an operator instruction, not an operating-system write lock.',
      'A plan declaration or prior agent statement does not adopt a policy. Only the separately recorded operator policy supplies that interpretation.',
    ],
  };
  if (!settings) {
    issues.push('Configure plan branches before adopting repository policy.');
    return result;
  }
  const repo = tx.execution.sourceRepositories.find(workspaceId, settings.repositoryId);
  if (repo?.status !== 'active') {
    issues.push('The configured repository is unavailable.');
    return result;
  }
  result.manualApprovalBranches = [
    ...new Set([
      'main',
      'master',
      repo.defaultBranch,
      ...tx.execution.branchSettings
        .list()
        .filter(
          (s) =>
            tx.execution.sourceRepositories.find(s.workspaceId, s.repositoryId)?.rootPath ===
            repo.rootPath,
        )
        .flatMap((s) => s.manualMergeBranches ?? []),
      ...tx.execution.finalizations
        .list()
        .filter(
          (f) =>
            tx.execution.sourceRepositories.find(f.workspaceId, f.repositoryId)?.rootPath ===
            repo.rootPath,
        )
        .map((f) => f.targetBranch),
    ]),
  ].sort();
  if (
    policy &&
    (policy.repositoryId !== settings.repositoryId ||
      policy.integrationBranch !== settings.integrationBranch ||
      policy.branchSettingsVersion !== settings.version)
  )
    issues.push(
      'Branch settings changed after policy adoption. Review and adopt a new policy revision.',
    );
  const integration = await git.resolveBranch(repo.rootPath, settings.integrationBranch);
  if (integration.ok) result.integrationSha = integration.value;
  else issues.push(integration.failure.message);
  const selected = freezeBranch ?? policy?.experimentalFreeze?.branch ?? repo.defaultBranch;
  const frozen = await git.resolveBranch(repo.rootPath, selected);
  if (frozen.ok) result.proposedFreeze = { branch: selected, commitSha: frozen.value };
  else issues.push(frozen.failure.message);
  if (policy?.experimentalFreeze) {
    const observation =
      selected === policy.experimentalFreeze.branch
        ? frozen
        : await git.resolveBranch(repo.rootPath, policy.experimentalFreeze.branch);
    if (observation.ok) {
      result.observedFreezeSha = observation.value;
      const promoted = tx.execution.finalizations
        .list(workspaceId)
        .some(
          (f) =>
            f.planVersionId === planVersionId &&
            f.status === 'completed' &&
            f.targetBranch === policy.experimentalFreeze?.branch,
        );
      if (observation.value !== policy.experimentalFreeze.commitSha && !promoted)
        issues.push(
          'The frozen experimental branch moved. Resolve the changed baseline or explicitly revise the policy; do not claim the freeze is verified.',
        );
      if (promoted)
        result.controls.push(
          'The experimental freeze has reached its end: this plan has a recorded completed final promotion.',
        );
    } else issues.push(observation.failure.message);
  }
  return result;
}

export const REPOSITORY_POLICY_GUIDANCE =
  'Read craftingtable-repository-policy.json before interpreting branch protection, experimental freeze, or publication obligations. Cite the adopted policy revision and fresh observations separately. When the operator has adopted controller-local protection, assess those local controls; do not demand GitHub settings or credentials as substitute evidence. Remote obligations remain due at the milestone recorded in that policy and are not claimed complete. Read craftingtable-operator-decisions.json (also indexed in scoped evidence) for prior applicable operator guidance across implementation, review, slice verification, parent acceptance, and finalization. Those records are operator guidance, not test results. Reconcile stale repository instructions against the adopted policy; implementation must correct contradictory documentation, while a read-only reviewer reports the exact remaining discrepancy. Do not silently waive a more specific incompatible source requirement; identify the conflict once and request an explicit decision. If no policy is adopted, do not invent one or infer protection from branch/tag existence.';
