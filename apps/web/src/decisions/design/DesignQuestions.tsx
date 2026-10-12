import type {
  DesignRecoveryPreview,
  ExecutionStatusResponse,
  RecoverDesignRequest,
} from '@craftingtable/contracts';
import type { AgentSelection, CycleProjection, WorkCycle } from '@craftingtable/domain';
import { useEffect, useRef, useState } from 'react';
import { About } from '../../components/About.js';
import { revealElement } from '../../lib/reveal-element.js';
import { previewDesignRecovery, recoverDesign } from './design-api.js';
import { useAttention } from '../../app/reads.js';
import { settles } from '../architecture/ArchitectureDecision.js';
import { BaselinePreparation } from './BaselinePreparation.js';
import { SourceRunReport } from '../../features/execution/SourceRunReport.js';
import { AgentOverride } from '../../features/execution/AgentOverride.js';
import { distinct } from '../../lib/distinct.js';
import { sharedDecisionsRoute } from '../../lib/decision-links.js';
import { Link } from '../../lib/navigation.js';
import { useRouteFocus } from '../../lib/navigation.js';

/**
 * A stopped design step's decision (R-A6 increment 2a): answer its questions and continue,
 * clarify, or restart it, with the historical baseline its evidence needs. It renders in the
 * cycle's inbox item, and on the work item page when no item carries the cycle's stop.
 */
export function DesignQuestions({
  cycle,
  agents,
  backends,
  csrfToken,
  onChanged,
}: {
  cycle: WorkCycle;
  /** The cycle's agents with their sources, from its projection (R-E5b). */
  agents?: CycleProjection['agents'];
  backends: ExecutionStatusResponse['backends'];
  csrfToken: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DesignRecoveryPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [instructions, setInstructions] = useState('');
  const [mode, setMode] = useState<'investigate' | 'continue'>('investigate');
  // The investigation or design agent the next action takes, changed for it only on request.
  const [change, setChange] = useState<AgentSelection>();
  const agent = agents?.[mode === 'investigate' ? 'investigation' : 'design'];
  const profile = change ?? agent?.selection;
  const [attachments, setAttachments] = useState<RecoverDesignRequest['attachments']>(
    () => cycle.designRecovery?.attachments.map((file) => ({ ...file })) ?? [],
  );
  const stale = preview !== undefined && preview.expectedVersion !== cycle.version;
  const available =
    !!profile && backends.find((entry) => entry.kind === profile.backend)?.available === true;
  const discover = async (clarifyCheckpoint?: string) => {
    setOpen(true);
    setBusy(true);
    setError(undefined);
    try {
      const next = await previewDesignRecovery(cycle);
      setPreview(next);
      if (
        clarifyCheckpoint &&
        next.decisionInbox?.decisions.some((c) => c.checkpointId === clarifyCheckpoint)
      ) {
        const card = next.decisionInbox.decisions.find(
          (c) => c.checkpointId === clarifyCheckpoint,
        )!;
        setMode('investigate');
        setInstructions(
          `Clarify ${card.checkpointId}: provide a standalone decision brief with your recommendation, rationale, alternatives, consequences, source citations and explicit full or limited coverage. Do not approve or implement the decision.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Evidence discovery failed.');
    } finally {
      setBusy(false);
    }
  };
  // Navigation prepares a clarification draft only; starting an agent remains explicit.
  // The route's focus is already decoded. Each clarification link is consumed once per cycle:
  // following an in-page anchor and coming Back must not replace an edited draft (R-E1 review).
  const focus = useRouteFocus();
  const consumed = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume this navigation once for the selected cycle.
  useEffect(() => {
    const prefix = 'clarify-architecture-';
    if (!focus?.startsWith(prefix)) return;
    const key = `${cycle.id}:${focus}`;
    if (consumed.current.has(key)) return;
    consumed.current.add(key);
    void discover(focus.slice(prefix.length));
  }, [cycle.id, focus]);
  return (
    <section id="design-recovery" aria-label="Resolve design questions" className="stack">
      {cycle.designRecovery?.mode === 'investigate' &&
        cycle.designRecovery.runId === cycle.currentRunId &&
        cycle.status !== 'running' && (
          <div className="panel stack">
            <h3>Evidence investigation</h3>
            <p>
              Review the recorded results below, then resolve any shared decisions using Resolve
              design questions.
            </p>
            <SourceRunReport
              key={cycle.currentRunId}
              workspaceId={cycle.workspaceId}
              runId={cycle.currentRunId}
              label="Investigation results and evidence"
            />
          </div>
        )}
      {!open ? (
        <button type="button" className="primary-button" onClick={() => void discover()}>
          Resolve design questions
        </button>
      ) : (
        <>
          <h3>Resolve design questions</h3>
          <p>
            Uses the existing worktree and full design handoff. Discovery does not approve evidence
            or start an agent.
          </p>
          <About label="About design recovery">
            <p>
              Discovery collects saved facts and matching documents from exact bound plans.
              Historical setup can be prepared in this panel. Architecture, implementation choices
              and remote protection still require your decisions.
            </p>
          </About>
          {error && (
            <p role="alert" className="error-state">
              {error}
            </p>
          )}
          <button type="button" disabled={busy} onClick={() => void discover()}>
            Refresh available evidence
          </button>
          {busy && <p role="status">Preparing design recovery…</p>}
          {stale && (
            <p role="alert">The cycle changed. Refresh available evidence before continuing.</p>
          )}
          {preview && (
            <>
              <BlockingDecisions
                cycle={cycle}
                decisions={preview.decisionInbox?.decisions ?? []}
                onClarify={(checkpointId) => {
                  setMode('investigate');
                  setInstructions(clarification(checkpointId));
                  revealElement('design-recovery-guidance');
                }}
              />
              <BaselinePreparation
                cycle={cycle}
                csrfToken={csrfToken}
                onChanged={() => {
                  onChanged();
                  void discover();
                }}
              />
              {cycle.executionScope && (
                <p>
                  <Link route={sharedDecisionsRoute(cycle)}>
                    View all shared decisions on the roadmap
                  </Link>{' '}
                  . A shared decision, once approved, applies to the same downstream work.
                </p>
              )}
              {preview.classificationIssue && <p role="alert">{preview.classificationIssue}</p>}
              {preview.classifications && (
                <div>
                  <h4>Recorded design questions and current approvals</h4>
                  {preview.classifications.items.map((item) => {
                    const decision = preview.decisionInbox?.decisions.find(
                      (c) => c.recommendation?.question === item.question,
                    );
                    const accepted = decision?.records.some(
                      (r) =>
                        r.applicable &&
                        !r.issues.length &&
                        r.proposal.coverage === 'full' &&
                        r.decision?.outcome === 'accepted',
                    );
                    return (
                      <div key={`${item.kind}-${item.question}`}>
                        <strong>
                          {accepted
                            ? 'Shared decision accepted; ready for design confirmation'
                            : item.kind}{' '}
                          · {item.question}
                        </strong>
                        {accepted ? (
                          <p>
                            This shared approval is available. Continue design to reconcile the
                            recorded question with the accepted decision.
                          </p>
                        ) : (
                          <p>{item.answer}</p>
                        )}
                        {item.sources.length > 0 && (
                          <ul>
                            {item.sources.map((source) => (
                              <li key={source}>{source}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <details>
                <summary>Original questions from the latest design</summary>
                <pre className="run-event-body">{preview.questions}</pre>
              </details>
              <details>
                <summary>Collected facts and source identities</summary>
                <pre className="run-event-body">{preview.facts}</pre>
              </details>
              <details>
                <summary>
                  Shared source documents ({preview.sources.length}) · included automatically
                </summary>
                {preview.sources.map(({ source, content }) => (
                  <details key={source.digest}>
                    <summary style={{ overflowWrap: 'anywhere' }}>{source.name}</summary>
                    <p style={{ overflowWrap: 'anywhere' }}>
                      Plan {source.planVersionId} · SHA-256 {source.digest}
                    </p>
                    <pre className="run-event-body">{content}</pre>
                  </details>
                ))}
              </details>
              <details>
                <summary>Discovery limits and remaining decisions</summary>
                <ul>
                  {distinct(preview.notices).map((notice) => (
                    <li key={notice}>{notice}</li>
                  ))}
                </ul>
              </details>
              <form
                className="stack-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || stale || !available || !profile) return;
                  setBusy(true);
                  setError(undefined);
                  void recoverDesign(
                    cycle,
                    {
                      expectedVersion: preview.expectedVersion,
                      snapshotDigest: preview.snapshotDigest,
                      mode,
                      instructions,
                      attachments,
                      profile,
                    },
                    csrfToken,
                  )
                    .then(onChanged)
                    .catch((e: unknown) => {
                      setError(e instanceof Error ? e.message : 'Design recovery failed.');
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <label className="field">
                  Next action
                  <select
                    value={mode}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value as typeof mode;
                      setMode(next);
                      // Each action has its own agent; a change made for the other one is dropped.
                      setChange(undefined);
                    }}
                  >
                    <option value="investigate">Investigate first</option>
                    <option value="continue">Continue design</option>
                  </select>
                </label>
                <p className="hint">
                  {mode === 'investigate'
                    ? 'If the investigation answers every question with sources, the design continues automatically; otherwise it stops for your review.'
                    : 'Implementation starts only after the design reports no open questions.'}
                </p>
                <label className="field" id="design-recovery-guidance" tabIndex={-1}>
                  Answers and guidance
                  <textarea
                    rows={5}
                    maxLength={16000}
                    value={instructions}
                    disabled={busy}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="Answer ownership or policy questions, identify missing sources, or bound what the agent should investigate."
                  />
                </label>
                <label className="field">
                  Supporting text files (optional; up to 4, 64 KB each)
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.json,.yaml,.yml,.toml,.log"
                    disabled={busy}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      if (
                        new Set([...attachments, ...files].map((file) => file.name)).size !==
                          attachments.length + files.length ||
                        files.length + attachments.length > 4 ||
                        files.some((f) => f.size === 0 || f.size > 64000 || f.name.length > 200)
                      ) {
                        setError(
                          'Attach at most four text files with distinct names, each no larger than 64 KB.',
                        );
                        return;
                      }
                      setBusy(true);
                      setError(undefined);
                      void Promise.all(
                        files.map(async (file) => ({
                          name: file.name,
                          content: await file.text(),
                        })),
                      )
                        .then((files) => setAttachments((previous) => [...previous, ...files]))
                        .catch(() => setError('Could not read supporting files.'))
                        .finally(() => setBusy(false));
                    }}
                  />
                </label>
                {attachments.map((file, i) => (
                  <p key={file.name}>
                    {file.name}{' '}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setAttachments(attachments.filter((_, index) => index !== i))}
                    >
                      Remove
                    </button>
                  </p>
                ))}
                <AgentOverride
                  agent={agent}
                  purpose={mode === 'investigate' ? 'investigation' : 'design'}
                  value={change}
                  onChange={setChange}
                  backends={backends}
                  disabled={busy}
                />
                <p className="hint">
                  One design attempt, up to {cycle.policy.maxRunMinutes} minutes. Permissions remain{' '}
                  {cycle.profiles.design.permissionMode}. No remediation allowance is consumed.
                </p>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy || stale || !available}
                >
                  {mode === 'investigate'
                    ? 'Start bounded investigation'
                    : 'Continue design with evidence'}
                </button>
              </form>
            </>
          )}
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            Close recovery form
          </button>
        </>
      )}
    </section>
  );
}

/** The guidance a clarification starts from: a brief for the operator, never an approval. */
const clarification = (checkpointId: string) =>
  `Clarify ${checkpointId} for operator review. Provide a complete standalone decision brief with the proposed choice, rationale, alternatives and tradeoffs, consequences, exact source citations, and full or explicitly limited coverage. Explain what remains to implement or verify. Do not approve the decision or implement changes.`;

type DecisionCard = NonNullable<DesignRecoveryPreview['decisionInbox']>['decisions'][number];

/**
 * The shared decisions this design waits on (R-A6 rest, A3): each links to its own inbox item,
 * where its card decides it, or to the roadmap's decisions step when no item carries it yet.
 * Clarification starts here, as a bounded investigation's guidance.
 */
function BlockingDecisions({
  cycle,
  decisions,
  onClarify,
}: {
  cycle: WorkCycle;
  decisions: readonly DecisionCard[];
  onClarify: (checkpointId: string) => void;
}) {
  const attention = useAttention(cycle.workspaceId).data?.items ?? [];
  const blocking = decisions.filter((card) => !card.records.some((r) => settles(card, r)));
  if (!blocking.length) return null;
  // The decision's own item: its checkpoint's, else a preparation of it (R-A6 rest), on the
  // roadmap that owns the cycle, since two roadmaps' maps may share an id (review L5).
  const owner = cycle.owner?.roadmapId;
  const mine = attention.filter((i) => owner === undefined || i.refs.roadmapId === owner);
  const itemFor = (checkpointId: string) =>
    mine.find((i) => i.checkpointId === checkpointId && i.code === 'architecture-decision') ??
    mine.find((i) => i.checkpointId === checkpointId);
  return (
    <section className="stack" aria-label="Shared decisions this design waits on">
      <h4>Shared decisions this design waits on</h4>
      <ul>
        {blocking.map((card) => {
          const item = itemFor(card.checkpointId);
          return (
            <li key={card.checkpointId}>
              <strong>{card.checkpointId}</strong> · {card.title} ·{' '}
              {item ? (
                <Link route={{ name: 'inbox', workspaceId: cycle.workspaceId, itemId: item.id }}>
                  Decide {card.checkpointId} in Needs you
                </Link>
              ) : (
                <Link route={sharedDecisionsRoute(cycle)}>
                  Decide {card.checkpointId} with the shared decisions
                </Link>
              )}{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => onClarify(card.checkpointId)}
              >
                Request clarification
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
