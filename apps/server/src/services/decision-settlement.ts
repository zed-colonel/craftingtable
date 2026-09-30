import type { ConcurrencyDefinition, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { approvedArchitectureDecisions } from './architecture-decision-policy.js';
import { milestoneSatisfied } from './cross-project-service.js';
import { acceptedEvidence, parentAccepted } from './runtime-evidence-policy.js';

/**
 * Which slices a shared architecture decision is settled for, and which work still needs it
 * (LIVE-22). A consumer is a slice whose start, merge or verification requires the checkpoint,
 * or a work item whose acceptance does. The checkpoint's accepted evidence settles every
 * consumer, as at each gate. Otherwise a slice is settled by the binding's accepted clause-level
 * decision when that names it, the rule `stagedDecision` applies (one clause record per
 * checkpoint, the newest); a work item's acceptance never is. A consumer still needs the
 * decision until it is settled or has passed every gate that checks it: a slice's start
 * requirements are checked again at merge and verification, so a slice passes only once
 * verified, and a work item once accepted.
 */
export function decisionSettlement(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  checkpointId: string,
): { readonly settledFor: readonly string[]; readonly stillNeededBy: readonly string[] } {
  const requires = (r: { readonly kind: string; readonly id: string }) =>
    r.kind === 'checkpoint' && r.id === checkpointId;
  const slices = d.source.slices
    .filter((s) => [...s.start_requires, ...s.merge_requires, ...s.verify_requires].some(requires))
    .map((s) => s.id);
  const parents = d.source.work_items
    .filter((p) => p.acceptance_requires.some(requires))
    .map((p) => p.id);
  if (acceptedEvidence(tx, ws, d.id, revision, { kind: 'checkpoint', sourceId: checkpointId }))
    return { settledFor: [...slices, ...parents], stillNeededBy: [] };
  const clauses = approvedArchitectureDecisions(tx, ws, d.id, revision).find(
    (s) => s.subject.sourceId === checkpointId && s.architectureDecision?.coverage === 'clauses',
  );
  const named = new Set(clauses?.architectureDecision?.consumers.map((c) => c.sliceId));
  return {
    settledFor: slices.filter((id) => named.has(id)),
    stillNeededBy: [
      ...slices.filter(
        (id) =>
          !named.has(id) &&
          !milestoneSatisfied(tx, ws, d, revision, { kind: 'slice', id, state: 'verified' }),
      ),
      ...parents.filter((id) => !parentAccepted(tx, ws, d.id, revision, id)),
    ],
  };
}

/**
 * What a shared decision's item says of the work it serves (LIVE-22): the selected slices it is
 * settled for, and the selected work that still needs it. Nothing to add when nothing selected
 * is settled or needs it directly (it is needed through another milestone).
 */
export function settlementLines(
  settlement: ReturnType<typeof decisionSettlement>,
  selected: ReadonlySet<string>,
): string | undefined {
  const settled = settlement.settledFor.filter((id) => selected.has(id));
  const needed = settlement.stillNeededBy.filter((id) => selected.has(id));
  if (!needed.length && !settled.length) return undefined;
  return [
    ...(settled.length ? [`Settled for: ${settled.join(', ')}`] : []),
    needed.length
      ? `Still needed by: ${needed.join(', ')}`
      : 'Still needed by later work that depends on it through other milestones.',
  ].join('\n');
}
