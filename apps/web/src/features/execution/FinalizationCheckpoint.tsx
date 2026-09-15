import type { ControlFinalizationRequest, FinalizationView } from '@craftingtable/contracts';
import { remediationAllowance } from '@craftingtable/domain';
import { useId, useState } from 'react';

type CheckpointAction = Extract<
  ControlFinalizationRequest['action'],
  'defer-nits' | 'remediate-findings' | 'authorize-remediation' | 'resume'
>;

export function FinalizationCheckpoint({
  view,
  busy,
  onDecide,
}: {
  view: FinalizationView;
  busy: boolean;
  onDecide: (input: ControlFinalizationRequest) => void;
}) {
  const findings = view.checkpointFindings;
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<CheckpointAction>(() =>
    findings.length
      ? findings.some((f) => f.severity !== 'nit')
        ? 'remediate-findings'
        : 'defer-nits'
      : view.canAuthorizeRemediation
        ? 'authorize-remediation'
        : 'resume',
  );
  const [rationale, setRationale] = useState('');
  const [instructions, setInstructions] = useState('');
  const [rounds, setRounds] = useState(1);
  const hintId = useId();
  const focused = action === 'remediate-findings';
  const findingDecision = focused || action === 'defer-nits';
  const grantsAttempts = focused || action === 'authorize-remediation';
  const allowance = view.cycle
    ? remediationAllowance(view.cycle)
    : view.finalization.policy.maxRemediationRounds;
  const used = view.cycle?.remediationRounds ?? 0;
  const validRounds = Number.isInteger(rounds) && rounds >= 1 && rounds <= 20;
  const blocker =
    findingDecision && !selected.length
      ? 'Select at least one finding to continue.'
      : action === 'defer-nits' &&
          findings.some((f) => selected.includes(f.id) && f.severity !== 'nit')
        ? 'Only nits can be deferred. Deselect higher-severity findings or choose Address selected findings.'
        : findingDecision && !rationale.trim()
          ? 'Enter a decision rationale to continue.'
          : grantsAttempts && !validRounds
            ? 'Choose between 1 and 20 additional attempts.'
            : undefined;
  const buttonLabel = {
    'defer-nits': 'Defer selected nits and review',
    'remediate-findings': 'Authorize focused remediation',
    'authorize-remediation': 'Authorize more remediation',
    resume: 'Resume finalization',
  }[action];
  return (
    <form
      className="stack-form"
      aria-label="Finalization next step"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || blocker) return;
        onDecide({
          action,
          ...(findingDecision ? { findingIds: selected, rationale } : {}),
          ...(grantsAttempts ? { additionalRounds: rounds } : {}),
          instructions,
          expectedVersion: view.finalization.version,
          expectedCycleVersion: view.cycle?.version,
        });
      }}
    >
      <h4>Next finalization step</h4>
      <label className="field">
        Next action
        <select
          value={action}
          disabled={busy}
          onChange={(e) => setAction(e.target.value as CheckpointAction)}
        >
          {!!findings.length && (
            <>
              <option value="defer-nits">Defer selected nits and review</option>
              <option value="remediate-findings">Address selected findings</option>
            </>
          )}
          {!findings.length && view.canAuthorizeRemediation && (
            <option value="authorize-remediation">Authorize more remediation</option>
          )}
          {!view.canAuthorizeRemediation && <option value="resume">Resume with guidance</option>}
        </select>
      </label>
      {findingDecision && (
        <>
          <fieldset disabled={busy}>
            <legend>Open findings (select at least one)</legend>
            <div className="inline-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setSelected(findings.map((f) => f.id))}
              >
                Select all findings
              </button>
              <button type="button" className="secondary-button" onClick={() => setSelected([])}>
                Clear selection
              </button>
            </div>
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
            Decision rationale (required)
            <textarea
              required
              maxLength={4000}
              value={rationale}
              disabled={busy}
              onChange={(e) => setRationale(e.target.value)}
            />
          </label>
        </>
      )}
      <label className="field">
        Answers and guidance (optional)
        <textarea
          maxLength={findingDecision ? 10000 : 16000}
          value={instructions}
          disabled={busy}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <p>
        Answer any open questions here. An unanswered question still requires your input; no action
        approves the final merge.
      </p>
      {grantsAttempts && (
        <>
          <label className="field">
            {focused ? 'Additional focused attempts' : 'Additional remediation attempts'}
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
            Used: {used}. Current allowance: {allowance}.
            {validRounds && (
              <>
                {' '}
                New allowance: {allowance + rounds}; {Math.max(0, allowance + rounds - used)}{' '}
                attempts available.
              </>
            )}
          </p>
          <p>
            This authorization adds the requested attempts and starts remediation, even when the
            current allowance is exhausted. Used counts do not reset. Each attempt is followed by
            review.
          </p>
          {focused && (
            <p>
              Only selected findings define the batch. Unselected findings still count toward the
              completion policy.
            </p>
          )}
        </>
      )}
      {action === 'defer-nits' && (
        <p>
          Deferral keeps selected nits open in history and starts independent review. Changed
          commits or finding details require a new decision. Required checks and plan obligations
          still apply.
        </p>
      )}
      {action === 'resume' && (
        <p>
          Resume continues the current step with this guidance and the existing allowance. It does
          not grant additional remediation attempts or select a findings batch.
        </p>
      )}
      <p id={hintId} role="status">
        {blocker ?? (busy ? 'Submitting decision…' : `${buttonLabel} is ready.`)}
      </p>
      <button
        className="primary-button"
        type="submit"
        aria-describedby={hintId}
        disabled={busy || !!blocker}
      >
        {buttonLabel}
      </button>
    </form>
  );
}
