import type { RunOverview } from '@craftingtable/contracts';
import type { AgentRunId, WorkItemId } from '@craftingtable/domain';
import type { CSSProperties } from 'react';
import {
  formatCost,
  formatElapsed,
  isLiveStatus,
  RUN_ROLE_LABELS,
  RUN_STATUS_ACCENTS,
  RUN_STATUS_LABELS,
  VERDICT_ACCENTS,
  VERDICT_LABELS,
} from '../../lib/execution-labels.js';

/** One row per run: enough to know what it is doing without opening it. */
export function RunList({
  runs,
  now,
  onOpenRun,
  onOpenWorkItem,
}: {
  runs: readonly RunOverview[];
  now: number;
  onOpenRun: (runId: AgentRunId) => void;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
}) {
  if (runs.length === 0) {
    return <p className="empty-state">No runs yet.</p>;
  }
  return (
    <ol className="run-list">
      {runs.map((run) => {
        const live = isLiveStatus(run.status);
        return (
          <li key={run.id} className="run-row">
            <span
              className={`status-badge${live ? ' pulse' : ''}`}
              style={{ '--badge-accent': RUN_STATUS_ACCENTS[run.status] } as CSSProperties}
            >
              {RUN_STATUS_LABELS[run.status]}
            </span>
            <div className="run-row-main">
              <span className="run-row-title">
                <button type="button" className="link-button" onClick={() => onOpenRun(run.id)}>
                  {RUN_ROLE_LABELS[run.role]} · {run.workItemSourceId} {run.workItemTitle}
                </button>
              </span>
              <span className="run-row-meta">
                {run.projectName} · <span className="mono">{run.branchName}</span> ·{' '}
                {run.resolvedModel ?? run.model ?? 'default model'} · {run.turnCount} turn
                {run.turnCount === 1 ? '' : 's'} · {formatCost(run.costUsd, run.billing)} ·{' '}
                {live
                  ? `${formatElapsed(run.createdAt, undefined, now)} so far`
                  : `${formatElapsed(run.createdAt, run.finishedAt, now)}`}
                {run.verdict !== undefined && (
                  <>
                    {' · '}
                    <span
                      className="status-badge"
                      style={{ '--badge-accent': VERDICT_ACCENTS[run.verdict] } as CSSProperties}
                    >
                      {VERDICT_LABELS[run.verdict]}
                    </span>
                  </>
                )}
              </span>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => onOpenWorkItem(run.workItemId)}
            >
              Work item
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function RunsPage({
  runs,
  liveCount,
  now,
  onOpenRun,
  onOpenWorkItem,
}: {
  runs: readonly RunOverview[];
  liveCount: number;
  now: number;
  onOpenRun: (runId: AgentRunId) => void;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
}) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Runs</h1>
          <p className="subtitle">
            {liveCount === 0
              ? 'No agent is working right now.'
              : `${liveCount} live run${liveCount === 1 ? '' : 's'}; live runs are listed first.`}
          </p>
        </div>
      </header>
      <section className="panel" aria-label="Runs">
        <RunList runs={runs} now={now} onOpenRun={onOpenRun} onOpenWorkItem={onOpenWorkItem} />
      </section>
    </div>
  );
}
