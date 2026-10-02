import { expect, it } from 'vitest';
import { ANSWER_LIMIT, appendAnswer } from './answer-draft.js';

// R-C16 16b verification: proposals are added after the operator's words, which are never cut.
it("adds text after the draft, and cuts only the added text to the control's limit", () => {
  expect(appendAnswer('', 'Proposals.')).toBe('Proposals.');
  expect(appendAnswer('  \n ', 'Proposals.')).toBe('Proposals.');
  expect(appendAnswer('Mine.  \n\n', 'Proposals.')).toBe('Mine.\n\nProposals.');
  const mine = `${'m'.repeat(15_000)}OPERATOR-END`;
  const joined = appendAnswer(mine, 'p'.repeat(5_000));
  expect(joined.length).toBeLessThanOrEqual(ANSWER_LIMIT);
  expect(joined.startsWith(`${mine}\n\n`)).toBe(true);
  expect(joined.endsWith('(cut to fit; the full proposals are above)')).toBe(true);
  // No room left: the operator's draft stays as it is.
  const full = 'f'.repeat(ANSWER_LIMIT - 10);
  expect(appendAnswer(full, 'Proposals.')).toBe(full);
  // A cut never leaves half of a surrogate pair.
  const emoji = appendAnswer('', '😀'.repeat(9_000));
  expect(/[\uD800-\uDBFF]\n…/.test(emoji)).toBe(false);
});
