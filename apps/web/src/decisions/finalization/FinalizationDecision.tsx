import type { ExecutionStatusResponse, FinalizationView } from '@craftingtable/contracts';
import type { AgentRunId, PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { useEffect, useState } from 'react';
import { loadExecutionStatus } from '../../lib/execution-api.js';
import { loadFinalizations } from '../../lib/finalization-api.js';
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
  csrfToken,
  canMutate,
  refreshToken,
  onChanged,
  onOpenRun,
}: {
  workspaceId: WorkspaceId;
  planVersionId: PlanVersionId;
  finalizationId?: string;
  cycleId?: string;
  csrfToken: string;
  canMutate: boolean;
  refreshToken: number;
  onChanged: () => void;
  onOpenRun: (id: AgentRunId) => void;
}) {
  const [view, setView] = useState<FinalizationView | null>();
  const [backends, setBackends] = useState<ExecutionStatusResponse['backends']>([]);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on daemon events and own commands.
  useEffect(() => {
    let alive = true;
    void loadFinalizations(workspaceId, planVersionId)
      .then((result) => {
        if (!alive) return;
        setView(
          result.finalizations.find(
            (v) => v.finalization.id === finalizationId || v.finalization.cycleId === cycleId,
          ) ?? null,
        );
      })
      .catch(() => {
        if (alive) setView(null);
      });
    void loadExecutionStatus()
      .then((status) => {
        if (alive) setBackends(status.backends);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspaceId, planVersionId, finalizationId, cycleId, refreshToken, reload]);
  if (view === undefined) return <p className="empty-state">Loading the finalization…</p>;
  if (view === null)
    return <p className="empty-state">This finalization could not be loaded. Reload the page.</p>;
  const done = () => {
    setReload((v) => v + 1);
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
