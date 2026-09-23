import { useState } from 'react';
import { remediationAllowance, type WorkCycle } from '@craftingtable/domain';

export function CycleGuidanceRecovery({
  cycle,
  disabled,
  onContinue,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  onContinue: (instructions: string) => void;
}) {
  const [guidance, setGuidance] = useState('');
  const remaining = Math.max(0, remediationAllowance(cycle) - cycle.remediationRounds);
  return (
    <form
      id={`cycle-guidance-${cycle.id}`}
      className="stack-form"
      aria-label="Continue with guidance"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && guidance.trim()) onContinue(guidance.trim());
      }}
    >
      <h3>Continue with guidance</h3>
      <p>
        Read the current run’s outcome, then answer its questions or explain what changes the
        stalled approach. Guidance goes to the next agent run only; later steps do not inherit it.
      </p>
      <p>
        {remaining} remediation attempts remain. This uses the existing allowance and opens a new
        bounded progress window; it does not approve findings or resume roadmap scheduling.
      </p>
      <label className="field">
        Answers and recovery guidance
        <textarea
          required
          rows={5}
          maxLength={16000}
          value={guidance}
          disabled={disabled}
          onChange={(event) => setGuidance(event.target.value)}
        />
      </label>
      <button type="submit" className="primary-button" disabled={disabled || !guidance.trim()}>
        Continue with guidance
      </button>
    </form>
  );
}
