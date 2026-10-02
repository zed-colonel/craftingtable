import { useState, useSyncExternalStore } from 'react';

/**
 * A stop's answer (R-C16 16b review): the operator's draft for the stop's own control. It is
 * held for the browser session, above the page, so it survives the control being hidden while
 * an investigation runs, opening a run or another item and coming back, and the stop's item
 * being replaced. An investigation's proposals are added to it, never put in its place, and a
 * successful submit clears it.
 */
export interface AnswerDraft {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The draft was sent: it is not offered again. */
  readonly clear?: () => void;
}

/** The answer field's id, which Use proposed answers focuses. */
export const answerFieldId = (cycleId: string) => `cycle-answer-${cycleId}`;

/** What the stop's controls accept (their contracts: 16,000 characters). */
export const ANSWER_LIMIT = 16_000;

const drafts = new Map<string, string>();
/** `stop|investigation` pairs whose proposals were added: each once, and said of that one. */
const added = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The draft of one stop, `cycle:run:code`, shared by every view of that stop. */
export function useStopDraft(
  stop: string,
  investigationId?: string,
): AnswerDraft & {
  /** Adds an investigation's proposals, once. */
  readonly append: (text: string) => void;
  /** This investigation's proposals were already added to this stop's answer. */
  readonly added: boolean;
} {
  const value = useSyncExternalStore(subscribe, () => drafts.get(stop) ?? '');
  const pair = `${stop}|${investigationId ?? ''}`;
  const wasAdded = useSyncExternalStore(subscribe, () => added.has(pair));
  const set = (next: string) => {
    if (next) drafts.set(stop, next);
    else drafts.delete(stop);
    emit();
  };
  return {
    value,
    onChange: set,
    clear: () => set(''),
    added: wasAdded,
    append: (text) => {
      if (added.has(pair)) return;
      added.add(pair);
      set(appendAnswer(drafts.get(stop) ?? '', text));
    },
  };
}

/** For tests: forget every draft. */
export function clearAnswerDrafts(): void {
  drafts.clear();
  added.clear();
  emit();
}

/** The draft, or the form's own state where no decision holds one. */
export function useAnswerDraft(draft?: AnswerDraft): readonly [string, (value: string) => void] {
  const [own, setOwn] = useState('');
  return draft ? [draft.value, draft.onChange] : [own, setOwn];
}

/**
 * The draft with `text` added after it, within what the control accepts. Only the added text
 * is ever cut; the operator's own words are kept whole.
 */
export function appendAnswer(draft: string, text: string): string {
  const separator = draft.trim() ? '\n\n' : '';
  const kept = draft.trim() ? draft.trimEnd() : '';
  const room = ANSWER_LIMIT - kept.length - separator.length;
  if (text.length <= room) return kept + separator + text;
  const note = '\n… (cut to fit; the full proposals are above)';
  if (room <= note.length) return draft;
  let cut = text.slice(0, room - note.length);
  // Never leave half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return kept + separator + cut + note;
}
