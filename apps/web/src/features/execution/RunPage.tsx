import type {
  AgentRunDetailResponse,
  RunEventEnvelope,
  WorktreeDiffResponse,
} from '@craftingtable/contracts';
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react';
import {
  formatCost,
  isLiveStatus,
  PERMISSION_MODE_LABELS,
  RUN_ROLE_LABELS,
  RUN_STATUS_ACCENTS,
  RUN_STATUS_LABELS,
  shortSha,
} from '../../lib/execution-labels.js';
import type { ConnectionState } from '../../lib/workspace-projection.js';
import { DiffView } from './DiffView.js';

function eventTitle(event: RunEventEnvelope): string {
  switch (event.kind) {
    case 'session-started':
      return `Session started · ${event.payload.model}`;
    case 'user-message':
      return 'You';
    case 'assistant-message':
      return 'Agent';
    case 'tool-call':
      return `${event.payload.name}: ${event.payload.summary}`;
    case 'tool-result':
      return event.payload.isError ? 'Tool error' : 'Tool result';
    case 'turn-completed':
      return event.payload.outcome === 'success' ? 'Turn completed' : 'Turn ended with an error';
    case 'notice':
      return `Notice (${event.payload.category})`;
    case 'stderr':
      return 'Backend stderr';
    case 'run-finished':
      return `Run ${RUN_STATUS_LABELS[event.payload.status].toLowerCase()}`;
  }
}

function eventBody(event: RunEventEnvelope): string | undefined {
  switch (event.kind) {
    case 'session-started':
      return `${event.payload.backend} session ${event.payload.backendSessionId} in ${event.payload.cwd}`;
    case 'user-message':
    case 'assistant-message':
    case 'stderr':
      return event.payload.text;
    case 'tool-call':
      return JSON.stringify(event.payload.input, null, 2);
    case 'tool-result':
      return event.payload.content;
    case 'turn-completed':
      return `${event.payload.resultText}\n\nturns: ${event.payload.turns} · duration: ${(event.payload.durationMs / 1000).toFixed(1)}s${event.payload.costUsd === undefined ? '' : ` · cost so far: ${formatCost(event.payload.costUsd)}`}`;
    case 'notice':
      return event.payload.message;
    case 'run-finished':
      return (
        event.payload.message ??
        (event.payload.exitCode === undefined ? undefined : `exit code ${event.payload.exitCode}`)
      );
  }
}

const COLLAPSED_KINDS = new Set<RunEventEnvelope['kind']>(['tool-call', 'tool-result', 'stderr']);

function RunEventItem({ event }: { event: RunEventEnvelope }) {
  const body = eventBody(event);
  const collapsed = COLLAPSED_KINDS.has(event.kind);
  return (
    <li className={`run-event run-event-${event.kind}`}>
      <div className="run-event-head">
        <span className="run-event-title">{eventTitle(event)}</span>
        <time className="activity-time" dateTime={event.occurredAt}>
          {new Date(event.occurredAt).toLocaleTimeString()}
        </time>
      </div>
      {body !== undefined &&
        body.length > 0 &&
        (collapsed ? (
          <details className="run-event-details">
            <summary>{body.split('\n')[0]?.slice(0, 160)}</summary>
            <pre className="run-event-body">{body}</pre>
          </details>
        ) : (
          <pre className="run-event-body run-event-prose">{body}</pre>
        ))}
    </li>
  );
}

export function RunPage({
  detail,
  events,
  connection,
  diff,
  canMutate,
  busy,
  error,
  onSend,
  onEnd,
  onCancel,
  onOpenWorkItem,
  onLoadDiff,
  onCloseDiff,
}: {
  detail: AgentRunDetailResponse;
  events: readonly RunEventEnvelope[];
  connection: ConnectionState;
  diff?: WorktreeDiffResponse;
  canMutate: boolean;
  busy: boolean;
  error?: string;
  onSend: (text: string) => void;
  onEnd: () => void;
  onCancel: () => void;
  onOpenWorkItem: () => void;
  onLoadDiff: () => void;
  onCloseDiff: () => void;
}) {
  const { run, worktree } = detail;
  const live = isLiveStatus(run.status);
  const [draft, setDraft] = useState('');
  const [showBrief, setShowBrief] = useState(false);
  const [follow, setFollow] = useState(true);
  const feedEnd = useRef<HTMLDivElement>(null);

  // Scrolls on every new event while following; the length is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate scroll trigger
  useEffect(() => {
    if (follow) {
      feedEnd.current?.scrollIntoView({ block: 'end' });
    }
  }, [follow, events.length]);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    onSend(text);
    setDraft('');
  };

  return (
    <div className="planning-page">
      <header className="page-header run-header">
        <div>
          <h2>
            {RUN_ROLE_LABELS[run.role]} run ·{' '}
            <button type="button" className="link-button" onClick={onOpenWorkItem}>
              back to work item
            </button>
          </h2>
          <p className="subtitle mono">
            {worktree.branchName} · {worktree.path}
          </p>
        </div>
        <span
          className="readiness-badge run-status"
          style={{ '--badge-accent': RUN_STATUS_ACCENTS[run.status] } as CSSProperties}
        >
          {RUN_STATUS_LABELS[run.status]}
        </span>
      </header>

      <section className="panel" aria-label="Run summary">
        <dl className="definition-grid">
          <dt>Backend</dt>
          <dd>
            {run.backend}
            {run.model === undefined ? '' : ` · ${run.model}`}
            {run.backendSessionId === undefined ? '' : ` · session ${run.backendSessionId}`}
          </dd>
          <dt>Permissions</dt>
          <dd>{PERMISSION_MODE_LABELS[run.permissionMode]}</dd>
          <dt>Base</dt>
          <dd className="mono">
            {worktree.baseBranch} @ {shortSha(worktree.baseSha)}
          </dd>
          <dt>Turns</dt>
          <dd>{run.turnCount}</dd>
          <dt>Cost</dt>
          <dd>{formatCost(run.costUsd)}</dd>
          <dt>Started</dt>
          <dd>{run.startedAt === undefined ? '—' : new Date(run.startedAt).toLocaleString()}</dd>
          {run.finishedAt !== undefined && (
            <>
              <dt>Finished</dt>
              <dd>{new Date(run.finishedAt).toLocaleString()}</dd>
            </>
          )}
          {run.outcomeSummary !== undefined && (
            <>
              <dt>Latest outcome</dt>
              <dd className="outcome-cell">{run.outcomeSummary}</dd>
            </>
          )}
        </dl>
        <div className="inline-actions run-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => setShowBrief((value) => !value)}
          >
            {showBrief ? 'Hide brief' : 'Show brief'}
          </button>
          <button type="button" className="text-button" onClick={onLoadDiff}>
            {diff === undefined ? 'View diff' : 'Refresh diff'}
          </button>
          {live && canMutate && (
            <>
              <button type="button" className="secondary-button" onClick={onEnd} disabled={busy}>
                End session
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel run
              </button>
            </>
          )}
        </div>
        {showBrief && (
          <pre className="source-text" data-testid="run-brief">
            {detail.brief}
          </pre>
        )}
      </section>

      {diff !== undefined && <DiffView diff={diff} onClose={onCloseDiff} />}

      <section className="panel" aria-label="Run activity">
        <header className="panel-header">
          <h3>Activity ({events.length})</h3>
          <label className="follow-toggle">
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
            />
            Follow
          </label>
        </header>
        {live && connection === 'disconnected' && (
          <p className="error-state" role="alert">
            The live stream is unreachable; reconnection continues automatically. Events already
            committed remain visible.
          </p>
        )}
        {events.length === 0 ? (
          <p className="empty-state">Waiting for the first event…</p>
        ) : (
          <ol className="run-event-list">
            {events.map((event) => (
              <RunEventItem key={event.id} event={event} />
            ))}
          </ol>
        )}
        <div ref={feedEnd} />
      </section>

      {live && canMutate && (
        <section className="panel" aria-label="Send a message">
          <form className="stack-form" onSubmit={send}>
            <label className="field">
              Message to the agent
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                placeholder={
                  run.status === 'waiting'
                    ? 'The agent finished its turn and is waiting. Give it the next instruction, or end the session.'
                    : 'The agent is working. A message sent now is queued for its next turn.'
                }
                disabled={busy}
                maxLength={50000}
              />
            </label>
            {error !== undefined && (
              <p className="error-state" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="primary-button"
              disabled={busy || draft.trim().length === 0}
            >
              Send
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
