import type { WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { resolveScope } from './execution-scope.js';
import {
  acceptedEvidence,
  parentAccepted,
  currentScopeReceipt,
} from './runtime-evidence-policy.js';
import { integratedSlice } from './scope-lineage.js';

type Requirements = NonNullable<WorkCycle['designWait']>['requirements'];
/** Agent prose can request a wait, but cannot introduce or weaken a mapped dependency. */
export function designDependencyState(
  tx: StorageRepositories,
  cycle: WorkCycle,
  requirements: Requirements,
) {
  const scope = cycle.executionScope;
  if (!scope || !cycle.workItemId)
    return { supported: false, pending: ['No mapped slice dependency context.'] };
  const r = resolveScope(tx, cycle.workspaceId, cycle.workItemId, scope);
  const allowed = r.slice
    ? [...r.slice.start_requires, ...r.slice.merge_requires, ...r.slice.verify_requires]
    : r.parent.acceptance_requires;
  if (
    !requirements.length ||
    requirements.some(
      (req) =>
        !allowed.some((a) => a.kind === req.kind && a.id === req.id && a.state === req.state),
    )
  )
    return {
      supported: false,
      pending: [
        'The design requests a predecessor state absent from this slice’s mapped requirements. Review the proposed planning change.',
      ],
    };
  const pending = requirements
    .filter((req) => {
      if (req.kind === 'work_item')
        return !parentAccepted(
          tx,
          cycle.workspaceId,
          scope.definitionId,
          scope.bindingRevision,
          req.id,
        );
      const slice = r.definition.source.slices.find((s) => s.id === req.id);
      const item = tx.imports
        .bindings(cycle.workspaceId, scope.definitionId)
        .find((b) => b.revision === scope.bindingRevision)
        ?.bindings.flatMap((b) => b.workItems)
        .find((w) => w.sourceId === slice?.work_item);
      if (!item) return true;
      const target = { ...scope, kind: 'slice' as const, sourceId: req.id };
      const integrated = integratedSlice(tx, cycle.workspaceId, item.workItemId, target);
      if (req.state === 'merged') return !integrated?.mergeSha;
      return (
        !acceptedEvidence(tx, cycle.workspaceId, scope.definitionId, scope.bindingRevision, {
          kind: 'slice',
          sourceId: req.id,
        }) &&
        !tx.scopeReceipts
          .list(cycle.workspaceId, item.workItemId)
          .some(
            (receipt) =>
              receipt.scope.definitionId === scope.definitionId &&
              receipt.scope.bindingRevision === scope.bindingRevision &&
              receipt.scope.sourceId === req.id &&
              receipt.scope.kind === 'slice' &&
              !!integrated?.mergeSha &&
              receipt.integrationSha === integrated.mergeSha &&
              currentScopeReceipt(tx, cycle.workspaceId, receipt),
          )
      );
    })
    .map((req) => `${req.id} ${req.state}`);
  return { supported: true, pending };
}
