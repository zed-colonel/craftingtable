import { remediationAllowance, type WorkCycle } from '@craftingtable/domain';
import { About } from '../../components/About.js';
import { type AnswerDraft, answerFieldId, useAnswerDraft } from './answer-draft.js';

/**
 * Continue with guidance. Where the daemon offers a plain Resume beside it (R-C17 part 4, decision
 * 2), the guidance is optional: the one submit control resumes without it, and continues with it
 * once given. Where guidance is the only way on (a redirect, or questions to answer), it is
 * required, as before.
 */
export function CycleGuidanceRecovery({
  cycle,
  disabled,
  onContinue,
  answer,
  resumable = false,
}: {
  cycle: WorkCycle;
  disabled: boolean;
  /** The guidance, or undefined for a plain resume (only when `resumable`). */
  onContinue: (instructions: string | undefined) => void;
  /** The stop's answer as its decision holds it (R-C16); the form's own state otherwise. */
  answer?: AnswerDraft;
  /** The daemon also offers a plain Resume, so the guidance is optional. */
  resumable?: boolean;
}) {
  const [guidance, setGuidance] = useAnswerDraft(answer);
  const remaining = Math.max(0, remediationAllowance(cycle) - cycle.remediationRounds);
  const given = guidance.trim();
  return (
    <form
      id={`cycle-guidance-${cycle.id}`}
      className="stack-form"
      aria-label="Continue with guidance"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        if (given) onContinue(given);
        else if (resumable) onContinue(undefined);
      }}
    >
      <h3>{resumable ? 'Resume, or continue with guidance' : 'Continue with guidance'}</h3>
      <p>
        {remaining} remediation attempts remain. Does not approve findings or resume the roadmap.
      </p>
      <About label="About guidance">
        {resumable ? (
          <p>
            Read the current run’s outcome first. Without guidance, this resumes as Resume always
            has. With it, the step’s next run gets your answers or a changed approach, in a new
            bounded progress window, within the existing allowance.
          </p>
        ) : (
          <p>
            Read the current run’s outcome, then answer its questions or explain what changes the
            stalled approach. Continuing uses the existing allowance and opens a new bounded
            progress window.
          </p>
        )}
      </About>
      <label className="field">
        Answers and recovery guidance
        <textarea
          required={!resumable}
          rows={5}
          maxLength={16000}
          id={answerFieldId(cycle.id)}
          value={guidance}
          disabled={disabled}
          onChange={(event) => setGuidance(event.target.value)}
        />
      </label>
      <p className="hint">
        {resumable ? 'Optional. ' : ''}Guidance goes to the next agent run only; later steps do not
        inherit it.
      </p>
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || (!resumable && !given)}
      >
        {resumable && !given ? 'Resume automation' : 'Continue with guidance'}
      </button>
    </form>
  );
}
