import type { AuthorizeWorkCycleRemediationRequest } from '@craftingtable/contracts';
import { remediationAllowance, type WorkCycle } from '@craftingtable/domain';
import { useState } from 'react';
import { About } from '../../components/About.js';
import { type AnswerDraft, answerFieldId, useAnswerDraft } from './answer-draft.js';

export type CycleRemediationGrant = Pick<
  AuthorizeWorkCycleRemediationRequest,
  'additionalRounds' | 'instructions'
>;

export function CycleRemediationRecovery({
  cycle,
  disabled,
  onAuthorize,
  answer,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  onAuthorize: (input: CycleRemediationGrant) => void;
  /** The stop's answer as its decision holds it (R-C16); the form's own state otherwise. */
  answer?: AnswerDraft;
}) {
  const [additionalRounds, setAdditionalRounds] = useState(1);
  const [instructions, setInstructions] = useAnswerDraft(answer);
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
        All {remediationAllowance(cycle)} authorized remediation attempts are used. Authorizing more
        starts remediation at once; it does not resume a paused roadmap.
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
          id={answerFieldId(cycle.id)}
          value={instructions}
          maxLength={16000}
          disabled={disabled}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <About label="About more remediation">
        <p>
          Remediation continues from the current review and keeps the worktree, findings, agent
          settings and completed-round history. Guidance is added to the existing cycle
          instructions; answer any open questions in it. A valid completed review is required.
          Invalid reports and integration conflicts use their own recovery controls.
        </p>
      </About>
      {valid && (
        <p>New total allowance: {remediationAllowance(cycle) + additionalRounds} attempts.</p>
      )}
      <button type="submit" className="primary-button" disabled={disabled || !valid}>
        Authorize more remediation
      </button>
    </form>
  );
}
