import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { controlFinalizationRequestSchema } from './finalization.js';
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

it('requires an explicit bounded allowance only on finalization remediation authorization', () => {
  const request = { action: 'authorize-remediation', expectedVersion: 1, expectedCycleVersion: 2 };
  for (const additionalRounds of [undefined, 0, -1, 1.5, 21])
    expect(
      controlFinalizationRequestSchema.safeParse({ ...request, additionalRounds }).success,
    ).toBe(false);
  expect(
    controlFinalizationRequestSchema.safeParse({ ...request, additionalRounds: 1 }).success,
  ).toBe(true);
  expect(
    controlFinalizationRequestSchema.safeParse({ ...request, additionalRounds: 20 }).success,
  ).toBe(true);
  expect(
    controlFinalizationRequestSchema.safeParse({
      ...request,
      action: 'resume',
      additionalRounds: 1,
    }).success,
  ).toBe(false);
});

it('limits finalization agent overrides to recovery and keeps permissions out of the request', () => {
  for (const action of ['resume', 'defer-nits', 'remediate-findings', 'authorize-remediation']) {
    const request = {
      action,
      expectedVersion: 1,
      expectedCycleVersion: 2,
      ...(['defer-nits', 'remediate-findings'].includes(action)
        ? { findingIds: ['F-001'], rationale: 'Operator decision.' }
        : {}),
      ...(['remediate-findings', 'authorize-remediation'].includes(action)
        ? { additionalRounds: 1 }
        : {}),
    };
    for (const agentOverride of [
      null,
      { backend: 'codex' },
      { backend: 'codex', model: 'astra-fixture' },
    ])
      expect(
        controlFinalizationRequestSchema.safeParse({ ...request, agentOverride }).success,
      ).toBe(true);
    for (const agentOverride of [
      { backend: 'unknown' },
      { backend: 'codex', model: '' },
      { backend: 'codex', permissionMode: 'unrestricted' },
    ])
      expect(
        controlFinalizationRequestSchema.safeParse({ ...request, agentOverride }).success,
      ).toBe(false);
  }
  for (const action of ['merge', 'pause', 'stop', 'retry-cleanup', 'remove-worktree'])
    expect(
      controlFinalizationRequestSchema.safeParse({
        action,
        expectedVersion: 1,
        agentOverride: null,
      }).success,
    ).toBe(false);
});
