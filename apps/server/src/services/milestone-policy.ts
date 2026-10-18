import {
  type ConcurrencyDefinition,
  type ConcurrencyRequirement,
  sameExecutionScope,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { snapshotCalculation } from './map-read-snapshot.js';
import {
  acceptedEvidence,
  currentScopeReceipt,
  parentAccepted,
} from './runtime-evidence-policy.js';
import { integratedSlice } from './scope-lineage.js';

/**
 * Whether a map milestone (a checkpoint, a work item's acceptance, a slice started, merged or
 * verified) is met: policy over the read snapshot, outside every service, so the services that
 * ask it import no service for it (R-B7: no import cycles).
 */

export function milestoneSatisfied(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  r: ConcurrencyRequirement,
): boolean {
  // Asked once per read snapshot: the map evaluation and each entry's completion in a roadmap
  // read ask for the same milestones (R-D8).
  return snapshotCalculation(tx, milestoneMemoKey(ws, d, revision, r), () =>
    milestoneMet(tx, ws, d, revision, r),
  );
}
/** The memo key of `milestoneSatisfied`: the definition, revision and requirement (R-D8). */
export function milestoneMemoKey(
  ws: WorkspaceId,
  d: Pick<ConcurrencyDefinition, 'id' | 'digest'>,
  revision: number,
  r: Pick<ConcurrencyRequirement, 'kind' | 'id' | 'state'>,
): string {
  return JSON.stringify([
    'milestone-satisfied',
    ws,
    d.id,
    d.digest,
    revision,
    r.kind,
    r.id,
    r.state,
  ]);
}
export function milestoneMet(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  r: ConcurrencyRequirement,
): boolean {
  if (r.kind === 'checkpoint')
    return !!acceptedEvidence(tx, ws, d.id, revision, { kind: 'checkpoint', sourceId: r.id });
  const b = tx.imports.bindings(ws, d.id).find((b) => b.revision === revision);
  const parent =
    r.kind === 'work_item' ? r.id : d.source.slices.find((s) => s.id === r.id)?.work_item;
  const id = b?.bindings.flatMap((b) => b.workItems).find((w) => w.sourceId === parent)?.workItemId;
  if (!id) return false;
  if (r.kind === 'work_item') return parentAccepted(tx, ws, d.id, revision, r.id);
  const scope = {
    kind: 'slice' as const,
    definitionId: d.id,
    bindingRevision: revision,
    sourceId: r.id,
  };
  const trees = tx.execution.worktrees
    .listForWorkItem(ws, id)
    .filter((t) => sameExecutionScope(t.executionScope, scope));
  const integrated = integratedSlice(tx, ws, id, scope);
  if (r.state === 'started')
    return (
      !!integrated ||
      tx.execution.runs.startedIn(
        ws,
        trees.map((t) => t.id),
      )
    );
  if (r.state === 'merged') return !!integrated?.mergeSha;
  return (
    !!acceptedEvidence(tx, ws, d.id, revision, { kind: 'slice', sourceId: r.id }) ||
    tx.scopeReceipts
      .list(ws, id)
      .some(
        (p) =>
          sameExecutionScope(p.scope, scope) &&
          currentScopeReceipt(tx, ws, p) &&
          integrated?.mergeSha === p.integrationSha,
      )
  );
}
