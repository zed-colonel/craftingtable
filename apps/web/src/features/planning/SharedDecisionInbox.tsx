import { useState } from 'react';
import {
  runtimeEvidenceViewSchema,
  type ArchitectureDecisionInbox,
  type ProposeArchitectureDecision,
  type RuntimeEvidenceView,
} from '@craftingtable/contracts';
import { Section } from '../../components/Section.js';
import { ActionBar } from '../../components/ActionBar.js';
import { About } from '../../components/About.js';
import { request } from '../../lib/api-client.js';

type Card = ArchitectureDecisionInbox['decisions'][number];
type Record = Card['records'][number];
export function SharedDecisionInbox({
  data,
  csrfToken,
  disabled,
  onChanged,
  onClarify,
}: {
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
  onClarify?: (guidance: string) => void;
}) {
  if (!data.decisions.length) return null;
  const accepted = (c: Card) =>
    c.records.some((r) => r.applicable && !r.issues.length && r.decision?.outcome === 'accepted');
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
          />
        ))}
    </Section>
  );
}

function DecisionCard({
  card,
  data,
  csrfToken,
  disabled,
  onChanged,
  onClarify,
}: {
  card: Card;
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
  onClarify?: (guidance: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Record>();
  const [reviewing, setReviewing] = useState(false);
  const [rationale, setRationale] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const recommendation = card.recommendation;
  const brief = recommendation?.brief;
  const current = card.records.filter(
    (r) => r.applicable && !r.issues.length && r.decision?.outcome === 'accepted',
  );
  const accepted = current.find((r) => r.proposal.coverage === 'full') ?? current[0];
  const fullApproval = accepted?.proposal.coverage === 'full';
  const pending = saved ?? card.records.find((r) => !r.decision && !r.issues.length);
  const [draft, setDraft] = useState<ProposeArchitectureDecision>();
  const locked = disabled || busy;
  const approvalBlocked = locked || !!data.blockers.length || !!card.blockers.length;
  const base = `/api/workspaces/${encodeURIComponent(data.workspaceId)}/concurrency-definitions/${encodeURIComponent(data.definitionId)}/runtime`;
  const post = (action: string, input: unknown) =>
    request(`${base}/${action}`, runtimeEvidenceViewSchema, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': csrfToken },
      body: JSON.stringify(input),
    });
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
  const save = async () => {
    if (!draft || locked) return;
    setBusy(true);
    setError('');
    try {
      const next = await post('propose-decision', draft);
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
      setReviewed(false);
      await onChanged(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the decision.');
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!pending || approvalBlocked || !reviewed || !rationale.trim()) return;
    setBusy(true);
    setError('');
    try {
      const next = await post('decide', {
        submissionId: pending.id,
        outcome: 'accepted',
        rationale,
      });
      await onChanged(next);
      setSaved(undefined);
      setReviewing(false);
      setReviewed(false);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Approval failed. Refresh the decision before trying again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const clarification = `Clarify ${card.checkpointId} for operator review. Provide a complete standalone decision brief with the proposed choice, rationale, alternatives and tradeoffs, consequences, exact source citations, and full or explicitly limited coverage. Explain what remains to implement or verify. Do not approve the decision or implement changes.`;
  const status = accepted
    ? accepted.proposal.coverage === 'full'
      ? 'Accepted · full architectural decision'
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
                This older report has no standalone decision brief. Request clarification or write
                the exact decision using Approve with changes. Source references are already
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
          {card.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <pre className="run-event-body">{card.sourceReferences}</pre>
        {recommendation && (
          <a href={`/workspaces/${data.workspaceId}/runs/${recommendation.sourceRunId}`}>
            Read source run report
          </a>
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
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setReviewing(true);
                setReviewed(false);
              }}
            >
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
              <a
                href={`/workspaces/${data.workspaceId}/work-items/${recommendation.workItemId}#clarify-architecture-${encodeURIComponent(card.checkpointId)}`}
              >
                Request clarification in design recovery
              </a>
            )
          )}
        </ActionBar>
      )}
      {editing && draft && (
        <form
          className="stack-form"
          aria-label={`Prepare ${card.checkpointId}`}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
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
          {draft.coverage === 'clauses' && (
            <>
              <label className="field">
                Full obligations retained for later work
                <textarea
                  required
                  value={draft.retainedObligations}
                  maxLength={16000}
                  rows={4}
                  disabled={locked}
                  onChange={(e) => setDraft({ ...draft, retainedObligations: e.target.value })}
                />
              </label>
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
            <button
              type="submit"
              disabled={
                locked ||
                !draft.proposal.trim() ||
                (draft.coverage === 'clauses' &&
                  (!draft.consumers.length || !draft.retainedObligations.trim()))
              }
            >
              Save decision for approval
            </button>
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
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              disabled={locked}
              onChange={(e) => setReviewed(e.target.checked)}
            />{' '}
            I reviewed this exact decision and its scope as repository maintainer.
          </label>
          <label className="field">
            Approval rationale
            <textarea
              rows={2}
              value={rationale}
              disabled={locked}
              maxLength={16000}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why this choice fits your goals"
            />
          </label>
          <ActionBar label="Approve saved decision">
            <button
              type="button"
              className="primary-button"
              disabled={
                approvalBlocked || !!pending.issues.length || !reviewed || !rationale.trim()
              }
              onClick={() => void approve()}
            >
              {pending.proposal.coverage === 'clauses'
                ? 'Approve limited scope'
                : 'Approve decision'}
            </button>
            <button type="button" disabled={locked} onClick={() => setReviewing(false)}>
              Close approval
            </button>
          </ActionBar>
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
              {r.issues.map((issue) => (
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
