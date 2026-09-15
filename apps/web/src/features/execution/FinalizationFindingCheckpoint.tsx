import type { ControlFinalizationRequest, FinalizationView } from '@craftingtable/contracts';
import { useState } from 'react';

export function FinalizationFindingCheckpoint({
  view,
  busy,
  onDecide,
}: {
  view: FinalizationView;
  busy: boolean;
  onDecide: (input: ControlFinalizationRequest) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<'defer-nits' | 'remediate-findings'>('defer-nits');
  const [rationale, setRationale] = useState('');
  const [instructions, setInstructions] = useState('');
  const [rounds, setRounds] = useState(1);
  const findings = view.checkpointFindings;
  const invalid =
    !selected.length ||
    (action === 'defer-nits' &&
      findings.some((f) => selected.includes(f.id) && f.severity !== 'nit'));
  return (
    <form
      className="stack-form"
      aria-label="Decide remaining findings"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        onDecide({
          action,
          findingIds: selected,
          rationale,
          instructions,
          ...(action === 'remediate-findings' ? { additionalRounds: rounds } : {}),
          expectedVersion: view.finalization.version,
          expectedCycleVersion: view.cycle?.version,
        });
      }}
    >
      <h4>Decide remaining findings</h4>
      <p>
        Select findings below, record your decision, and answer any open questions in the guidance.
        Deferral keeps nits open in history and starts an independent review; it never approves the
        final merge.
      </p>
      <label className="field">
        Next action
        <select
          value={action}
          disabled={busy}
          onChange={(e) => setAction(e.target.value as typeof action)}
        >
          <option value="defer-nits">Defer selected nits and review</option>
          <option value="remediate-findings">Address selected findings</option>
        </select>
      </label>
      <fieldset disabled={busy}>
        <legend>Open findings</legend>
        {findings.map((f) => (
          <label key={f.id} className="checkbox-row">
            <input
              type="checkbox"
              checked={selected.includes(f.id)}
              onChange={(e) =>
                setSelected((ids) =>
                  e.target.checked ? [...ids, f.id] : ids.filter((id) => id !== f.id),
                )
              }
            />
            <span>
              {f.id} · {f.severity} · {f.title}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        Decision rationale
        <textarea
          required
          maxLength={4000}
          value={rationale}
          disabled={busy}
          onChange={(e) => setRationale(e.target.value)}
        />
      </label>
      <label className="field">
        Answers and guidance
        <textarea
          maxLength={10000}
          value={instructions}
          disabled={busy}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {action === 'remediate-findings' && (
        <>
          <label className="field">
            Additional focused attempts
            <input
              type="number"
              min={1}
              max={20}
              required
              value={rounds}
              disabled={busy}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>
          <p>
            Selected findings define the batch. Unselected findings still count toward the
            completion policy. Each attempt is followed by review.
          </p>
        </>
      )}
      {action === 'defer-nits' && (
        <p>
          Only nits can be deferred. Changed commits or changed finding details require a new
          decision. Required checks and plan obligations still apply.
        </p>
      )}
      <button
        className="primary-button"
        type="submit"
        disabled={busy || invalid || !rationale.trim()}
      >
        {action === 'defer-nits'
          ? 'Defer selected nits and review'
          : 'Authorize focused remediation'}
      </button>
    </form>
  );
}
