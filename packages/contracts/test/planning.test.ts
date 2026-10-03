import { describe, expect, it } from 'vitest';
import { planImportResponseSchema } from '../src/planning.js';

describe('plan import response contract', () => {
  it('requires diagnostics on a failed validation outcome', () => {
    expect(
      planImportResponseSchema.safeParse({
        importAttemptId: 'attempt-1',
        outcome: 'failed-validation',
        diagnostics: [{ severity: 'error', code: 'invalid-yaml', message: 'bad' }],
      }).success,
    ).toBe(true);
    expect(
      planImportResponseSchema.safeParse({
        importAttemptId: 'attempt-1',
        outcome: 'failed-validation',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    expect(
      planImportResponseSchema.safeParse({ importAttemptId: 'a', outcome: 'approved' }).success,
    ).toBe(false);
  });
});
