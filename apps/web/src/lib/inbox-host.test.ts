import type { AttentionItemView } from '@craftingtable/contracts';
import { expect, it } from 'vitest';
import { inboxHost } from './inbox-host.js';

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
const none = { delegation: false, scopes: false, finalization: false, storage: false, run: false };

it('hosts the controls that resolve each stop of 2026-09-25', () => {
  // Service failures and work-item or scope-review questions: the cycle's resume, guidance
  // and scope-review forms; the roadmap's controls stay collapsed beside them.
  for (const code of [
    'service-failure-not-retryable',
    'service-retries-exhausted',
    'work-item-questions',
    'scope-review-open-questions',
    'scope-review-recovery',
  ] as const)
    expect(inboxHost(item({ code })), code).toEqual({
      ...none,
      cycle: true,
      roadmap: { open: false },
    });
  // Shared decisions and undeclared upstream transitions are decided in the roadmap's
  // dependency controls, so they open beside the cycle's resume.
  for (const code of ['shared-decision-required', 'upstream-transition-undeclared'] as const)
    expect(inboxHost(item({ code })).roadmap, code).toEqual({ open: true });
  // A held entry with stale evidence names its attempt's completed cycle, but is resolved
  // on the roadmap: its Re-verify control, brought into view, and no cycle controls.
  expect(
    inboxHost(
      item({
        subjectKey: 'roadmap:r:entry:e',
        code: 'evidence-not-current',
        refs: { roadmapId: 'r', entryId: 'e', workItemId: 'w', cycleId: 'c' },
        actions: ['reverify'],
      }),
    ),
  ).toEqual({ ...none, cycle: false, roadmap: { open: true, focus: 'roadmap-entry-r-e' } });
});

it('hosts the merge form, the slice evidence controls, finalization and storage settings', () => {
  expect(inboxHost(item({ code: 'merge-approval', kind: 'merge' }))).toMatchObject({
    cycle: true,
    delegation: true,
  });
  expect(inboxHost(item({ code: 'record-scope-evidence' }))).toMatchObject({
    cycle: true,
    scopes: true,
  });
  expect(inboxHost(item({ subjectKey: 'merge:t', code: 'merge-recovery-required' }))).toMatchObject(
    { cycle: false, delegation: true },
  );
  expect(
    inboxHost(item({ code: 'storage-pressure', refs: {}, subjectKey: 'storage:volumes' })),
  ).toEqual({ ...none, cycle: false, storage: true });
  expect(
    inboxHost(
      item({
        subjectKey: 'finalization:f',
        code: 'finalization-cleanup-blocked',
        refs: { finalizationId: 'f', planVersionId: 'p', projectId: 'pr' },
      }),
    ).finalization,
  ).toBe(true);
});

it('opens a checkpoint item at the form that settles it (R-C14, LIVE-11)', () => {
  const checkpoint = (code: AttentionItemView['code']) =>
    inboxHost(
      item({
        subjectKey: 'roadmap:r:checkpoint:LOCAL-TARGET',
        code,
        refs: { roadmapId: 'r' },
      }),
    ).roadmap;
  // Evidence the operator submits, and the saved plan they accept, each have their own form.
  expect(checkpoint('checkpoint-evidence')).toEqual({
    open: true,
    focus: 'runtime-evidence-roadmap-r-evidence',
  });
  expect(checkpoint('plan-acceptance')).toEqual({
    open: true,
    focus: 'runtime-evidence-roadmap-r-plan-acceptance',
  });
});

it('offers a split through the amendment form when automatic recovery stopped converging (R-C5)', () => {
  // The review's own item: its Delegate source fixes, and the roadmap's planning-amendment form
  // in view, where the remaining work can be split into a follow-up slice (ADR-049, offer only).
  expect(inboxHost(item({ code: 'recovery-not-converging' }))).toEqual({
    ...none,
    cycle: true,
    roadmap: { open: true, focus: 'map-amendments-r' },
  });
  // The roadmap's held entry, when no cycle item carries the stop: the same form.
  expect(
    inboxHost(
      item({
        subjectKey: 'roadmap:r:entry:e',
        code: 'recovery-not-converging',
        refs: { roadmapId: 'r', entryId: 'e', workItemId: 'w', cycleId: 'c' },
      }),
    ),
  ).toEqual({ ...none, cycle: false, roadmap: { open: true, focus: 'map-amendments-r' } });
});

it('opens a moved upstream pin at the dependency environment, beside the cycle (LIVE-15)', () => {
  // The refresh preview lives in the roadmap's dependency environment; the cycle's resume,
  // refused until the refresh is saved, stays beside it.
  expect(inboxHost(item({ code: 'upstream-pin-moved' }))).toEqual({
    ...none,
    cycle: true,
    roadmap: { open: true, focus: 'runtime-evidence-roadmap-r' },
  });
});
