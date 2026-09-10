import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { completionPolicySchema, controlWorkCycleRequestSchema } from './work-cycle.js';

it('bounds automation budgets and does not allow weakening major/minor gates', () => {
  expect(completionPolicySchema.safeParse(DEFAULT_COMPLETION_POLICY).success).toBe(true);
  for (const invalid of [
    { maxNits: -1 },
    { maxNits: 1.5 },
    { maxNits: 101 },
    { maxRemediationRounds: 21 },
    { maxRunMinutes: 0 },
    { maxMinor: 1 },
  ]) {
    expect(
      completionPolicySchema.safeParse({ ...DEFAULT_COMPLETION_POLICY, ...invalid }).success,
    ).toBe(false);
  }
  expect(controlWorkCycleRequestSchema.safeParse({ action: 'resume' }).success).toBe(false);
  expect(
    controlWorkCycleRequestSchema.safeParse({ action: 'merge', expectedVersion: 1 }).success,
  ).toBe(false);
});
