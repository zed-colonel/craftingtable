import type { ConcurrencyDefinition, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { approvedArchitectureDecisions } from './architecture-decision-policy.js';
import { milestoneSatisfied } from './cross-project-service.js';

/**
 * Which slices a shared architecture decision is settled for, and which still need it
 * (LIVE-22). A consumer is a slice whose start, merge or verification requires the checkpoint.
 * It is settled by an accepted full decision, or by the accepted clause-level decision on the
 * binding when that names it: the rule `stagedDecision` applies at each gate. A consumer still
 * needs the decision until it is settled or the phase that required it has passed.
 */
export function decisionSettlement(
  tx: StorageRepositories,
  ws: WorkspaceId,
  d: ConcurrencyDefinition,
  revision: number,
  checkpointId: string,
): { readonly settledFor: readonly string[]; readonly stillNeededBy: readonly string[] } {
  const approved = approvedArchitectureDecisions(tx, ws, d.id, revision).filter(
    (s) => s.subject.sourceId === checkpointId,
  );
  const full = approved.some((s) => s.architectureDecision?.coverage === 'full');
  const clauses = approved.find((s) => s.architectureDecision?.coverage === 'clauses');
  const named = new Set(clauses?.architectureDecision?.consumers.map((c) => c.sliceId));
  const consumers = d.source.slices.flatMap((s) =>
    (['start', 'merge', 'verify'] as const).flatMap((phase) =>
      s[`${phase}_requires`].some((r) => r.kind === 'checkpoint' && r.id === checkpointId)
        ? [{ sliceId: s.id, phase }]
        : [],
    ),
  );
  const settledFor = [
    ...new Set(consumers.filter((c) => full || named.has(c.sliceId)).map((c) => c.sliceId)),
  ];
  const stillNeededBy = [
    ...new Set(
      consumers
        .filter(
          (c) =>
            !full &&
            !named.has(c.sliceId) &&
            !milestoneSatisfied(tx, ws, d, revision, {
              kind: 'slice',
              id: c.sliceId,
              state: c.phase === 'start' ? 'started' : c.phase === 'merge' ? 'merged' : 'verified',
            }),
        )
        .map((c) => c.sliceId),
    ),
  ];
  return { settledFor, stillNeededBy };
}
