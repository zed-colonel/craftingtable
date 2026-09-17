import type { WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
export function bindingIssues(
  tx: StorageRepositories,
  ws: WorkspaceId,
  id: string,
  revision: number,
): string[] {
  const d = tx.imports.definition(ws, id),
    b = tx.imports.bindings(ws, id)[0];
  if (!d || !b || b.revision !== revision) return ['Select the current exact map binding.'];
  const issues: string[] = [];
  if (tx.amendments.superseded(ws, id, revision))
    issues.push('This map binding was retired by a reviewed amendment. Select its replacement.');
  for (const repo of d.source.repositories) {
    const bound = b.bindings.find((b) => b.alias === repo.id);
    if (
      !bound?.repositoryId ||
      tx.execution.sourceRepositories.find(ws, bound.repositoryId)?.status !== 'active'
    ) {
      issues.push(`Bind an active repository for ${repo.id}.`);
      continue;
    }
    if (repo.role === 'implemented_upstream') continue;
    if (!bound.planVersionId || !bound.projectId) {
      issues.push(`Bind the exact ${repo.id} plan version.`);
      continue;
    }
    const settings = tx.execution.branchSettings.find(ws, bound.planVersionId);
    if (tx.planning.projects.find(ws, bound.projectId)?.activePlanVersionId !== bound.planVersionId)
      issues.push(`Make the bound ${repo.id} plan active.`);
    if (
      settings?.version !== bound.branchSettingsVersion ||
      settings?.repositoryId !== bound.repositoryId ||
      settings?.integrationBranch !== bound.integrationBranch
    )
      issues.push(`Refresh ${repo.id} repository and branch bindings.`);
  }
  return issues;
}
