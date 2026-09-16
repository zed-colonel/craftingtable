import {
  sameExecutionScope,
  type ExecutionScope,
  type WorkspaceId,
  type WorkItemId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
export function integratedSlice(
  tx: StorageRepositories,
  ws: WorkspaceId,
  item: WorkItemId,
  scope: ExecutionScope,
) {
  const direct = tx.execution.worktrees
    .listForWorkItem(ws, item)
    .filter(
      (t) =>
        sameExecutionScope(t.executionScope, { ...scope, kind: 'slice' }) &&
        t.mergedAt &&
        t.mergeSha,
    )
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
  const reuse = tx.amendments.integrations(ws, item, scope)[0];
  return direct ?? (reuse && tx.execution.worktrees.find(ws, reuse.sourceWorktreeId));
}
export function amendmentHoldsBinding(
  tx: StorageRepositories,
  ws: WorkspaceId,
  definitionId: string,
  bindingRevision: number,
) {
  return tx.amendments.list(ws).some((a) => {
    if (a.decision) return false;
    const prior = tx.roadmaps.find(ws, a.roadmapId)?.definition.crossProject;
    return [prior, a.candidate].some(
      (c) => c?.definitionId === definitionId && c.bindingRevision === bindingRevision,
    );
  });
}
export function amendmentHoldingScope(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
) {
  return amendmentHoldsBinding(tx, ws, scope.definitionId, scope.bindingRevision);
}
