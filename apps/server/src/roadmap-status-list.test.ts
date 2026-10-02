import { roadmapStatusListSchema } from '@craftingtable/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  entryIds,
  mutationHeaders,
  parallelFixture,
  type Ready,
  roadmapControl,
  roadmapId,
  saveRoadmapRequest,
  storedRoadmap,
} from './execution-test-support.js';

/**
 * R-E3a: a roadmap's status list says, for every open entry, its state, what it waits on and
 * who acts next, read from what the daemon recorded.
 */

afterEach(cleanupExecutionFixtures);

async function statusList(state: Ready) {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/status`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  const list = roadmapStatusListSchema.parse(response.json());
  return Object.fromEntries(list.entries.map((e) => [e.entryId, e]));
}

it('lists each open entry with what it waits on and who acts next (R-E3a, LIVE-08)', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await state.context.services.roadmapService.tick();
  await state.context.services.workCycleService.tick();
  const [first, second] = [entryIds[0]!, entryIds[1]!];
  const third = input.entries[2]!.id;

  // The first item's agent is at work; the others wait on it, which is other work.
  const running = await statusList(state);
  expect(running[first]).toMatchObject({
    state: 'running',
    actor: 'agent',
    waitsOn: { source: 'progress', runId: expect.any(String), since: expect.any(String) },
  });
  for (const id of [second, third])
    expect(running[id]).toMatchObject({
      state: 'dependency-blocked',
      actor: 'controller',
      waitsOn: { source: 'progress', reason: expect.stringContaining('AQ-01') },
    });

  // A cycle the operator paused opens no item: the scheduler's recorded wait says so.
  const cycleId = storedRoadmap(state).attempts[0]!.cycleId;
  const cycleControl = async (action: 'pause' | 'resume') => {
    const response = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycleId}/control`,
      headers: mutationHeaders(state),
      payload: {
        action,
        expectedVersion: state.context.storage.execution.cycles.find(state.workspaceId, cycleId)!
          .version,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  await cycleControl('pause');
  await state.context.services.roadmapService.tick();
  expect((await statusList(state))[first]).toMatchObject({
    actor: 'operator',
    waitsOn: { source: 'entry-wait', code: 'cycle-paused', cycleId },
  });
  await cycleControl('resume');

  // At the merge boundary the operator acts, through the inbox item that says why.
  await awaitRoadmapMerge(state, 0);
  await state.context.services.roadmapService.tick();
  const item = state.context.storage.attention
    .open(state.workspaceId)
    .find((i) => i.code === 'merge-approval')!;
  expect((await statusList(state))[first]).toMatchObject({
    state: 'awaiting-merge',
    actor: 'operator',
    waitsOn: {
      source: 'attention-item',
      code: 'merge-approval',
      attentionItemId: item.id,
      since: item.openedAt,
      reason: item.message,
    },
  });

  // An item the operator paused waits on the operator's own hold.
  const paused = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'pause', entryId: second, expectedVersion: storedRoadmap(state).version },
  });
  expect(paused.statusCode, paused.body).toBe(200);
  expect((await statusList(state))[second]).toMatchObject({
    actor: 'operator',
    waitsOn: { source: 'entry-hold', code: 'paused' },
  });
});
