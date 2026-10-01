import type { AttentionItemView } from '@craftingtable/contracts';
import { ATTENTION_ITEM_CODES } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { decisionsFor } from './registry.js';

// Refs as the daemon serves them: a roadmap-owned cycle names its roadmap and entry, and a
// roadmap's held entry names the cycle of its attempt.
const cycleRefs = {
  cycleId: 'c',
  worktreeId: 't',
  workItemId: 'w',
  projectId: 'p',
  planVersionId: 'v',
  roadmapId: 'r',
  entryId: 'e',
};
const item = (changes: Partial<AttentionItemView>): AttentionItemView => ({
  id: 'item',
  subjectKey: 'cycle:c',
  code: 'service-failure-not-retryable',
  kind: 'attention',
  title: 'Title',
  message: 'Message',
  path: '/workspaces/ws/work-items/w',
  inboxPath: '/workspaces/ws/inbox/item',
  refs: cycleRefs,
  blocks: 0,
  openedAt: '2026-09-25T11:00:00Z',
  pushedAt: null,
  ...changes,
});
const cycle = { kind: 'cycle' };
const setup = (step: string) => ({ kind: 'roadmap', part: { kind: 'setup', step } });

it('gives every code a decision, so no item is left without a way forward (R-A6)', () => {
  for (const code of ATTENTION_ITEM_CODES) {
    const subjectKey = code.startsWith('storage')
      ? 'storage:volumes'
      : ['merge-recovery-required', 'merge-cleanup-failed'].includes(code)
        ? 'merge:t'
        : code.startsWith('manual-')
          ? 'run:x'
          : 'cycle:c';
    expect(
      decisionsFor(item({ code, subjectKey, refs: { ...cycleRefs, runId: 'x' } })).length,
      code,
    ).toBeGreaterThan(0);
  }
});

it("decides a cycle's own stops on the cycle, and only there (R-A6 increment 2a)", () => {
  for (const code of [
    'service-failure-not-retryable',
    'service-retries-exhausted',
    'work-item-questions',
    'scope-review-open-questions',
    'scope-review-recovery',
    'design-open-questions',
    'integration-conflict',
  ] as const)
    expect(decisionsFor(item({ code })), code).toEqual([cycle]);
});

it('decides a roadmap decision in its setup step, beside the cycle that waits on it (LIVE-15, LIVE-18)', () => {
  expect(decisionsFor(item({ code: 'upstream-transition-undeclared' }))).toEqual([
    setup('dependency'),
    cycle,
  ]);
  expect(decisionsFor(item({ code: 'upstream-pin-moved' }))).toEqual([setup('dependency'), cycle]);
  expect(decisionsFor(item({ code: 'shared-decision-required' }))).toEqual([
    setup('decisions'),
    cycle,
  ]);
  // Outside a roadmap the cycle's own controls decide it.
  expect(
    decisionsFor(
      item({ code: 'shared-decision-required', refs: { ...cycleRefs, roadmapId: undefined } }),
    ),
  ).toEqual([cycle]);
});

it("decides a roadmap's held entry on the roadmap, not the cycle it names", () => {
  expect(
    decisionsFor(
      item({
        subjectKey: 'roadmap:r:entry:e',
        code: 'evidence-not-current',
        refs: { roadmapId: 'r', entryId: 'e', workItemId: 'w', cycleId: 'c' },
        actions: ['reverify'],
      }),
    ),
  ).toEqual([{ kind: 'roadmap', part: { kind: 'controls', entryId: 'e' } }]);
  // Codes a cycle shares are told apart by the subject.
  expect(
    decisionsFor(
      item({ subjectKey: 'roadmap:r', code: 'restart-resume', refs: { roadmapId: 'r' } }),
    ),
  ).toEqual([{ kind: 'roadmap', part: { kind: 'controls' } }]);
  expect(decisionsFor(item({ code: 'restart-resume' }))).toEqual([cycle]);
});

it('offers a split through the amendment form when automatic recovery stopped converging (R-C5)', () => {
  expect(decisionsFor(item({ code: 'recovery-not-converging' }))).toEqual([
    { kind: 'roadmap', part: { kind: 'amendments', entryId: 'e' } },
    cycle,
  ]);
  expect(
    decisionsFor(
      item({
        subjectKey: 'roadmap:r:entry:e',
        code: 'recovery-not-converging',
        refs: { roadmapId: 'r', entryId: 'e', workItemId: 'w', cycleId: 'c' },
      }),
    ),
  ).toEqual([{ kind: 'roadmap', part: { kind: 'amendments', entryId: 'e' } }]);
});

it('opens a checkpoint item at the step that settles it (R-C14, LIVE-11)', () => {
  const checkpoint = (code: AttentionItemView['code']) =>
    decisionsFor(
      item({ subjectKey: 'roadmap:r:checkpoint:LOCAL-TARGET', code, refs: { roadmapId: 'r' } }),
    );
  expect(checkpoint('checkpoint-evidence')).toEqual([setup('evidence')]);
  expect(checkpoint('plan-acceptance')).toEqual([setup('plan-acceptance')]);
  expect(checkpoint('architecture-decision')).toEqual([setup('decisions')]);
  expect(checkpoint('verification-setup')).toEqual([setup('verification')]);
});

it('decides merges, scope evidence, checks, runs, finalization, storage and protected refs by their own kinds', () => {
  expect(decisionsFor(item({ code: 'merge-approval', kind: 'merge' }))).toEqual([
    { kind: 'merge' },
  ]);
  expect(decisionsFor(item({ subjectKey: 'merge:t', code: 'merge-recovery-required' }))).toEqual([
    { kind: 'merge' },
  ]);
  expect(decisionsFor(item({ code: 'record-scope-evidence' }))).toEqual([
    { kind: 'scope-evidence' },
  ]);
  // Adopting is the way on; the cycle then resumes (R-G13, LIVE-30).
  for (const code of ['check-definition-changed', 'repository-checks-undeclared'] as const)
    expect(decisionsFor(item({ code }))).toEqual([{ kind: 'check-adoption' }, cycle]);
  expect(
    decisionsFor(
      item({
        subjectKey: 'run:x',
        code: 'manual-run-failed',
        refs: { workItemId: 'w', runId: 'x' },
      }),
    ),
  ).toEqual([{ kind: 'run' }, { kind: 'worktrees' }]);
  expect(
    decisionsFor(
      item({
        subjectKey: 'finalization:f',
        code: 'finalization-cleanup-blocked',
        refs: { finalizationId: 'f', planVersionId: 'p', projectId: 'pr' },
      }),
    ),
  ).toEqual([{ kind: 'finalization' }]);
  expect(
    decisionsFor(item({ code: 'storage-pressure', refs: {}, subjectKey: 'storage:volumes' })),
  ).toEqual([{ kind: 'storage' }]);
  expect(
    decisionsFor(item({ code: 'protected-ref-moved', refs: {}, subjectKey: 'protected-refs:w' })),
  ).toEqual([{ kind: 'acknowledge' }]);
});
