import { expect, it } from 'vitest';
import { finalizationProfile } from './finalization.js';

it.each(['assess', 'polish', 'verify', 'final-review'] as const)(
  'keeps the recovery selection through %s and restores the exact configured profile',
  (phase) => {
    const review = {
      backend: 'claude-code' as const,
      permissionMode: 'edit-only' as const,
      model: 'review-model',
    };
    const polish = { ...review, permissionMode: 'auto' as const, model: 'polish-model' };
    const finalReview = { ...review, model: 'final-model' };
    const value = { rounds: [{ review, polish, instructions: '' }], finalReview };
    const cycle: Parameters<typeof finalizationProfile>[1] = {
      step: phase === 'polish' ? 'remediate' : 'review',
      polishPhase: phase,
      polishRound: 0,
      profiles: { design: polish, implement: polish, remediate: polish, review },
      finalizationAgentOverride: { backend: 'codex' },
    };
    const configured =
      phase === 'polish' ? polish : phase === 'final-review' ? finalReview : review;
    expect(finalizationProfile(value, cycle)).toEqual({
      backend: 'codex',
      permissionMode: configured.permissionMode,
    });
    expect(finalizationProfile(value, { ...cycle, finalizationAgentOverride: null })).toEqual(
      configured,
    );
  },
);
