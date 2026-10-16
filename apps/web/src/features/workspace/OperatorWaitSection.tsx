import type { AttentionItemView, OperatorWaitReportResponse } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { useEffect, useRef, useState } from 'react';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { loadOperatorWait } from '../../lib/workspace-api.js';

/** Display text for a stop kind; the code itself is what the daemon routes on. */
function kindLabel(kind: string): string {
  const words = kind.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const hours = (value: number) => `${value.toFixed(1)} h`;

/**
 * What the report is reloaded on: a cycle entering or leaving a stop, a stop changing code or
 * owner, and a Needs-you item opening or closing, which is how a roadmap's own stop or an entry's
 * hold shows (R-C10's follow-up).
 */
export function operatorWaitRefreshKey(
  cycles: readonly Pick<WorkCycle, 'id' | 'status' | 'attention'>[],
  items: readonly Pick<AttentionItemView, 'id' | 'code'>[],
): string {
  const stops = cycles.map(
    (cycle) =>
      `${cycle.id}:${cycle.status}:${cycle.attention?.code ?? ''}:${cycle.attention?.owner ?? ''}`,
  );
  return [...stops, ...items.map((item) => `${item.id}:${item.code}`)].join(',');
}

/** A report older than this is reloaded when the tab becomes visible again. */
const STALE_MS = 5 * 60_000;

/**
 * How long work waited on the operator over the last week, and which stops cost the most
 * (R-C1). It reloads when a stop begins or ends and when a hidden tab returns after a
 * while, not on every workspace event and not on a timer, so an idle tab makes no requests. The time it was measured is shown, since an open stop keeps accruing.
 */
export function OperatorWaitSection({
  workspaceId,
  refreshKey,
}: {
  workspaceId: string;
  /** Changes when a stop begins, ends or changes code or owner (`operatorWaitRefreshKey`). */
  refreshKey: string;
}) {
  const [report, setReport] = useState<OperatorWaitReportResponse>();
  const [error, setError] = useState<string>();
  const [returns, setReturns] = useState(0);
  const measuredAt = useRef<string>(undefined);
  measuredAt.current = report?.to;
  useEffect(() => {
    const visible = () => {
      const at = measuredAt.current;
      if (document.visibilityState === 'visible' && at && Date.now() - Date.parse(at) > STALE_MS)
        setReturns((n) => n + 1);
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  useEffect(() => {
    void refreshKey;
    void returns;
    let alive = true;
    void loadOperatorWait(workspaceId, 7)
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
  }, [workspaceId, refreshKey, returns]);

  const top = report?.kinds.slice(0, 5) ?? [];
  return (
    <Section
      title="Operator wait"
      summary={
        report
          ? `Last 7 days: ${hours(report.idleWaitingHours)} with work waiting on you and no agent running (as of ${new Date(report.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).`
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
