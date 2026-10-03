import { expect, it } from 'vitest';
import { reviewContinuable } from '../../src/services/agent-run-service.js';

const parent = (fields: Record<string, unknown>) =>
  ({ id: 'run-1', status: 'failed', ...fields }) as Parameters<typeof reviewContinuable>[1];

it('continues a review on its pinned baseline only from a parent that allows it', () => {
  expect(reviewContinuable(true, undefined, undefined, undefined)).toBe(true);
  expect(
    reviewContinuable(false, parent({}), { reason: 'background-work-incomplete' }, undefined),
  ).toBe(true);
  expect(reviewContinuable(false, parent({}), { reason: 'other' }, undefined)).toBe(false);
  // A review the drain stopped in its adopted checks, before its agent started (R-G13
  // increment 3 verification): a completion continuation or service retry relaunches on it.
  expect(
    reviewContinuable(
      false,
      parent({ status: 'interrupted' }),
      { reason: 'daemon-drain' },
      undefined,
    ),
  ).toBe(true);
  // A drained review whose agent did start is not: its session is resumed or the operator asked.
  expect(
    reviewContinuable(
      false,
      parent({ status: 'interrupted', startedAt: '2026-09-30T00:00:00.000Z' }),
      { reason: 'daemon-drain' },
      undefined,
    ),
  ).toBe(false);
  expect(reviewContinuable(false, parent({}), undefined, undefined)).toBe(false);
});
