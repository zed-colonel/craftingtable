import { describe, expect, it } from 'vitest';
import { InvariantError, required } from '../src/invariant.js';

describe('required (R-B7, the non-null rule)', () => {
  it('returns a present value as it is, falsy ones included', () => {
    const value = { id: 'a' };
    expect(required(value, 'the value')).toBe(value);
    expect(required(0, 'a count')).toBe(0);
    expect(required('', 'a text')).toBe('');
    expect(required(false, 'a flag')).toBe(false);
  });

  it.each([undefined, null])('throws a plain error naming what was absent: %s', (absent) => {
    let thrown: unknown;
    try {
      required(absent, "the cycle's work item");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvariantError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invariant failed: the cycle's work item");
    expect((thrown as Error).name).toBe('InvariantError');
  });
});
