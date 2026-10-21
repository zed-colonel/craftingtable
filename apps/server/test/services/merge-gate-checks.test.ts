import { asAgentRunId, asWorktreeId, type WorkCycle } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  automationApproved,
  finalCandidateMoved,
  finalReviewReady,
  planPromotionUnapproved,
  retargetRequired,
} from '../../src/services/merge/gate.js';

/**
 * The merge's checks that read no Git (R-B7 scheduler half, increment 10): pure functions of the
 * merge gate over what the executor read, each the condition `mergeWorktree` asked inline. The
 * half's mutation round found three of them held by no row (a roadmap's delegation of a plan's
 * promotion, the final review's phase, the cycle's approved run); this table holds every operand.
 */

const tree = asWorktreeId('tree-1');
const review = asAgentRunId('review-1');
const approval = { expectedHeadSha: 'h'.repeat(40), expectedTargetSha: 't'.repeat(40) };
const cycle = (changes: Partial<WorkCycle> = {}) =>
  ({
    status: 'awaiting-merge',
    polishPhase: 'final-review',
    currentRunId: review,
    reviewHeadSha: 'h'.repeat(40),
    ...changes,
  }) as WorkCycle;

describe('planPromotionUnapproved', () => {
  const plan = { planVersionId: 'plan-1' } as never;
  it('lets a worktree with no plan merge whatever the approval', () => {
    expect(planPromotionUnapproved({}, undefined, false, true)).toBe(false);
  });
  it('lets a plan merge only with the operator’s own final approval, never delegated', () => {
    expect(planPromotionUnapproved(plan, approval, true, false)).toBe(false);
    expect(planPromotionUnapproved(plan, undefined, true, false)).toBe(true);
    expect(planPromotionUnapproved(plan, approval, false, false)).toBe(true);
    expect(planPromotionUnapproved(plan, approval, true, true)).toBe(true);
  });
});

describe('finalReviewReady', () => {
  const active = { status: 'active', worktreeId: tree } as const;
  it('is ready for an active finalization on this tree whose cycle awaits the final review’s merge', () => {
    expect(finalReviewReady(active, tree, cycle())).toBe(true);
  });
  it('is not ready on any one operand missing', () => {
    expect(finalReviewReady({ ...active, status: 'completed' } as never, tree, cycle())).toBe(
      false,
    );
    expect(finalReviewReady(active, asWorktreeId('tree-2'), cycle())).toBe(false);
    expect(finalReviewReady(active, tree, undefined)).toBe(false);
    expect(finalReviewReady(active, tree, cycle({ polishPhase: undefined }))).toBe(false);
    expect(finalReviewReady(active, tree, cycle({ status: 'running' }))).toBe(false);
  });
});

describe('automationApproved', () => {
  it('approves with no cycle, or a cycle that approved exactly this review and head', () => {
    expect(automationApproved(undefined, review, 'h'.repeat(40))).toBe(true);
    expect(automationApproved(cycle(), review, 'h'.repeat(40))).toBe(true);
  });
  it('refuses a cycle not awaiting its merge, on another run, or at another head', () => {
    expect(automationApproved(cycle({ status: 'paused' }), review, 'h'.repeat(40))).toBe(false);
    expect(
      automationApproved(cycle({ currentRunId: asAgentRunId('later') }), review, 'h'.repeat(40)),
    ).toBe(false);
    expect(automationApproved(cycle(), review, 'x'.repeat(40))).toBe(false);
  });
});

describe('retargetRequired', () => {
  it('asks for a retarget only when the merge names another target than the reviewed one', () => {
    expect(retargetRequired(undefined, { targetBranch: 'main' })).toBe(false);
    expect(retargetRequired('main', { targetBranch: 'main' })).toBe(false);
    expect(retargetRequired('release', { targetBranch: 'main' })).toBe(true);
  });
});

describe('finalCandidateMoved', () => {
  const reviewed = { headSha: approval.expectedHeadSha, targetSha: approval.expectedTargetSha };
  it('has nothing to compare without a final approval', () => {
    expect(finalCandidateMoved(undefined, { headSha: 'a', targetSha: 'b' })).toBe(false);
  });
  it('finds the candidate or its destination moved since the approval', () => {
    expect(finalCandidateMoved(approval, reviewed)).toBe(false);
    expect(finalCandidateMoved(approval, { ...reviewed, headSha: 'x'.repeat(40) })).toBe(true);
    expect(finalCandidateMoved(approval, { ...reviewed, targetSha: 'x'.repeat(40) })).toBe(true);
  });
});
