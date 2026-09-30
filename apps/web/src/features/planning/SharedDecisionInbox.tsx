import { useState } from 'react';
import type {
  ArchitectureDecisionInbox,
  ProposeArchitectureDecision,
  RuntimeEvidenceView,
} from '@craftingtable/contracts';
import { SourceRunReport } from '../execution/SourceRunReport.js';
import { Section } from '../../components/Section.js';
import { ActionBar } from '../../components/ActionBar.js';
import { About } from '../../components/About.js';
import { EvidenceDecision } from '../../decisions/evidence/EvidenceDecision.js';
import { PrepareDecisionBrief } from '../../decisions/preparation/PrepareDecisionBrief.js';
import { SaveProposal } from '../../decisions/architecture/SaveProposal.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import type { AgentRunId, WorkItemId, WorkspaceId } from '@craftingtable/domain';

type Card = ArchitectureDecisionInbox['decisions'][number];
type Brief = NonNullable<Card['recommendation']>['brief'];
type Record = Card['records'][number];
/** The roadmap that prepares briefs for these decisions, when there is one. */
type Preparation = { readonly workspaceId: WorkspaceId; readonly roadmapId: string };

export function SharedDecisionInbox({
  data,
  csrfToken,
  disabled,
  onChanged,
  onClarify,
  preparation,
}: {
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
  onClarify?: (guidance: string) => void;
  preparation?: Preparation;
}) {
  if (!data.decisions.length) return null;
  const accepted = (c: Card) => c.records.some((r) => settles(c, r));
  return (
    <Section
      title="Shared architecture decisions"
      summary={`${data.decisions.filter(accepted).length} of ${data.decisions.length} decisions have applicable approval.`}
    >
      <About label="About decision approval">
        <p>
          Full approval settles the architectural choice. Implementation, tests and parent
          acceptance keep their own gates. A limited approval settles only the named clauses for
          selected slices and requires a fresh saved-plan review.
        </p>
        <p>
          References and source identities are collected for you. Recommendations remain proposals
          until you explicitly approve their exact text. Approval here and on a work item creates
          the same shared record; it never resumes a run.
        </p>
      </About>
      {data.blockers.length > 0 && (
        <p className="warning-state">Approval unavailable: {data.blockers.join(' ')}</p>
      )}
      <BatchApproval data={data} csrfToken={csrfToken} disabled={disabled} onChanged={onChanged} />
      {[...data.decisions]
        .sort((a, b) => Number(accepted(a)) - Number(accepted(b)))
        .map((card) => (
          <DecisionCard
            key={`${data.definitionId}:${data.bindingRevision}:${card.checkpointId}`}
            card={card}
            data={data}
            csrfToken={csrfToken}
            disabled={disabled}
            onChanged={onChanged}
            onClarify={onClarify}
            preparation={preparation}
          />
        ))}
    </Section>
  );
}

/**
 * An accepted record that settles the decision. For a card that slices are stopped on, it must
 * cover each of them, in full or by naming it: another slice's clause approval leaves them
 * waiting (LIVE-18 review), as the daemon's rule does.
 */
function settles(card: Card, record: Card['records'][number]): boolean {
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
 * Several saved proposals approved in one pause (R-C3b): each is reviewed on its own, one
 * rationale covers them, and each is approved through the same command as its card.
 */
function BatchApproval({
  data,
  csrfToken,
  disabled,
  onChanged,
}: {
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
}) {
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState('');
  const saved = data.decisions.flatMap((card) => {
    const record = card.records.find((r) => !r.decision && !r.issues.length && r.applicable);
    return record && !card.blockers.length ? [{ card, record }] : [];
  });
  if (saved.length < 2) return null;
  const locked = disabled || !!data.blockers.length;
  const chosen = saved.filter(({ record }) => reviewed.has(record.id));
  return (
    <section className="panel stack" aria-label="Approve saved decisions">
      <h3>Approve saved decisions</h3>
      <About label="About approving several decisions">
        <p>
          Approve saved proposals together while scheduling is paused. Review each exact text first;
          one rationale is recorded with each approval.
        </p>
      </About>
      {saved.map(({ card, record }) => (
        <label key={record.id} className="field">
          <input
            type="checkbox"
            disabled={locked}
            checked={reviewed.has(record.id)}
            onChange={(e) => {
              const next = new Set(reviewed);
              if (e.target.checked) next.add(record.id);
              else next.delete(record.id);
              setReviewed(next);
            }}
          />{' '}
          {`Reviewed ${card.checkpointId} (${record.proposal.coverage === 'full' ? 'full' : 'limited'}): ${record.proposal.proposal}`}
        </label>
      ))}
      <EvidenceDecision
        workspaceId={data.workspaceId}
        definitionId={data.definitionId}
        csrfToken={csrfToken}
        submissionIds={chosen.map(({ record }) => record.id)}
        outcomes={['accepted']}
        labels={{
          rationale: 'Approval rationale for the batch',
          accepted: 'Approve reviewed decisions',
          actions: 'Batch approval',
        }}
        disabled={locked}
        name={(id) => chosen.find(({ record }) => record.id === id)?.card.checkpointId ?? id}
        onDecided={async (next, _outcome, submissionId) => {
          const approved = chosen.find(({ record }) => record.id === submissionId);
          await onChanged(next);
          if (submissionId === chosen.at(-1)?.record.id) {
            setReviewed(new Set());
            setMessage(`Approved ${chosen.map(({ card }) => card.checkpointId).join(', ')}.`);
          } else if (approved) setMessage(`Approved ${approved.card.checkpointId}…`);
        }}
      />
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function DecisionCard({
  card,
  data,
  csrfToken,
  disabled,
  onChanged,
  onClarify,
  preparation,
}: {
  card: Card;
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
  onClarify?: (guidance: string) => void;
  preparation?: Preparation | undefined;
}) {
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
  const approvalBlocked = locked || !!data.blockers.length || !!card.blockers.length;
  const prepare = (limited = false) => {
    setDraft({
      checkpointId: card.checkpointId,
      bindingRevision: data.bindingRevision,
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
  const clarification = `Clarify ${card.checkpointId} for operator review. Provide a complete standalone decision brief with the proposed choice, rationale, alternatives and tradeoffs, consequences, exact source citations, and full or explicitly limited coverage. Explain what remains to implement or verify. Do not approve the decision or implement changes.`;
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
        preparation && (
          <PrepareDecisionBrief
            workspaceId={preparation.workspaceId}
            roadmapId={preparation.roadmapId}
            checkpointId={card.checkpointId}
            csrfToken={csrfToken}
            disabled={disabled}
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
            workspaceId={data.workspaceId}
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
              workspaceId: data.workspaceId as WorkspaceId,
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
          {onClarify ? (
            <button type="button" disabled={locked} onClick={() => onClarify(clarification)}>
              Request clarification
            </button>
          ) : (
            recommendation?.workItemId && (
              <Link
                route={{
                  name: 'work-item',
                  workspaceId: data.workspaceId as WorkspaceId,
                  workItemId: recommendation.workItemId as WorkItemId,
                  focus: `clarify-architecture-${card.checkpointId}`,
                }}
              >
                Request clarification in design recovery
              </Link>
            )
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
            <>
              <p>Select the affected slices and when these clauses are required.</p>
              {[...new Set(card.consumers.map((c) => c.sliceId))].map((sliceId) => {
                const selected = draft.consumers.find((c) => c.sliceId === sliceId);
                const phase = card.consumers.some(
                  (c) => c.sliceId === sliceId && c.phase === 'start',
                )
                  ? 'start'
                  : 'merge';
                return (
                  <label className="field" key={sliceId}>
                    <span>
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={!!selected}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            consumers: e.target.checked
                              ? [
                                  ...draft.consumers,
                                  { sliceId, phase, replacesFullCheckpoint: true },
                                ]
                              : draft.consumers.filter((c) => c.sliceId !== sliceId),
                          })
                        }
                      />{' '}
                      {sliceId} · before {phase}
                    </span>
                  </label>
                );
              })}
              {draft.consumers
                .filter((c) => !card.consumers.some((v) => v.sliceId === c.sliceId))
                .map((c) => (
                  <p key={c.sliceId}>
                    Additional proposed consumer: {c.sliceId} · before {c.phase}. Use advanced
                    staging on the roadmap to adjust additional consumers.
                  </p>
                ))}
            </>
          )}
          <p>Source references and the exact source run report are included automatically.</p>
          <ActionBar label="Prepare decision approval">
            <SaveProposal
              workspaceId={data.workspaceId}
              definitionId={data.definitionId}
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
            workspaceId={data.workspaceId}
            definitionId={data.definitionId}
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

/**
 * Prepares a brief for a decision that has none yet (LIVE-18), with the roadmap's preparation
 * profile for it. The roadmap's own preparation panel chooses other agents and limits.
 */
