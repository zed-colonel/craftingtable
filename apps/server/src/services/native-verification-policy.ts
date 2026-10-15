import { snapshotCalculation } from './map-read-snapshot.js';
import { sameRuntimeEnvironments } from './runtime-input-policy.js';
import { nativeHostDigest } from '@craftingtable/agents';
import {
  type ConcurrencyDefinition,
  type ExecutionScope,
  mapResource,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
export function nativeApproval(tx: StorageRepositories, ws: WorkspaceId, scope: ExecutionScope) {
  return snapshotCalculation(
    tx,
    `native:${ws}:${scope.definitionId}:${scope.bindingRevision}`,
    () => {
      const a = tx.runtimeEvidence.nativeApprovals(
        ws,
        scope.definitionId,
        scope.bindingRevision,
      )[0];
      const generations = tx.runtimeEvidence.generations(
        ws,
        scope.definitionId,
        scope.bindingRevision,
      );
      return a?.approved &&
        sameRuntimeEnvironments(
          generations.find((r) => r.id === a.runtimeId),
          generations[0],
        ) &&
        a.hostDigest === nativeHostDigest()
        ? a
        : undefined;
    },
  );
}
/** Whether a slice verifies on a resource the native-host adapter runs (by id, R-F2). */
function verifiesNatively(
  d: ConcurrencyDefinition,
  slice: ConcurrencyDefinition['source']['slices'][number],
) {
  return slice.resources_by_phase.verify.some(
    (id) => mapResource(d.source, id)?.adapter === 'native-test-host',
  );
}
export function needsNativeVerification(d: ConcurrencyDefinition, scope: ExecutionScope) {
  const slice = d.source.slices.find((s) => s.id === scope.sourceId);
  return scope.kind !== 'parent-acceptance' && !!slice && verifiesNatively(d, slice);
}
/** Parent acceptance also freezes the native authority used by its prerequisite evidence. */
export function needsNativeEvidence(d: ConcurrencyDefinition, scope: ExecutionScope): boolean {
  if (scope.kind !== 'parent-acceptance') return needsNativeVerification(d, scope);
  const p = d.source.work_items.find((p) => p.id === scope.sourceId);
  if (!p) return false;
  const producers = new Set([
    ...p.required_slices,
    ...p.profile_evidence_slices,
    ...d.source.acceptance_coverage
      .filter((c) => c.owner_work_item === p.id)
      .flatMap((c) => c.producing_slices),
    ...d.source.baseline_acceptance_coverage
      .filter((c) => c.owner_work_item === p.id)
      .map((c) => c.producing_slice),
  ]);
  return d.source.slices.some((s) => producers.has(s.id) && verifiesNatively(d, s));
}
