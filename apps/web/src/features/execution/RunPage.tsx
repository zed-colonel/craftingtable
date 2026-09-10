import type {
  AgentRunDetailResponse,
  AgentRunSummary,
  ExecutionStatusResponse,
  RunEventEnvelope,
  WorktreeDiffResponse,
} from '@craftingtable/contracts';
import { AGENT_BACKEND_LABELS } from '@craftingtable/domain';
import {
  type CSSProperties,
  type FormEvent,
  type UIEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BILLING_LABELS,
  formatCost,
  isLiveStatus,
  PERMISSION_MODE_LABELS,
  RUN_ROLE_LABELS,
  RUN_STATUS_ACCENTS,
  RUN_STATUS_LABELS,
  shortSha,
  VERDICT_ACCENTS,
  VERDICT_LABELS,
} from '../../lib/execution-labels.js';
import type { ConnectionState } from '../../lib/workspace-projection.js';
import { DiffView } from './DiffView.js';
import {
  handoffDefaults,
  handoffTarget,
  type LaunchInput,
  previousImplementerHint,
  type ProfileEntry,
} from './handoff.js';
import { HandoffForm } from './HandoffForm.js';

type EventGroup = 'messages' | 'tools' | 'notices' | 'system';

const GROUP_OF: Readonly<Record<RunEventEnvelope['kind'], EventGroup>> = {
  'user-message': 'messages',
  'assistant-message': 'messages',
  'turn-completed': 'messages',
  'tool-call': 'tools',
  'tool-result': 'tools',
  notice: 'notices',
  stderr: 'notices',
  'session-started': 'system',
  'run-finished': 'system',
};

const GROUP_LABELS: Readonly<Record<EventGroup, string>> = {
  messages: 'Messages',
  tools: 'Tools',
  notices: 'Notices',
  system: 'System',
};

const GROUPS: readonly EventGroup[] = ['messages', 'tools', 'notices', 'system'];

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
      return `${event.payload.backend} session ${event.payload.backendSessionId} (${
        BILLING_LABELS[event.payload.billing]
      }) in ${event.payload.cwd}`;
    case 'user-message':
    case 'assistant-message':
    case 'stderr':
      return event.payload.text;
    case 'tool-call':
      return JSON.stringify(event.payload.input, null, 2);
    case 'tool-result':
      return event.payload.content;
    case 'turn-completed':
      return `${event.payload.resultText}\n\nturns: ${event.payload.turns} · duration: ${(
        event.payload.durationMs / 1000
      ).toFixed(1)}s${
        event.payload.costUsd === undefined
          ? ''
          : ` · cost so far: $${event.payload.costUsd.toFixed(2)}`
      }${event.payload.tokenUsage === undefined ? '' : ` · tokens: ${event.payload.tokenUsage.totalTokens.toLocaleString()} (${event.payload.tokenUsage.inputTokens.toLocaleString()} input, ${event.payload.tokenUsage.cachedInputTokens.toLocaleString()} cached, ${event.payload.tokenUsage.outputTokens.toLocaleString()} output)`}`;
    case 'notice':
      return event.payload.message;
    case 'run-finished':
      return (
        event.payload.message ??
        (event.payload.exitCode === undefined ? undefined : `exit code ${event.payload.exitCode}`)
      );
  }
}

/** Tool traffic and the brief itself are collapsed; conversation stays open. */
const COLLAPSED_KINDS = new Set<RunEventEnvelope['kind']>([
  'tool-call',
  'tool-result',
  'stderr',
  'user-message',
]);

function RunEventItem({ event, expanded }: { event: RunEventEnvelope; expanded: boolean }) {
  const body = eventBody(event);
  const collapsed = !expanded && COLLAPSED_KINDS.has(event.kind);
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
          <pre
            className={`run-event-body${
              event.kind === 'tool-call' || event.kind === 'tool-result' ? '' : ' run-event-prose'
            }`}
          >
            {body}
          </pre>
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
  backends,
  profiles,
  runs,
  onHandoff,
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
  backends?: ExecutionStatusResponse['backends'];
  profiles?: readonly ProfileEntry[];
  /** The work item's other runs, so a remediation can default to the previous implementer. */
  runs?: readonly AgentRunSummary[];
  /** Present when this run's output can be handed to an implement run. */
  onHandoff?: (input: LaunchInput) => void;
}) {
  const { run, worktree } = detail;
  const live = isLiveStatus(run.status);
  const [draft, setDraft] = useState('');
  const [handoffOpen, setHandoffOpen] = useState(false);
  const target = handoffTarget(run);
  const handoffChoice =
    target === undefined
      ? undefined
      : handoffDefaults(target.role, profiles ?? [], run, runs ?? []);
  const handoffHint =
    run.role === 'review' && handoffChoice !== undefined
      ? previousImplementerHint(runs ?? [], run.worktreeId, handoffChoice)
      : undefined;
  const [showBrief, setShowBrief] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<EventGroup>>(() => new Set(['system']));
  // Following is a property of the feed pane, never of the page: the pane
  // auto-scrolls only while the reader is already at its bottom.
  const [follow, setFollow] = useState(true);
  const feed = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const totals: Record<EventGroup, number> = { messages: 0, tools: 0, notices: 0, system: 0 };
    for (const event of events) {
      totals[GROUP_OF[event.kind]] += 1;
    }
    return totals;
  }, [events]);
  const visible = useMemo(
    () => events.filter((event) => !hidden.has(GROUP_OF[event.kind])),
    [events, hidden],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the visible length is the scroll trigger
  useEffect(() => {
    const pane = feed.current;
    if (follow && pane !== null) {
      pane.scrollTop = pane.scrollHeight;
    }
  }, [follow, visible.length]);

  const onFeedScroll = (event: UIEvent<HTMLDivElement>): void => {
    const pane = event.currentTarget;
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;
    if (atBottom !== follow) {
      setFollow(atBottom);
    }
  };

  const toggleGroup = (group: EventGroup): void => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    onSend(text);
    setDraft('');
  };

  const model = run.resolvedModel ?? run.model;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="crumbs">
            <button type="button" className="link-button" onClick={onOpenWorkItem}>
              Work item
            </button>
            <span>/</span>
            <span>{RUN_ROLE_LABELS[run.role]} run</span>
          </div>
          <h1>{RUN_ROLE_LABELS[run.role]} run</h1>
          <div className="run-header-meta">
            <span className="mono">{worktree.branchName}</span>
            <span>·</span>
            <span>{model === undefined ? 'default model' : model}</span>
            <span>·</span>
            <span>
              {run.turnCount} turn{run.turnCount === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span>{formatCost(run.costUsd, run.billing)}</span>
            {run.verdict !== undefined && (
              <span
                className="status-badge"
                style={{ '--badge-accent': VERDICT_ACCENTS[run.verdict] } as CSSProperties}
              >
                {VERDICT_LABELS[run.verdict]}
              </span>
            )}
          </div>
        </div>
        <div className="page-header-actions">
          <span
            className={`status-badge large${live && run.status !== 'waiting' ? ' pulse' : ''}`}
            style={{ '--badge-accent': RUN_STATUS_ACCENTS[run.status] } as CSSProperties}
          >
            {RUN_STATUS_LABELS[run.status]}
          </span>
          <button type="button" className="secondary-button" onClick={onLoadDiff}>
            {diff === undefined ? 'View diff' : 'Refresh diff'}
          </button>
          {onHandoff !== undefined && target !== undefined && (
            <button
              type="button"
              className="primary-button"
              onClick={() => setHandoffOpen(true)}
              disabled={busy || handoffOpen}
              title={target.title}
            >
              {target.pageButton}
            </button>
          )}
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
      </header>
      {onHandoff !== undefined &&
        target !== undefined &&
        handoffChoice !== undefined &&
        handoffOpen && (
          <section className="panel" aria-label="Handoff">
            <HandoffForm
              label={target.label}
              backends={backends ?? []}
              defaults={handoffChoice}
              {...(handoffHint === undefined ? {} : { hint: handoffHint })}
              placeholder={target.placeholder}
              busy={busy}
              onLaunch={(choice) => {
                onHandoff({
                  backend: choice.backend,
                  worktreeId: run.worktreeId,
                  role: target.role,
                  permissionMode: choice.permissionMode,
                  ...(choice.model === undefined ? {} : { model: choice.model }),
                  ...(choice.instructions === undefined
                    ? {}
                    : { instructions: choice.instructions }),
                  parentRunId: run.id,
                });
                setHandoffOpen(false);
              }}
              onCancel={() => setHandoffOpen(false)}
            />
          </section>
        )}

      {error !== undefined && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}

      <details className="disclosure" aria-label="Run summary">
        <summary>
          <span>Details</span>
          <span className="hint">
            {AGENT_BACKEND_LABELS[run.backend]}
            {run.billing === undefined ? '' : ` · ${BILLING_LABELS[run.billing]}`}
          </span>
        </summary>
        <div className="disclosure-body">
          <dl className="definition-grid">
            <dt>Model</dt>
            <dd>
              {run.resolvedModel ?? 'not reported yet'}
              {run.model !== undefined && run.model !== run.resolvedModel
                ? ` (requested ${run.model})`
                : ''}
            </dd>
            <dt>Billing</dt>
            <dd>
              {run.billing === undefined ? '—' : BILLING_LABELS[run.billing]}
              {run.backend === 'codex'
                ? '. Dollar usage is shown only when Codex reports it; subscription figures are estimates, not a bill.'
                : run.billing === 'subscription'
                  ? '. Cost figures are the API-equivalent estimate reported by Claude Code, not a bill.'
                  : ''}
            </dd>
            <dt>Permissions</dt>
            <dd>{PERMISSION_MODE_LABELS[run.permissionMode]}</dd>
            <dt>Worktree</dt>
            <dd className="mono">{worktree.path}</dd>
            <dt>Base</dt>
            <dd className="mono">
              {worktree.baseBranch} @ {shortSha(worktree.baseSha)}
            </dd>
            {run.backendSessionId !== undefined && (
              <>
                <dt>Backend session</dt>
                <dd className="mono">{run.backendSessionId}</dd>
              </>
            )}
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
          <div className="inline-actions" style={{ marginTop: 'var(--space-3)' }}>
            <button
              type="button"
              className="text-button"
              onClick={() => setShowBrief((value) => !value)}
            >
              {showBrief ? 'Hide brief' : 'Show brief'}
            </button>
          </div>
          {showBrief && (
            <pre className="source-text" data-testid="run-brief">
              {detail.brief}
            </pre>
          )}
        </div>
      </details>

      {diff !== undefined && <DiffView diff={diff} onClose={onCloseDiff} />}

      <section className="panel" aria-label="Run activity">
        <div className="feed-toolbar">
          <div className="chip-row">
            <h3 style={{ margin: 0 }}>Activity</h3>
            {GROUPS.map((group) => (
              <button
                key={group}
                type="button"
                className="chip"
                aria-pressed={!hidden.has(group)}
                onClick={() => toggleGroup(group)}
              >
                {GROUP_LABELS[group]} {counts[group]}
              </button>
            ))}
          </div>
          <div className="inline-actions">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={expandAll}
                onChange={(event) => setExpandAll(event.target.checked)}
              />
              Expand tool output
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              Follow
            </label>
          </div>
        </div>
        {live && connection === 'disconnected' && (
          <p className="error-state" role="alert">
            The live stream is unreachable; reconnection continues automatically. Events already
            committed remain visible.
          </p>
        )}
        <div className="feed" ref={feed} onScroll={onFeedScroll} data-testid="run-feed">
          {visible.length === 0 ? (
            <p className="empty-state">
              {events.length === 0 ? 'Waiting for the first event…' : 'Everything is filtered out.'}
            </p>
          ) : (
            <ol className="run-event-list">
              {visible.map((event) => (
                <RunEventItem key={event.id} event={event} expanded={expandAll} />
              ))}
            </ol>
          )}
          {!follow && visible.length > 0 && (
            <div className="feed-jump">
              <button type="button" className="secondary-button" onClick={() => setFollow(true)}>
                Jump to latest
              </button>
            </div>
          )}
        </div>
      </section>

      {live && canMutate && (
        <section className="panel" aria-label="Send a message">
          <form className="compose" onSubmit={send}>
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
            <div className="inline-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={busy || draft.trim().length === 0}
              >
                Send
              </button>
              <span className="hint">
                Ending the session lets the agent finish and exit; cancelling kills it.
              </span>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
