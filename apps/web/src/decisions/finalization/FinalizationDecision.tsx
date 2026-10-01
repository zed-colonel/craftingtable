import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import type { AgentRunId, PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { loadExecutionStatus } from '../../lib/execution-api.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { loadFinalizations } from '../../lib/finalization-api.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { IntegrationConflict } from '../integration/IntegrationConflict.js';
import { FinalizationStep } from './FinalizationStep.js';
import { FinalPromotion } from './FinalPromotion.js';

/**
 * A finalization's inbox item (R-A6 increment 2b): its promotion, its next step and its
 * integration conflict, as the daemon offers them, without the rest of the plan's
 * finalization panel.
 */
export function FinalizationDecision({
  workspaceId,
  planVersionId,
  finalizationId,
  cycleId,
  worktreeId,
  csrfToken,
  canMutate,
  onChanged,
  onOpenRun,
}: {
  workspaceId: WorkspaceId;
  planVersionId: PlanVersionId;
  finalizationId?: string;
  cycleId?: string;
  /** A merge item names only the finalization's worktree, and no cycle once it has ended. */
  worktreeId?: string;
  csrfToken: string;
  canMutate: boolean;
  onChanged: () => void;
  onOpenRun: (id: AgentRunId) => void;
}) {
  // The plan's finalizations, shared with its finalization panel, read again on their events.
  const store = useQueryStore();
  const key = queryKeys.finalizations(workspaceId, planVersionId);
  const query = useQuery(key, () => loadFinalizations(workspaceId, planVersionId));
  const view =
    query.status === 'error'
      ? null
      : query.data === undefined
        ? undefined
        : (query.data.finalizations.find(
            (v) =>
              (finalizationId !== undefined && v.finalization.id === finalizationId) ||
              (cycleId !== undefined && v.finalization.cycleId === cycleId) ||
              (worktreeId !== undefined && v.finalization.worktreeId === worktreeId),
          ) ?? null);
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  useEffect(() => {
    let alive = true;
    void loadExecutionStatus()
      .then((status) => {
        if (alive) setBackends(status.backends);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (view === undefined) return <p className="empty-state">Loading the finalization…</p>;
  if (view === null)
    return <p className="empty-state">This finalization could not be loaded. Reload the page.</p>;
  const done = () => {
    store.refreshNow([key]);
    onChanged();
  };
  if (!canMutate) return null;
  return (
    <>
      <FinalPromotion
        workspaceId={workspaceId}
        view={view}
        csrfToken={csrfToken}
        disabled={false}
        onDone={done}
      />
      <FinalizationStep
        key={`${view.finalization.id}:${view.cycle?.version}`}
        workspaceId={workspaceId}
        view={view}
        csrfToken={csrfToken}
        disabled={false}
        backends={backends}
        onDone={done}
      />
      {view.cycle && view.finalization.status === 'active' && (
        <IntegrationConflict
          cycle={view.cycle}
          backends={backends}
          disabled={false}
          canMutate={canMutate}
          csrfToken={csrfToken}
          onChanged={done}
          offerInspect={false}
          onOpenRun={onOpenRun}
          runIds={view.runs.map((r) => r.id)}
        />
      )}
    </>
  );
}
