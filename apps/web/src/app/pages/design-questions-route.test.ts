import type { AttentionItemView } from '@craftingtable/contracts';
import { asWorkItemId, asWorkspaceId, type WorkCycle } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { designQuestionsRoute } from './RunRoute.js';

/**
 * R-E4: the run page's "Resolve design questions" goes to the inbox item that carries its cycle's
 * stop, and to the work item only when no item does (the in-place fallback, E4-2).
 */

const workspaceId = asWorkspaceId('workspace-1');
const workItemId = asWorkItemId('item-1');
const cycle = (status: WorkCycle['status'], step: WorkCycle['step'] = 'design') =>
  ({ id: 'cycle-1', worktreeId: 'tree-1', status, step }) as WorkCycle;
const item = (subjectKey: string) => ({ id: 'attention-1', subjectKey }) as AttentionItemView;
const run = { worktreeId: 'tree-1', workItemId };

it('opens the inbox item that carries the stopped design cycle', () => {
  expect(
    designQuestionsRoute(workspaceId, run, [cycle('needs-attention')], [item('cycle:cycle-1')]),
  ).toEqual({ name: 'inbox', workspaceId, itemId: 'attention-1' });
});

it('falls back to the work item when no inbox item carries the stop', () => {
  expect(
    designQuestionsRoute(workspaceId, run, [cycle('paused')], [item('cycle:another-cycle')]),
  ).toEqual({ name: 'work-item', workspaceId, workItemId });
});

it('offers nothing when the run’s cycle is not stopped at design', () => {
  expect(designQuestionsRoute(workspaceId, run, [cycle('running')], [])).toBeUndefined();
  expect(
    designQuestionsRoute(workspaceId, run, [cycle('needs-attention', 'review')], []),
  ).toBeUndefined();
  expect(
    designQuestionsRoute(workspaceId, { ...run, workItemId: undefined }, [cycle('paused')], []),
  ).toBeUndefined();
});
