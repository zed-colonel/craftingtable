import { expect, it } from 'vitest';
import { finalizationProfile } from './finalization.js';
import { FINALIZATION_STAGE_KINDS } from './finalization-stages.js';

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
