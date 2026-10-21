/**
 * Whether a map milestone (a checkpoint, a work item's acceptance, a slice started, merged or
 * verified) is met: policy over the read snapshot, outside every service, so the services that
 * ask it import no service for it (R-B7: no import cycles).
 */
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
  if (r.kind === 'work_item')
    return (
      !!boundWorkItem(tx, ws, d, revision, r.id) && parentAccepted(tx, ws, d.id, revision, r.id)
    );
  return sliceRequirementMet(tx, ws, d, revision, r.id, r.state);
}
/**
 * Whether a slice is started, merged or verified (R-B7, CTRL-14): the one rule the milestone and
 * the scope's phase gate ask. A slice whose work item the binding does not bind is never met
 * (operator decision 3 A; such a binding cannot reach a roadmap or a scope).
 */
export function sliceRequirementMet(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  sliceId: string,
  state: ConcurrencyRequirement['state'],
): boolean {
  const id = boundWorkItem(
    tx,
    ws,
    d,
    revision,
    d.source.slices.find((s) => s.id === sliceId)?.work_item,
  );
  if (!id) return false;
  const scope = {
    kind: 'slice' as const,
    definitionId: d.id,
    bindingRevision: revision,
    sourceId: sliceId,
  };
  const trees = tx.execution.worktrees
    .listForWorkItem(ws, id)
    .filter((t) => sameExecutionScope(t.executionScope, scope));
  const integrated = integratedSlice(tx, ws, id, scope);
  if (state === 'started')
    return (
      !!integrated ||
      tx.execution.runs.startedIn(
        ws,
        trees.map((t) => t.id),
      )
    );
  if (state === 'merged') return !!integrated?.mergeSha;
  return (
    !!acceptedEvidence(tx, ws, d.id, revision, { kind: 'slice', sourceId: sliceId }) ||
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
/** The work item the binding's revision binds to a map work item, if any. */
function boundWorkItem(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  sourceId: string | undefined,
) {
  const b = tx.imports.bindings(ws, d.id).find((b) => b.revision === revision);
  return b?.bindings.flatMap((b) => b.workItems).find((w) => w.sourceId === sourceId)?.workItemId;
}
