import type { RoadmapStatusListResponse } from '@craftingtable/contracts';
import {
  asAgentRunId,
  type Roadmap,
  type RoadmapActor,
  type RoadmapEntryProgress,
  type WorkItemId,
} from '@craftingtable/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRefreshOn } from '../../lib/refresh-signals.js';
import { loadRoadmapStatus } from '../../lib/roadmap-api.js';
import { Link } from '../../lib/navigation.js';

/**
 * A roadmap's status list (R-E3a): every open entry, its state, what it waits on and who
 * acts next, grouped by who acts. Read-only: the decisions stay in the inbox. Everything
 * shown is what the daemon recorded; the browser derives nothing.
 */

const STATE_LABELS: Readonly<Record<RoadmapEntryProgress['status'], string>> = {
  queued: 'Queued',
  'dependency-blocked': 'Waiting on prerequisites',
  'capacity-blocked': 'Waiting for capacity',
  'exclusion-blocked': 'Waiting for exclusion group',
  paused: 'Paused',
  running: 'Running',
  'awaiting-merge': 'Awaiting merge',
  'needs-attention': 'Needs attention',
  completed: 'Completed',
};

const GROUPS: readonly {
  readonly actor: Exclude<RoadmapActor, 'none'>;
  readonly title: string;
  readonly className: string;
}[] = [
  { actor: 'operator', title: 'Needs you', className: 'reason-group-you' },
  { actor: 'agent', title: 'Agents at work', className: 'reason-group-automation' },
  {
    actor: 'controller',
    title: 'Waiting on automation or other work',
    className: 'reason-group-other-work',
  },
];

type Entry = RoadmapStatusListResponse['entries'][number];

export function RoadmapStatusList({
  roadmap,
  onOpenWorkItem,
  onOpenAttention,
}: {
  roadmap: Roadmap;
  onOpenWorkItem: (id: WorkItemId) => void;
  onOpenAttention?: (itemId: string) => void;
}) {
  const [status, setStatus] = useState<RoadmapStatusListResponse>();
  const [error, setError] = useState<string>();
  const { workspaceId, id } = roadmap;
  // One request at a time: a round that signals both topics, or a burst of rounds, coalesces
  // into one follow-up request, and an older response never overwrites a newer one.
  const loading = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false });
  const refresh = useCallback(() => {
    const state = loading.current;
    if (state.busy) {
      state.again = true;
      return;
    }
    state.busy = true;
    loadRoadmapStatus({ workspaceId, id })
      .then(
        (loaded) => {
          setStatus(loaded);
          setError(undefined);
        },
        (failure: unknown) =>
          setError(failure instanceof Error ? failure.message : 'Status list is unavailable.'),
      )
      .finally(() => {
        state.busy = false;
        if (state.again) {
          state.again = false;
          refresh();
        }
      });
  }, [workspaceId, id]);
  useEffect(() => refresh(), [refresh]);
  useRefreshOn('roadmaps', refresh);
  useRefreshOn('workspace', refresh);
  if (!status)
    return error ? (
      <p role="alert" className="error-state">
        {error}
      </p>
    ) : (
      <p className="empty-state">Loading status…</p>
    );
  const subject = (entry: Entry) => {
    const waits = entry.waitsOn;
    if (waits?.attentionItemId)
      return (
        <Link
          className="text-button"
          route={{ name: 'inbox', workspaceId, itemId: waits.attentionItemId }}
          onClick={(event) => {
            if (!onOpenAttention) return;
            event.preventDefault();
            onOpenAttention(waits.attentionItemId!);
          }}
        >
          Open in Needs you
        </Link>
      );
    if (waits?.runId)
      return (
        <Link
          className="text-button"
          route={{ name: 'run', workspaceId, runId: asAgentRunId(waits.runId) }}
        >
          Open run
        </Link>
      );
    return null;
  };
  return (
    <section aria-label="Entry status" className="roadmap-status-list">
      <h3>Entry status</h3>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      <p className="subtle">
        {status.entries.length} open · {status.completed} completed. Read-only: act from Needs you.
      </p>
      {status.status !== 'running' && (
        <p role="status" className="warning-state">
          {`The roadmap is ${status.status === 'needs-attention' ? 'stopped for you' : status.status}, so nothing starts until it runs. The waits below are from its last pass.`}
        </p>
      )}
      {status.entries.length === 0 && <p className="reasons-satisfied">Every entry is complete.</p>}
      <div className="reasons">
        {GROUPS.map((group) => {
          const entries = status.entries.filter((entry) => entry.actor === group.actor);
          if (entries.length === 0) return null;
          const list = (
            <ul>
              {entries.map((entry) => (
                <li key={entry.entryId} className="roadmap-status-row">
                  <Link
                    route={{
                      name: 'work-item',
                      workspaceId,
                      workItemId: entry.workItemId,
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenWorkItem(entry.workItemId);
                    }}
                  >
                    <code>{entry.sourceId}</code>
                    {entry.scope === 'item' ? '' : ` · ${entry.scope}`}
                  </Link>
                  <span className="reason-kind">{STATE_LABELS[entry.state]}</span>
                  {entry.waitsOn && <span className="reason-text">{entry.waitsOn.reason}</span>}
                  {entry.waitsOn?.since && (
                    <time className="subtle" dateTime={entry.waitsOn.since}>
                      since {new Date(entry.waitsOn.since).toLocaleString()}
                    </time>
                  )}
                  {subject(entry)}
                </li>
              ))}
            </ul>
          );
          return (
            <div key={group.actor} className={`reason-group ${group.className}`}>
              {group.actor === 'controller' ? (
                <details open={entries.length <= 10}>
                  <summary className="reason-group-title">
                    {group.title} ({entries.length})
                  </summary>
                  {list}
                </details>
              ) : (
                <>
                  <h4 className="reason-group-title">
                    {group.title} ({entries.length})
                  </h4>
                  {list}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
