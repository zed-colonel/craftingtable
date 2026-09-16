import type { RunOverview } from '@craftingtable/contracts';
import type { AgentRunId, WorkItemId } from '@craftingtable/domain';
import type { CSSProperties } from 'react';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
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
              <StatusStrip
                compact
                facts={[
                  { label: 'Project', value: run.projectName },
                  { label: 'Branch', value: run.branchName, mono: true },
                  {
                    label: 'Model',
                    value: run.resolvedModel ?? run.model ?? 'default',
                    mono: true,
                  },
                  { label: 'Turns', value: run.turnCount, mono: true },
                  { label: 'Cost', value: formatCost(run.costUsd, run.billing), mono: true },
                  {
                    label: live ? 'Running for' : 'Took',
                    value: live
                      ? formatElapsed(run.createdAt, undefined, now)
                      : formatElapsed(run.createdAt, run.finishedAt, now),
                    mono: true,
                  },
                  ...(run.verdict === undefined
                    ? []
                    : [
                        {
                          label: 'Verdict',
                          value: VERDICT_LABELS[run.verdict],
                          accent: VERDICT_ACCENTS[run.verdict],
                        },
                      ]),
                ]}
              />
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => (run.workItemId ? onOpenWorkItem(run.workItemId) : onOpenRun(run.id))}
            >
              {run.workItemId ? 'Work item' : 'Finalization run'}
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
      <PageHeader
        title="Runs"
        subtitle={
          liveCount === 0
            ? 'No agent is working right now.'
            : `${liveCount} live run${liveCount === 1 ? '' : 's'}; live runs are listed first.`
        }
      />
      <Section title="Run history" label="Runs" count={runs.length}>
        <RunList runs={runs} now={now} onOpenRun={onOpenRun} onOpenWorkItem={onOpenWorkItem} />
      </Section>
    </div>
  );
}
