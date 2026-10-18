/**
 * A work item's execution scope resolved against its imported map: the leaf the scope gates, the
 * phase resources and the transition gate all read, so none of them imports `execution-scope.ts`
 * for it (R-B7: no import cycles).
 */
import {
  type ExecutionScope,
  executionScopeKey,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { mapAdopted } from './map-adoption-policy.js';

function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}
export function resolveScope(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope: ExecutionScope,
) {
  const item = tx.planning.workItems.find(workspaceId, workItemId);
  const definition = tx.imports.definition(workspaceId, scope.definitionId);
  const revision = tx.imports
    .bindings(workspaceId, scope.definitionId)
    .find((b) => b.revision === scope.bindingRevision);
  const binding = revision?.bindings.find((b) =>
    b.workItems.some((w) => w.workItemId === workItemId),
  );
  const parent = definition?.source.work_items.find((p) =>
    binding?.workItems.some((w) => w.sourceId === p.id && w.workItemId === workItemId),
  );
  if (!item || !definition || !binding || !parent || binding.planVersionId !== item.planVersionId)
    throw new NotFoundError();
  const slice =
    scope.kind === 'parent-acceptance'
      ? undefined
      : definition.source.slices.find((s) => s.id === scope.sourceId && s.work_item === parent.id);
  if (scope.kind === 'parent-acceptance' ? scope.sourceId !== parent.id : !slice)
    throw new NotFoundError();
  const profile = definition.source.evidence_profiles.find(
    (p) => p.id === (slice?.evidence_profile ?? parent.acceptance_evidence_profile),
  );
  if (!profile) conflict('The scope evidence profile is unavailable.');
  return { item, definition, binding, parent, slice, profile, scope };
}
export type ResolvedScope = ReturnType<typeof resolveScope>;
export function scopeAllowsEarlyDevelopment(
  tx: StorageRepositories,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  scope?: ExecutionScope,
): boolean {
  if (!scope || scope.kind === 'parent-acceptance') return false;
  const r = resolveScope(tx, workspaceId, workItemId, scope);
  return (
    !!r.slice?.early_start_exception &&
    (mapAdopted(tx, workspaceId, scope.definitionId, scope.bindingRevision) ||
      (!r.slice.decision_refs.length &&
        tx.phaseScheduling.authorized(
          workspaceId,
          workItemId,
          executionScopeKey({ ...scope, kind: 'slice' }),
        )))
  );
}
