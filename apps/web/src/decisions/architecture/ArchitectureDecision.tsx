import { useState } from 'react';
import type {
  ArchitectureDecisionInbox,
  ProposeArchitectureDecision,
  RuntimeEvidenceView,
} from '@craftingtable/contracts';
import type { AgentRunId, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { ActionBar } from '../../components/ActionBar.js';
import { SourceRunReport } from '../../features/execution/SourceRunReport.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import { EvidenceDecision } from '../evidence/EvidenceDecision.js';
import { PrepareDecisionBrief } from '../preparation/PrepareDecisionBrief.js';
import { SaveProposal } from './SaveProposal.js';

type Card = ArchitectureDecisionInbox['decisions'][number];
type Brief = NonNullable<Card['recommendation']>['brief'];
type Record = Card['records'][number];
type Consumer = ProposeArchitectureDecision['consumers'][number];
type Slice = NonNullable<RuntimeEvidenceView['architectureDecisions']>['slices'][number];

/**
 * A decision the map declares that has no card yet (no proposal, brief or stopped slice): the
 * same card with nothing recorded, so the operator can prepare or write it directly. The
 * daemon lists only decisions with something to show (R-A6 rest).
 */
function unlisted(view: RuntimeEvidenceView, checkpointId: string): Card | undefined {
  const checkpoint = view.architectureDecisions?.checkpoints.find((c) => c.id === checkpointId);
  return (
    checkpoint && {
      checkpointId,
      title: checkpoint.title,
      requirements: checkpoint.requirements,
      blockers: [],
      sourceReferences: checkpoint.sourceReferences,
      consumers: [],
      records: [],
    }
  );
}

/**
 * An accepted record that settles the decision. For a card that slices are stopped on, it must
 * cover each of them, in full or by naming it: another slice's clause approval leaves them
 * waiting (LIVE-18 review), as the daemon's rule does.
 */
export function settles(card: Card, record: Card['records'][number]): boolean {
  return (
    record.applicable &&
    !record.issues.length &&
    record.decision?.outcome === 'accepted' &&
    (!card.stoppedSlices?.length ||
      record.proposal.coverage === 'full' ||
      card.stoppedSlices.every((slice) =>
        record.proposal.consumers.some((consumer) => consumer.sliceId === slice),
      ))
  );
}

/**
 * Whether a brief would settle the decision for these slices: in full, or by naming each. An
 * accepted clause approval usually came from a brief limited to other slices (LIVE-22 review).
 */
function covers(brief: Brief | undefined, slices: readonly string[]): boolean {
  return (
    !!brief &&
    (brief.coverage === 'full' ||
      slices.every((slice) => brief.consumers.some((c) => c.sliceId === slice)))
  );
}

/**
 * One shared architecture decision (R-A6 rest, A2): its state, recommendation and source report,
 * agent preparation, the operator's proposal (from the recommendation, with changes, limited to
 * named slices, or written directly), and its approval through EvidenceDecision. An
 * architecture item renders only this card; setup's decisions step lists one per decision.
 */
export function ArchitectureDecision(props: {
  workspaceId: WorkspaceId;
  definitionId: string;
  view: RuntimeEvidenceView;
  checkpointId: string;
  /** The roadmap that prepares briefs for it, when there is one. */
  roadmapId?: string | undefined;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
}) {
  const { view, checkpointId } = props;
  const card =
    view.decisionInbox?.decisions.find((c) => c.checkpointId === checkpointId) ??
    unlisted(view, checkpointId);
  if (!card)
    return (
      <p className="empty-state">
        {checkpointId} is not a shared architecture decision of this map.
      </p>
    );
  return <DecisionCard {...props} card={card} />;
}

function DecisionCard({
  workspaceId,
  definitionId,
  view,
  checkpointId,
  roadmapId,
  card,
  csrfToken,
  disabled,
  onChanged,
}: Parameters<typeof ArchitectureDecision>[0] & { card: Card }) {
  const blockers = view.decisionInbox?.blockers ?? [];
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Record>();
  const [reviewing, setReviewing] = useState(false);
  const recommendation = card.recommendation;
  const brief = recommendation?.brief;
  const current = card.records.filter((r) => settles(card, r));
  const accepted = current.find((r) => r.proposal.coverage === 'full') ?? current[0];
  const fullApproval = accepted?.proposal.coverage === 'full';
  const pending = saved ?? card.records.find((r) => !r.decision && !r.issues.length);
  const [draft, setDraft] = useState<ProposeArchitectureDecision>();
  const locked = disabled;
  const designRuns =
    view.architectureDecisions?.designRuns.filter((r) => r.checkpointIds.includes(checkpointId)) ??
    [];
  const approvalBlocked = locked || !!blockers.length || !!card.blockers.length;
  const reports = [
    ...(recommendation && !designRuns.some((r) => r.id === recommendation.sourceRunId)
      ? [{ id: recommendation.sourceRunId, title: 'The recommendation’s source report' }]
      : []),
    ...designRuns,
  ];
  const prepare = (limited = false) => {
    setDraft({
      checkpointId: card.checkpointId,
      bindingRevision: view.bindingRevision,
      coverage: limited ? 'clauses' : (pending?.proposal.coverage ?? brief?.coverage ?? 'full'),
      proposal: pending?.proposal.proposal ?? brief?.decisionText ?? '',
      sourceReferences: card.sourceReferences,
      consumers: (pending?.proposal.consumers ?? brief?.consumers)?.map((c) => ({ ...c })) ?? [],
      retainedObligations:
        pending?.proposal.retainedObligations ?? brief?.retainedObligations ?? '',
      ...(recommendation
        ? {
            sourceRunId: recommendation.sourceRunId,
            sourceReportDigest: recommendation.sourceReportDigest,
          }
        : {}),
    });
    setEditing(true);
    setReviewing(false);
    setError('');
  };
  /** After the proposal is saved: open its exact recorded text for review. */
  const afterSave = async (next: RuntimeEvidenceView) => {
    if (!draft) return;
    setError('');
    try {
      const record = next.decisionInbox?.decisions
        .find((c) => c.checkpointId === card.checkpointId)
        ?.records.find(
          (r) =>
            !r.decision &&
            r.proposal.proposal === draft.proposal &&
            r.proposal.coverage === draft.coverage,
        );
      if (!record)
        throw new Error('Proposal saved; refresh decisions to review its recorded text.');
      setSaved(record);
      setEditing(false);
      setReviewing(true);
      await onChanged(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the decision.');
    }
  };
  // A clause approval settles the decision only for the slices it names (LIVE-22).
  const stillNeeded = fullApproval ? [] : (card.stillNeededBy ?? []);
  const named = new Set(accepted?.proposal.consumers.map((c) => c.sliceId)).size;
  const status = accepted
    ? accepted.proposal.coverage === 'full'
      ? 'Accepted · full architectural decision'
      : stillNeeded.length
        ? `Accepted for ${named} named ${named === 1 ? 'slice' : 'slices'} · still needed by ${stillNeeded.length}`
        : 'Accepted · limited to named slices'
    : pending
      ? 'Proposal saved · awaiting your approval'
      : card.records.some((r) => r.decision?.outcome === 'accepted')
        ? 'Previous approval does not apply to this scope or binding'
        : 'Needs your decision';
  return (
    <section className="panel stack" aria-label={card.checkpointId}>
      <h3>
        {card.checkpointId} · {card.title}
      </h3>
      <p>
        <strong>{status}</strong>
        {accepted?.decision && <> · {new Date(accepted.decision.decidedAt).toLocaleString()}</>}
      </p>
      {!accepted && card.stoppedSlices?.length ? (
        <p role="status">Needed now by {card.stoppedSlices.join(', ')}.</p>
      ) : null}
      {accepted && stillNeeded.length ? (
        <>
          {card.settledFor?.length ? <p>Settled for: {card.settledFor.join(', ')}.</p> : null}
          <p role="status">Still needed by: {stillNeeded.join(', ')}.</p>
        </>
      ) : null}
      {(accepted ? stillNeeded.length > 0 && !covers(brief, stillNeeded) : !brief) &&
        !pending &&
        roadmapId && (
          <PrepareDecisionBrief
            workspaceId={workspaceId}
            roadmapId={roadmapId}
            checkpointId={card.checkpointId}
            csrfToken={csrfToken}
            disabled={disabled}
            refreshOn={view}
          />
        )}
      {accepted && (
        <>
          <p>
            This approval accompanies applicable runs. Continue design separately after refreshing
            evidence.
          </p>
          <details>
            <summary>Accepted decision and scope</summary>
            <DecisionText record={accepted} />
          </details>
        </>
      )}
      {recommendation && (
        <>
          {recommendation.investigation && (
            <p>
              <strong>Evidence investigation available</strong> · Review its recommendation and
              supporting report before deciding.
            </p>
          )}
          {recommendation.classificationIssue && (
            <p className="warning-state" role="status">
              The structured recommendation could not be read. The recorded evidence remains
              available below. {recommendation.classificationIssue}
            </p>
          )}
          <SourceRunReport
            key={`${recommendation.sourceRunId}:${recommendation.sourceReportDigest}`}
            workspaceId={workspaceId}
            runId={recommendation.sourceRunId}
            label={
              recommendation.investigation
                ? 'Investigation results and evidence'
                : 'Source report and evidence'
            }
          />
        </>
      )}
      {!fullApproval && recommendation && (
        <>
          <p>{recommendation.question}</p>
          {brief ? (
            <>
              <h4>Recommended decision</h4>
              <p style={{ whiteSpace: 'pre-wrap' }}>{brief.decisionText}</p>
              <p>
                <strong>Why:</strong> {brief.why}
              </p>
              <p>
                <strong>Consequences:</strong> {brief.consequences}
              </p>
              {brief.retainedObligations && (
                <p>
                  <strong>Still required:</strong> {brief.retainedObligations}
                </p>
              )}
              <details>
                <summary>Alternatives and tradeoffs</summary>
                <ul>
                  {brief.alternatives.map((a) => (
                    <li key={`${a.option}:${a.tradeoff}`}>
                      <strong>{a.option}</strong>: {a.tradeoff}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <>
              <p>{recommendation.answer}</p>
              <p className="warning-state">
                This report has no validated standalone decision brief. Request clarification or
                write the exact decision using Approve with changes. Source references are already
                collected.
              </p>
            </>
          )}
        </>
      )}
      {card.blockers.length > 0 && (
        <p className="warning-state">
          Remaining checkpoint prerequisites: {card.blockers.join(' ')}
        </p>
      )}
      <details>
        <summary>Affected work and source references</summary>
        <p>
          Approval settles this decision prerequisite for the following work. Other gates still
          apply.
        </p>
        <ul>
          {card.consumers.map((c) => (
            <li key={`${c.sliceId}:${c.phase}`}>
              {c.sliceId} · before {c.phase}
            </li>
          ))}
        </ul>
        <ul>
          {distinct(card.requirements).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <pre className="run-event-body">{card.sourceReferences}</pre>
        {recommendation && (
          <Link
            route={{
              name: 'run',
              workspaceId,
              runId: recommendation.sourceRunId as AgentRunId,
            }}
          >
            Read source run report
          </Link>
        )}
      </details>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {!editing && !reviewing && (!fullApproval || pending) && (
        <ActionBar label={`Actions for ${card.checkpointId}`}>
          {pending ? (
            <button type="button" disabled={locked} onClick={() => setReviewing(true)}>
              Review saved proposal
            </button>
          ) : (
            brief && (
              <button type="button" disabled={locked} onClick={() => prepare()}>
                Review recommendation
              </button>
            )
          )}
          <button type="button" disabled={locked} onClick={() => prepare()}>
            Approve with changes
          </button>
          <button type="button" disabled={locked} onClick={() => prepare(true)}>
            Approve a limited scope
          </button>
          {recommendation?.workItemId && (
            <Link
              route={{
                name: 'work-item',
                workspaceId,
                workItemId: recommendation.workItemId as WorkItemId,
                focus: `clarify-architecture-${card.checkpointId}`,
              }}
            >
              Request clarification in design recovery
            </Link>
          )}
        </ActionBar>
      )}
      {editing && draft && (
        <form
          className="stack-form"
          aria-label={`Prepare ${card.checkpointId}`}
          onSubmit={(e) => e.preventDefault()}
        >
          <label className="field">
            Decision to approve
            <textarea
              required
              rows={8}
              maxLength={16000}
              value={draft.proposal}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, proposal: e.target.value })}
            />
          </label>
          <label className="field">
            Approval scope
            <select
              value={draft.coverage}
              disabled={locked}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  coverage: e.target.value as 'full' | 'clauses',
                  consumers: [],
                  retainedObligations: '',
                })
              }
            >
              <option value="full">Complete architectural decision</option>
              <option value="clauses">Limited clauses for named slices</option>
            </select>
          </label>
          <p>
            {draft.coverage === 'full'
              ? 'Approves this complete architectural choice. It does not approve implementation, tests, parent acceptance or release.'
              : 'Approves only your stated clauses for selected slices. The full decision remains required elsewhere. Saving plan evidence must be repeated after approval.'}
          </p>
          <label className="field">
            {draft.coverage === 'clauses'
              ? 'Full obligations retained for later work'
              : 'Implementation, verification and release still required'}
            <textarea
              required={draft.coverage === 'clauses'}
              value={draft.retainedObligations}
              maxLength={16000}
              rows={4}
              disabled={locked}
              onChange={(e) => setDraft({ ...draft, retainedObligations: e.target.value })}
            />
          </label>
          {draft.coverage === 'clauses' && (
            <ClauseConsumers
              card={card}
              slices={view.architectureDecisions?.slices ?? []}
              consumers={draft.consumers}
              disabled={locked}
              onChange={(consumers) => setDraft({ ...draft, consumers })}
            />
          )}
          {reports.length > 0 && (
            <label className="field">
              Source report
              <select
                value={draft.sourceRunId ?? ''}
                disabled={locked}
                onChange={(e) => {
                  const { sourceRunId: _run, sourceReportDigest: _digest, ...rest } = draft;
                  const runId = e.target.value;
                  setDraft(
                    !runId
                      ? rest
                      : runId === recommendation?.sourceRunId
                        ? {
                            ...rest,
                            sourceRunId: runId,
                            sourceReportDigest: recommendation.sourceReportDigest,
                          }
                        : { ...rest, sourceRunId: runId },
                  );
                }}
              >
                <option value="">None: a decision written directly</option>
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p>Source references, and the source report chosen, are included automatically.</p>
          <ActionBar label="Prepare decision approval">
            <SaveProposal
              workspaceId={workspaceId}
              definitionId={definitionId}
              csrfToken={csrfToken}
              proposal={draft}
              label="Save decision for approval"
              disabled={
                locked ||
                !draft.proposal.trim() ||
                (draft.coverage === 'clauses' &&
                  (!draft.consumers.length || !draft.retainedObligations.trim()))
              }
              onSaved={afterSave}
            />
            <button type="button" disabled={locked} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </ActionBar>
        </form>
      )}
      {reviewing && pending && (
        <div className="stack">
          <h4>Review the saved decision</h4>
          <DecisionText record={pending} />
          {pending.issues.length > 0 && <p role="alert">{pending.issues.join(' ')}</p>}
          <EvidenceDecision
            key={pending.id}
            workspaceId={workspaceId}
            definitionId={definitionId}
            csrfToken={csrfToken}
            submissionIds={[pending.id]}
            outcomes={['accepted']}
            labels={{
              rationale: 'Approval rationale',
              accepted:
                pending.proposal.coverage === 'clauses'
                  ? 'Approve limited scope'
                  : 'Approve decision',
              actions: 'Approve saved decision',
            }}
            attestation="I reviewed this exact decision and its scope as repository maintainer."
            acceptBlocked={approvalBlocked || !!pending.issues.length}
            disabled={locked}
            onCancel={{ label: 'Close approval', run: () => setReviewing(false) }}
            onDecided={async (next) => {
              await onChanged(next);
              setSaved(undefined);
              setReviewing(false);
            }}
          />
        </div>
      )}
      {card.records.length > 0 && (
        <details>
          <summary>Decision history ({card.records.length})</summary>
          {card.records.map((r) => (
            <div key={r.id}>
              <p>
                {r.decision?.outcome ?? 'Awaiting approval'} ·{' '}
                {r.proposal.coverage === 'full' ? 'full decision' : 'limited clauses'}
                {r.issues.length ? ' · requires fresh approval' : ''}
              </p>
              <DecisionText record={r} />
              {distinct(r.issues).map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

/**
 * The slices a limited approval names and the phase each needs it before: the decision's own
 * consumers, and any other slice of the map (folded in from the roadmap's former clause-staging
 * form, R-A6 rest).
 */
function ClauseConsumers({
  card,
  slices,
  consumers,
  disabled,
  onChange,
}: {
  card: Card;
  slices: readonly Slice[];
  consumers: readonly Consumer[];
  disabled: boolean;
  onChange: (consumers: Consumer[]) => void;
}) {
  const own = [...new Set(card.consumers.map((c) => c.sliceId))];
  const listed = [...own, ...consumers.map((c) => c.sliceId).filter((id) => !own.includes(id))];
  const replaces = (sliceId: string) =>
    own.includes(sliceId) ||
    !!slices.find((s) => s.id === sliceId)?.checkpoints.includes(card.checkpointId);
  const defaultPhase = (sliceId: string): Consumer['phase'] =>
    card.consumers.some((c) => c.sliceId === sliceId && c.phase === 'start') ? 'start' : 'merge';
  return (
    <>
      <p>Select the affected slices and when these clauses are required.</p>
      {listed.map((sliceId) => {
        const selected = consumers.find((c) => c.sliceId === sliceId);
        return (
          <div className="stack" key={sliceId}>
            <label className="field">
              <span>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={!!selected}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [
                            ...consumers,
                            {
                              sliceId,
                              phase: defaultPhase(sliceId),
                              replacesFullCheckpoint: replaces(sliceId),
                            },
                          ]
                        : consumers.filter((c) => c.sliceId !== sliceId),
                    )
                  }
                />{' '}
                {sliceId}
                {selected ? '' : ` · before ${defaultPhase(sliceId)}`}
              </span>
            </label>
            {selected && (
              <label className="field">
                Required before ({sliceId})
                <select
                  value={selected.phase}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(
                      consumers.map((c) =>
                        c.sliceId === sliceId
                          ? { ...c, phase: e.target.value as Consumer['phase'] }
                          : c,
                      ),
                    )
                  }
                >
                  <option value="start">Start / design</option>
                  <option value="merge">Integration merge</option>
                </select>
              </label>
            )}
            {selected && !own.includes(sliceId) && (
              <p className="hint">
                {selected.replacesFullCheckpoint
                  ? 'Replaces this slice’s full-checkpoint requirement with the approved clauses.'
                  : 'Adds an explicit early-clause prerequisite to this slice.'}
              </p>
            )}
          </div>
        );
      })}
      <label className="field">
        Add another slice
        <select
          value=""
          disabled={disabled}
          onChange={(e) => {
            const sliceId = e.target.value;
            if (sliceId)
              onChange([
                ...consumers,
                { sliceId, phase: 'merge', replacesFullCheckpoint: replaces(sliceId) },
              ]);
          }}
        >
          <option value="">Choose a slice</option>
          {slices
            .filter((s) => !listed.includes(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} · {s.title}
              </option>
            ))}
        </select>
      </label>
    </>
  );
}

function DecisionText({ record }: { record: Record }) {
  const p = record.proposal;
  return (
    <>
      <p style={{ whiteSpace: 'pre-wrap' }}>{p.proposal}</p>
      <p>
        {p.coverage === 'full'
          ? 'Complete architectural decision. Implementation and verification remain separate.'
          : 'Only these clauses and named slices are approved; full checkpoint obligations remain.'}
      </p>
      {p.consumers.length > 0 && (
        <ul>
          {p.consumers.map((c) => (
            <li key={c.sliceId}>
              {c.sliceId} · before {c.phase}
            </li>
          ))}
        </ul>
      )}
      {p.retainedObligations && (
        <p>
          <strong>Still required:</strong> {p.retainedObligations}
        </p>
      )}
      {record.decision && (
        <p>
          <strong>Your rationale:</strong> {record.decision.rationale}
        </p>
      )}
      <details>
        <summary>Recorded source references</summary>
        <pre className="run-event-body">{p.sourceReferences}</pre>
      </details>
    </>
  );
}
