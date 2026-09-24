import {
  type OperatorWaitReportResponse,
  operatorWaitReportSchema,
} from '@craftingtable/contracts';
import { useEffect, useState } from 'react';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { request } from '../../lib/api-client.js';

/** Display text for a stop kind; the code itself is what the daemon routes on. */
function kindLabel(kind: string): string {
  const words = kind.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const hours = (value: number) => `${value.toFixed(1)} h`;

/**
 * How long work waited on the operator over the last week, and which stops cost the most
 * (R-C1). It reloads when a cycle changes status, not on every workspace event.
 */
export function OperatorWaitSection({
  workspaceId,
  refreshKey,
}: {
  workspaceId: string;
  /** Changes when any cycle enters or leaves a stop. */
  refreshKey: string;
}) {
  const [report, setReport] = useState<OperatorWaitReportResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void refreshKey;
    let alive = true;
    void request(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/operator-wait?days=7`,
      operatorWaitReportSchema,
    )
      .then((value) => {
        if (!alive) return;
        setReport(value);
        setError(undefined);
      })
      .catch((value) => {
        if (alive)
          setError(value instanceof Error ? value.message : 'Operator wait could not be loaded.');
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, refreshKey]);

  const top = report?.kinds.slice(0, 5) ?? [];
  return (
    <Section
      title="Operator wait"
      summary={
        report
          ? `Last 7 days: ${hours(report.idleWaitingHours)} with work waiting on you and no agent running.`
          : undefined
      }
      collapsible
    >
      {error && (
        <p className="warning-state" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <StatusStrip
            label="Operator wait over the last 7 days"
            facts={[
              { label: 'Waiting, no agent running', value: hours(report.idleWaitingHours) },
              { label: 'Waiting on you', value: hours(report.waitingHours) },
              { label: 'Agents running', value: hours(report.agentHours) },
            ]}
          />
          {top.length === 0 ? (
            <p className="empty-state">Nothing waited on you in the last 7 days.</p>
          ) : (
            <ul className="plain-list" aria-label="Stops that cost the most waiting">
              {top.map((entry) => (
                <li key={entry.kind}>
                  <StatusStrip
                    compact
                    facts={[
                      { label: 'Stop', value: kindLabel(entry.kind) },
                      { label: 'Stops', value: entry.stops, mono: true },
                      { label: 'Cycle-hours', value: entry.cycleHours.toFixed(1), mono: true },
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}
