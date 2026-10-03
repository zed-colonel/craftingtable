import { expect, it } from 'vitest';
import {
  agentSelections,
  cycleProfilesFromDefaults,
  profileForPurpose,
  cycleProfilePurpose,
  selectAgent,
} from '../src/agent-profiles.js';
import type { WorkCycle } from '../src/work-cycle.js';
const base = {
  backend: 'codex' as const,
  model: 'gpt-6-astra',
  permissionMode: 'edit-only' as const,
  reasoningEffort: 'high' as const,
};
it('seeds independent remediation while specialists inherit their effective base profile', () => {
  const p = cycleProfilesFromDefaults(
    [
      { ...base, role: 'implement', stored: true },
      { ...base, role: 'remediate', model: 'gpt-6-sol', reasoningEffort: 'medium', stored: true },
      { ...base, role: 'security', model: 'custom-security', stored: false },
    ],
    base,
  );
  expect(p.remediate.model).toBe('gpt-6-sol');
  expect(p.security).toBeUndefined();
  expect(profileForPurpose(p, 'conflict')).toEqual(p.remediate);
  expect(profileForPurpose(p, 'security')).toEqual(p.review);
  expect(agentSelections(p).remediate).not.toHaveProperty('permissionMode');
});
it('keeps specialist choices separate from permissions and immutable original step choices', () => {
  const p = cycleProfilesFromDefaults(
    [{ ...base, role: 'security', model: 'security-model', stored: true }],
    base,
  );
  expect(profileForPurpose(p, 'security')).toEqual({ ...base, model: 'security-model' });
  expect(p.review.model).toBe('gpt-6-astra');
});
it.each([
  ['security', 'security'],
  ['checkpoint', 'checkpoint'],
  ['reassessment', 'investigation'],
] as const)('selects the %s specialist for its separate review', (kind, purpose) => {
  expect(
    cycleProfilePurpose({ step: 'review', workflow: { activeReview: { kind } } } as WorkCycle),
  ).toBe(purpose);
});
it('selects parent acceptance only for its review scope', () => {
  expect(
    cycleProfilePurpose({
      step: 'review',
      executionScope: { kind: 'parent-acceptance' },
    } as WorkCycle),
  ).toBe('acceptance');
  expect(
    cycleProfilePurpose({
      step: 'review',
      executionScope: { kind: 'slice-verification' },
    } as WorkCycle),
  ).toBe('review');
});

it("keeps a Claude profile's reasoning effort, as a Codex one's (operator decision 2026-09-28)", () => {
  expect(selectAgent({ backend: 'claude-code', model: 'opus', reasoningEffort: 'high' })).toEqual({
    backend: 'claude-code',
    model: 'opus',
    reasoningEffort: 'high',
  });
});
