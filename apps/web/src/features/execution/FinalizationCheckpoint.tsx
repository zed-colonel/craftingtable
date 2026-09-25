import type {
  ControlFinalizationRequest,
  ExecutionStatusResponse,
  FinalizationView,
} from '@craftingtable/contracts';
import {
  type FinalizationAgentSelection,
  finalizationProfile,
  remediationAllowance,
  remediationUsed,
} from '@craftingtable/domain';
import { useId, useState } from 'react';

import { FinalizationRecoveryAgent } from './FinalizationRecoveryAgent.js';

type CheckpointAction = Extract<
  ControlFinalizationRequest['action'],
  'remediate-findings' | 'authorize-remediation' | 'resume'
>;

export function FinalizationCheckpoint({
  view,
  busy,
  backends = [],
  onDecide,
}: {
  view: FinalizationView;
  busy: boolean;
  backends?: ExecutionStatusResponse['backends'];
  onDecide: (input: ControlFinalizationRequest) => void;
}) {
  const findings = view.checkpointFindings;
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<CheckpointAction>(() =>
    findings.length
      ? 'remediate-findings'
      : view.canAuthorizeRemediation
        ? 'authorize-remediation'
        : 'resume',
  );
  const [rationale, setRationale] = useState('');
  const [instructions, setInstructions] = useState('');
  const [rounds, setRounds] = useState(1);
  const hintId = useId();
  const [agentMode, setAgentMode] = useState<'keep' | 'switch' | 'restore'>('keep');
  const [agent, setAgent] = useState<FinalizationAgentSelection>(() => {
    const profile =
      view.cycle && view.finalization.finalReview
        ? finalizationProfile(view.finalization, view.cycle)
        : undefined;
    return {
      backend: profile?.backend ?? 'claude-code',
      ...(profile?.model ? { model: profile.model } : {}),
      ...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
    };
  });
  const focused = action === 'remediate-findings';
  const findingDecision = focused;
  const grantsAttempts = focused || action === 'authorize-remediation';
  const allowance = view.cycle
    ? remediationAllowance(view.cycle)
    : view.finalization.policy.maxRemediationRounds;
  const used = view.cycle ? remediationUsed(view.cycle) : 0;
  const validRounds = Number.isInteger(rounds) && rounds >= 1 && rounds <= 20;
  const blocker =
    findingDecision && !selected.length
      ? 'Select at least one finding to continue.'
      : findingDecision && !rationale.trim()
        ? 'Enter a disposition rationale to continue.'
        : grantsAttempts && !validRounds
          ? 'Choose between 1 and 20 additional attempts.'
          : agentMode === 'switch' && !backends.some((b) => b.kind === agent.backend && b.available)
            ? 'Choose an available backend for recovery.'
            : undefined;
  const buttonLabel = {
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
          ...(agentMode === 'switch'
            ? { agentOverride: agent }
            : agentMode === 'restore'
              ? { agentOverride: null }
              : {}),
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
            <option value="remediate-findings">Address selected findings</option>
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
                  {f.id} · {f.category ? `${f.category} · ` : ''}
                  {f.severity} · {f.title}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            Disposition rationale (required)
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
            Adds the requested attempts and starts remediation, even when the allowance is
            exhausted. Used counts do not reset; review follows each attempt.
          </p>
          {focused && (
            <p>
              Only selected findings define the batch. Unselected findings still count toward the
              completion policy.
            </p>
          )}
        </>
      )}
      {action === 'resume' && (
        <p>
          Resume continues the current step with this guidance and the existing allowance. It does
          not grant additional remediation attempts or select a findings batch.
        </p>
      )}
      {!!backends.length && view.cycle && (
        <FinalizationRecoveryAgent
          mode={agentMode}
          onMode={setAgentMode}
          value={agent}
          onChange={setAgent}
          current={view.cycle.finalizationAgentOverride}
          backends={backends}
          disabled={busy}
        />
      )}
      <p id={hintId} role="status">
        {blocker ?? (busy ? 'Submitting…' : `${buttonLabel} is ready.`)}
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
