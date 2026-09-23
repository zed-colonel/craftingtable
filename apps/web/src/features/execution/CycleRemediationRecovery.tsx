import type { AuthorizeWorkCycleRemediationRequest } from '@craftingtable/contracts';
import { remediationAllowance, type WorkCycle } from '@craftingtable/domain';
import { useState } from 'react';

export type CycleRemediationGrant = Pick<
  AuthorizeWorkCycleRemediationRequest,
  'additionalRounds' | 'instructions'
>;

export function CycleRemediationRecovery({
  cycle,
  disabled,
  onAuthorize,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  onAuthorize: (input: CycleRemediationGrant) => void;
}) {
  const [additionalRounds, setAdditionalRounds] = useState(1);
  const [instructions, setInstructions] = useState('');
  const valid =
    Number.isInteger(additionalRounds) && additionalRounds >= 1 && additionalRounds <= 20;
  return (
    <form
      aria-label="Remediation recovery"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && valid) onAuthorize({ additionalRounds, instructions });
      }}
    >
      <h3>Continue remediation</h3>
      <p>
        This cycle has used all {remediationAllowance(cycle)} authorized remediation attempts.
        Authorize additional attempts to continue from the current review, preserving the worktree,
        findings, agent settings, and completed-round history. This starts remediation immediately;
        it does not resume a paused roadmap.
      </p>
      <label className="field">
        Additional remediation attempts
        <input
          type="number"
          min={1}
          max={20}
          step={1}
          required
          value={Number.isNaN(additionalRounds) ? '' : additionalRounds}
          disabled={disabled}
          onChange={(event) => setAdditionalRounds(event.target.valueAsNumber)}
        />
      </label>
      <label className="field">
        Guidance for the next run (optional)
        <textarea
          value={instructions}
          maxLength={16000}
          disabled={disabled}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <p className="muted">
        Guidance is added to the existing cycle instructions. A valid completed review is required.
        Answer any open questions in the guidance. Invalid reports and integration conflicts require
        their existing recovery controls.
      </p>
      {valid && (
        <p>New total allowance: {remediationAllowance(cycle) + additionalRounds} attempts.</p>
      )}
      <button type="submit" className="primary-button" disabled={disabled || !valid}>
        Authorize more remediation
      </button>
    </form>
  );
}
