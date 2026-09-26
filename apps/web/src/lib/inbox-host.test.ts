import type { AttentionItemView } from '@craftingtable/contracts';
import { expect, it } from 'vitest';
import { inboxHost } from './inbox-host.js';

const item = (changes: Partial<AttentionItemView>): AttentionItemView => ({
  id: 'item',
  subjectKey: 'cycle:c',
  code: 'service-failure-not-retryable',
  kind: 'attention',
  title: 'Title',
  message: 'Message',
  path: '/workspaces/ws/work-items/w',
  inboxPath: '/workspaces/ws/inbox/item',
  refs: { cycleId: 'c', workItemId: 'w', roadmapId: 'r', entryId: 'e' },
  blocks: 0,
  openedAt: '2026-09-25T11:00:00Z',
  pushedAt: null,
  ...changes,
});

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
      cycle: true,
      delegation: false,
      finalization: false,
      storage: false,
      run: false,
      roadmap: { open: false },
    });
  // Shared decisions and undeclared upstream transitions are decided in the roadmap's
  // dependency controls, so they open beside the cycle's resume.
  for (const code of ['shared-decision-required', 'upstream-transition-undeclared'] as const)
    expect(inboxHost(item({ code })).roadmap, code).toEqual({ open: true });
  // A held roadmap entry with stale evidence: its Re-verify control, brought into view.
  expect(
    inboxHost(
      item({
        subjectKey: 'roadmap:r:entry:e',
        code: 'evidence-not-current',
        refs: { roadmapId: 'r', entryId: 'e', workItemId: 'w' },
        actions: ['reverify'],
      }),
    ),
  ).toMatchObject({ cycle: false, roadmap: { open: true, focus: 'roadmap-entry-r-e' } });
});

it('hosts the merge form for a merge approval and the storage settings for host alerts', () => {
  expect(inboxHost(item({ code: 'merge-approval', kind: 'merge' }))).toMatchObject({
    cycle: true,
    delegation: true,
  });
  expect(
    inboxHost(item({ code: 'storage-pressure', refs: {}, subjectKey: 'storage:volumes' })),
  ).toEqual({
    cycle: false,
    delegation: false,
    finalization: false,
    storage: true,
    run: false,
  });
  expect(
    inboxHost(
      item({
        code: 'finalization-cleanup-blocked',
        refs: { finalizationId: 'f', planVersionId: 'p', projectId: 'pr' },
      }),
    ).finalization,
  ).toBe(true);
});
