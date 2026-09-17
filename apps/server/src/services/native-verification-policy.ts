import { snapshotCalculation } from './map-read-snapshot.js';
import { nativeHostDigest } from '@craftingtable/agents';
import type { ExecutionScope, ConcurrencyDefinition } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
export function nativeApproval(tx: StorageRepositories, ws: string, scope: ExecutionScope) {
  return snapshotCalculation(
    tx,
    `native:${ws}:${scope.definitionId}:${scope.bindingRevision}`,
    () => {
      const a = tx.runtimeEvidence.nativeApprovals(
        ws,
        scope.definitionId,
        scope.bindingRevision,
      )[0];
      const runtime = tx.runtimeEvidence.generations(
        ws,
        scope.definitionId,
        scope.bindingRevision,
      )[0];
      return a?.approved && a.runtimeId === runtime?.id && a.hostDigest === nativeHostDigest()
        ? a
        : undefined;
    },
  );
}
export function needsNativeVerification(d: ConcurrencyDefinition, scope: ExecutionScope) {
  return (
    scope.kind !== 'parent-acceptance' &&
    !!d.source.slices
      .find((s) => s.id === scope.sourceId)
      ?.resources_by_phase.verify.includes('controlled-native-test-host')
  );
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
  return d.source.slices.some(
    (s) =>
      producers.has(s.id) && s.resources_by_phase.verify.includes('controlled-native-test-host'),
  );
}
