import { useState } from 'react';
import type { RuntimeEvidenceView, ProposeArchitectureDecision } from '@craftingtable/contracts';
import { distinct } from '../../lib/distinct.js';
import { About } from '../../components/About.js';

type Consumer = ProposeArchitectureDecision['consumers'][number];
export function ArchitectureDecisionPanel({
  view,
  busy,
  disabled,
  onSave,
  onReview,
}: {
  view: RuntimeEvidenceView;
  busy: boolean;
  disabled: boolean;
  onSave: (input: ProposeArchitectureDecision) => void;
  onReview: (id: string) => void;
}) {
  const data = view.architectureDecisions;
  const [checkpointId, setCheckpointId] = useState('');
  const [coverage, setCoverage] = useState<'full' | 'clauses'>('full');
  const [proposal, setProposal] = useState('');
  const [sourceReferences, setSourceReferences] = useState('');
  const [retainedObligations, setRetainedObligations] = useState('');
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [sourceRunId, setSourceRunId] = useState('');
  if (!data?.checkpoints.length) return null;
  const checkpoint = data.checkpoints.find((c) => c.id === checkpointId);
  const run = data.designRuns.find((r) => r.id === sourceRunId);
  const records = view.submissions.filter(
    (s) =>
      s.submission.architectureDecision &&
      (!checkpointId || s.submission.subject.sourceId === checkpointId),
  );
  return (
    <section aria-label="Shared architecture decisions" className="stack">
      <h3>Shared architecture decisions</h3>
      <p>Pause scheduling and finish live runs before approving.</p>
      <About label="About shared decisions">
        <p>
          Save a proposal, review its exact text, then approve it once as repository maintainer.
          Approved decisions accompany relevant slices.
        </p>
        <p>
          Staging early clauses is a scheduling amendment. It changes only the selected slices. The
          full ADR remains pending at its later consumers; no parent or test gate is waived.
        </p>
      </About>
      <details>
        <summary>Prepare a decision or stage early clauses</summary>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              checkpointId,
              bindingRevision: view.bindingRevision,
              coverage,
              proposal,
              sourceReferences,
              retainedObligations: coverage === 'clauses' ? retainedObligations : '',
              consumers: coverage === 'clauses' ? consumers : [],
              ...(sourceRunId ? { sourceRunId } : {}),
            });
          }}
        >
          <fieldset disabled={disabled || busy}>
            <label className="field">
              Architecture checkpoint
              <select
                required
                value={checkpointId}
                onChange={(e) => {
                  setCheckpointId(e.target.value);
                  setSourceReferences(
                    data.checkpoints.find((c) => c.id === e.target.value)?.sourceReferences ?? '',
                  );
                  setSourceRunId('');
                  setConsumers([]);
                }}
              >
                <option value="">Choose a decision</option>
                {data.checkpoints.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.title}
                  </option>
                ))}
              </select>
            </label>
            {checkpoint && (
              <details>
                <summary>Exact imported obligations and source references</summary>
                <ul>
                  {distinct(checkpoint.requirements).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <pre className="run-event-body">{checkpoint.sourceReferences}</pre>
              </details>
            )}
            <label className="field">
              Finished source report to attach (optional)
              <select value={sourceRunId} onChange={(e) => setSourceRunId(e.target.value)}>
                <option value="">Write a decision directly</option>
                {data.designRuns
                  .filter((r) => r.checkpointIds.includes(checkpointId))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
              </select>
            </label>
            {run && (
              <details open>
                <summary>Complete source proposal · recommendations awaiting your decision</summary>
                <pre className="run-event-body">{run.report}</pre>
              </details>
            )}
            <label className="field">
              Approval coverage
              <select
                value={coverage}
                onChange={(e) => setCoverage(e.target.value as typeof coverage)}
              >
                <option value="full">Full architecture checkpoint</option>
                <option value="clauses">Early clauses for named slices</option>
              </select>
            </label>
            <label className="field">
              Exact decision to approve
              <textarea
                required
                rows={8}
                maxLength={16000}
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                placeholder="Record the chosen approach, applicability and limitations. Attached recommendations alone are not approval."
              />
            </label>
            <label className="field">
              Source clauses and affected schemas or protocols
              <textarea
                required
                rows={3}
                maxLength={16000}
                value={sourceReferences}
                onChange={(e) => setSourceReferences(e.target.value)}
              />
            </label>
            {coverage === 'clauses' && (
              <>
                <p>
                  Staging changes only the selected slices and requires a fresh saved-plan review.
                </p>
                <label className="field">
                  Full obligations retained for later work
                  <textarea
                    required
                    rows={4}
                    maxLength={16000}
                    value={retainedObligations}
                    onChange={(e) => setRetainedObligations(e.target.value)}
                  />
                </label>
                <label className="field">
                  Add a consumer slice
                  <select
                    value=""
                    onChange={(e) => {
                      const slice = data.slices.find((s) => s.id === e.target.value);
                      if (slice)
                        setConsumers([
                          ...consumers,
                          {
                            sliceId: slice.id,
                            phase: 'merge',
                            replacesFullCheckpoint: slice.checkpoints.includes(checkpointId),
                          },
                        ]);
                    }}
                  >
                    <option value="">Choose a slice</option>
                    {data.slices
                      .filter((s) => !consumers.some((c) => c.sliceId === s.id))
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id} · {s.title}
                        </option>
                      ))}
                  </select>
                </label>
                {consumers.map((consumer) => (
                  <div className="stack" key={consumer.sliceId}>
                    <strong>{consumer.sliceId}</strong>
                    <p>
                      {consumer.replacesFullCheckpoint
                        ? 'Replace this slice’s full-checkpoint requirement with the approved early clauses.'
                        : 'Add an explicit early-clause prerequisite to this slice.'}
                    </p>
                    <label className="field">
                      Required before
                      <select
                        value={consumer.phase}
                        onChange={(e) =>
                          setConsumers(
                            consumers.map((c) =>
                              c.sliceId === consumer.sliceId
                                ? { ...c, phase: e.target.value as 'start' | 'merge' }
                                : c,
                            ),
                          )
                        }
                      >
                        <option value="start">Start / design</option>
                        <option value="merge">Integration merge</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setConsumers(consumers.filter((c) => c.sliceId !== consumer.sliceId))
                      }
                    >
                      Remove consumer
                    </button>
                  </div>
                ))}
              </>
            )}
            <button
              type="submit"
              className="primary-button"
              disabled={
                !checkpointId ||
                !proposal.trim() ||
                !sourceReferences.trim() ||
                (coverage === 'clauses' && (!consumers.length || !retainedObligations.trim()))
              }
            >
              Save proposal for review
            </button>
          </fieldset>
        </form>
      </details>
      {records.map(({ submission, decision, issues }) => (
        <div key={submission.id}>
          <strong>
            {submission.subject.sourceId} ·{' '}
            {submission.architectureDecision?.coverage === 'clauses'
              ? 'early clauses only; full checkpoint retained'
              : 'full checkpoint'}
          </strong>
          <p>
            {decision?.outcome ?? 'Awaiting your review'}
            {issues.length ? ' · review current prerequisites below' : ''}
          </p>
          <button type="button" onClick={() => onReview(submission.id)}>
            Review decision packet
          </button>
        </div>
      ))}
    </section>
  );
}
