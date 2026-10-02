import { useState } from 'react';

/**
 * A stop's answer, as its decision holds it (R-C16 16b review): the operator's draft for the
 * stop's own control, kept while that control is hidden (an investigation runs) and added to,
 * never replaced, by an investigation's proposals.
 */
export interface AnswerDraft {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The answer field's id, which Use proposed answers brings into view. */
export const answerFieldId = (cycleId: string) => `cycle-answer-${cycleId}`;

/** What the stop's controls accept (CTRL contracts: 16,000 characters). */
export const ANSWER_LIMIT = 16_000;

/** The draft, or the form's own state where no decision holds one. */
export function useAnswerDraft(draft?: AnswerDraft): readonly [string, (value: string) => void] {
  const [own, setOwn] = useState('');
  return draft ? [draft.value, draft.onChange] : [own, setOwn];
}

/** The draft with `text` added after it, cut to what the control accepts. */
export function appendAnswer(draft: string, text: string): string {
  const joined = draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text;
  if (joined.length <= ANSWER_LIMIT) return joined;
  const note = '\n… (cut to fit; the full proposals are above)';
  return joined.slice(0, ANSWER_LIMIT - note.length) + note;
}
