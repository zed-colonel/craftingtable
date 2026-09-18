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

it('limits integration branch removal choices to explicit final promotion commands', () => {
  const input = { expectedVersion: 1, expectedCycleVersion: 2 };
  expect(
    controlFinalizationRequestSchema.safeParse({
      ...input,
      action: 'merge',
      removeIntegrationBranch: true,
    }).success,
  ).toBe(true);
  expect(
    controlFinalizationRequestSchema.safeParse({ ...input, action: 'remove-integration-branch' })
      .success,
  ).toBe(true);
  expect(
    controlFinalizationRequestSchema.safeParse({
      ...input,
      action: 'resume',
      removeIntegrationBranch: true,
    }).success,
  ).toBe(false);
  expect(
    controlFinalizationRequestSchema.safeParse({
      ...input,
      action: 'remove-integration-branch',
      branch: 'arbitrary',
    }).success,
  ).toBe(false);
});

it('bounds explicit work-item remediation grants and rejects allowance changes on Resume', () => {
  const request = { action: 'authorize-remediation', expectedVersion: 2, additionalRounds: 2 };
  expect(controlWorkCycleRequestSchema.parse(request)).toEqual({ ...request, instructions: '' });
  for (const additionalRounds of [0, -1, 21, 1.5])
    expect(controlWorkCycleRequestSchema.safeParse({ ...request, additionalRounds }).success).toBe(
      false,
    );
  expect(controlWorkCycleRequestSchema.safeParse({ ...request, action: 'resume' }).success).toBe(
    false,
  );
  expect(
    controlWorkCycleRequestSchema.safeParse({ ...request, instructions: 'x'.repeat(16001) })
      .success,
  ).toBe(false);
});

it('accepts bounded review guidance only on explicit review recovery commands', () => {
  const input = { action: 'resume', expectedVersion: 2, instructions: 'Use the saved policy.' };
  expect(controlWorkCycleRequestSchema.parse(input)).toEqual(input);
  expect(controlWorkCycleRequestSchema.parse({ ...input, action: 'review-again' }).action).toBe(
    'review-again',
  );
  expect(
    controlWorkCycleRequestSchema.safeParse({
      ...input,
      action: 'review-again',
      additionalRounds: 2,
    }).success,
  ).toBe(false);
  expect(
    controlWorkCycleRequestSchema.safeParse({
      ...input,
      action: 'review-again',
      instructions: 'x'.repeat(16001),
    }).success,
  ).toBe(false);
  for (const action of ['pause', 'stop'])
    expect(controlWorkCycleRequestSchema.safeParse({ ...input, action }).success).toBe(false);
  expect(
    controlWorkCycleRequestSchema.safeParse({ ...input, instructions: 'x'.repeat(16001) }).success,
  ).toBe(false);
});
