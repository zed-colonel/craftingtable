import { expect, it } from 'vitest';
import { finalizationProfile } from '../src/finalization.js';
import { FINALIZATION_STAGE_KINDS, staysFollowUp } from '../src/finalization-stages.js';

const review = {
  backend: 'claude-code' as const,
  permissionMode: 'edit-only' as const,
  model: 'review-model',
};
const implement = { ...review, permissionMode: 'auto' as const, model: 'implement-model' };
const finalReview = { ...review, model: 'final-model' };
const stages = FINALIZATION_STAGE_KINDS.map((kind) => ({
  id: kind,
  kind,
  name: kind,
  workItemSourceIds: [],
  instructions: '',
  review: { ...review, model: `${kind}-review` },
  implement: { ...implement, model: `${kind}-implement` },
  policy: { maxNits: 0, maxRemediationRounds: 1, maxRunMinutes: 30 },
  requiredChecks: [],
}));

it.each(['review', 'remediate'] as const)(
  'keeps the recovery selection for a stage %s step and restores the exact configured profile',
  (step) => {
    const value = { stages, finalReview };
    const cycle: Parameters<typeof finalizationProfile>[1] = {
      step,
      finalizationProgress: {
        stageIndex: 2,
        stages: [],
        obligations: [],
        followUps: [],
        decisions: [],
      },
      finalizationAgentOverride: { backend: 'codex' },
    };
    const configured = step === 'review' ? stages[2]!.review : stages[2]!.implement;
    expect(finalizationProfile(value, cycle)).toEqual({
      backend: 'codex',
      permissionMode: configured.permissionMode,
    });
    expect(finalizationProfile(value, { ...cycle, finalizationAgentOverride: null })).toEqual(
      configured,
    );
  },
);

it('falls back to the final reviewer for a record without stages', () => {
  expect(
    finalizationProfile({ finalReview }, { step: 'review', finalizationAgentOverride: null }),
  ).toEqual(finalReview);
});

// R-C7 D5: a nit parked at a spent stage allowance stays follow-up work only while it stays a
// nit; an optional suggestion only while it stays optional.
it.each([
  ['parked nit, still a nit', 'correctness', 'nit', 'correctness', 'nit', true],
  ['parked nit, now minor', 'correctness', 'nit', 'correctness', 'minor', false],
  ['optional idea, still optional', 'polish', 'minor', 'polish', 'minor', true],
  ['optional idea, now a correctness nit', 'polish', 'minor', 'correctness', 'nit', false],
] as const)('%s', (_, parkedCategory, parkedSeverity, category, severity, stays) => {
  const finding = (c: string, s: typeof severity) => ({
    id: 'F-1',
    severity: s,
    status: 'open' as const,
    title: 'Finding',
    explanation: 'Why.',
    recommendation: 'Fix.',
    category: c as 'correctness',
  });
  const parked = finding(parkedCategory, parkedSeverity);
  expect(staysFollowUp(parked, finding(category, severity))).toBe(stays);
  expect(staysFollowUp(parked, { ...finding(category, severity), status: 'resolved' })).toBe(false);
});
