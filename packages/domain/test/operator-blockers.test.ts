import { describe, expect, it } from 'vitest';
import { operatorOwnsAll } from '../src/operator-blockers.js';

/**
 * R-E3b (R-A6 handoff e): one rule says when only the operator can move an entry by its
 * blockers, for the status list and the roadmap's setup item alike.
 */
describe('operatorOwnsAll', () => {
  const pin = { kind: 'evidence', code: 'upstream-pin-missing', message: 'Pin it.' } as const;
  it("holds when every blocker is the operator's setup or stop, upstream pins included", () => {
    expect(operatorOwnsAll([pin])).toBe(true);
    expect(
      operatorOwnsAll([
        pin,
        { kind: 'review', code: 'reviewer-assignment', message: 'Assign.' },
        { kind: 'authorization', code: 'binding-superseded', message: 'Rebind.' },
      ]),
    ).toBe(true);
  });
  it('does not hold with a controller blocker, a checkpoint, or none', () => {
    expect(
      operatorOwnsAll([pin, { kind: 'dependency', code: 'slice-not-merged', message: 'Merge.' }]),
    ).toBe(false);
    // A decision the operator settles has its own item, by its checkpoint.
    expect(
      operatorOwnsAll([
        {
          kind: 'evidence',
          code: 'decision-checkpoint-evidence',
          message: 'Approve.',
          refs: { checkpointId: 'ADR-1' },
        },
      ]),
    ).toBe(false);
    expect(operatorOwnsAll([])).toBe(false);
    expect(operatorOwnsAll(undefined)).toBe(false);
  });
});
