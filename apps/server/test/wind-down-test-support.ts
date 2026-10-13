import type { WorkCycle } from '@craftingtable/domain';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import {
  awaitRoadmapMerge,
  designDone,
  implementationDone,
  mutationHeaders,
  parallelFixture,
  present,
  type Ready,
  reviewText,
  roadmapControl,
  roadmapId,
  saveRoadmapRequest,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/** Fixtures for settling a roadmap (R-B11). */

/**
 * A parallel roadmap with its first item awaiting merge and an independent third item whose
 * design run is held live until `release` is called.
 */
export async function settleFixture() {
  const fixture = await parallelFixture({ independentThird: true });
  const { state, backend, input } = fixture;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? itemAt(state, request.cwd) === fixture.third
        ? { ...designDone, release: held }
        : designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  const thirdEntry = present(input.entries[2]).id;
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  await waitFor(
    () =>
      storedRoadmap(state).attempts.some(
        (a) =>
          a.entryId === thirdEntry &&
          state.context.storage.execution.runs.liveForWorktree(state.workspaceId, a.worktreeId)
            .length > 0,
      ),
    'the third item running',
  );
  const third = present(storedRoadmap(state).attempts.find((a) => a.entryId === thirdEntry));
  return { ...fixture, first, third, release: () => release() };
}

/** The work item whose worktree a launch runs in. */
export function itemAt(state: Ready, cwd: string) {
  return state.context.storage.execution.worktrees
    .listActive(state.workspaceId)
    .find((tree) => tree.path === cwd)?.workItemId;
}

export function cycleOf(state: Ready, id: string): WorkCycle {
  return present(state.context.storage.execution.cycles.find(state.workspaceId, id as never));
}

export async function stop(
  state: Ready,
  expectedVersion = storedRoadmap(state).version,
): Promise<LightMyRequestResponse> {
  return state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'stop', expectedVersion },
  });
}

/** The workspace's audit log, oldest first. */
export function auditLog(state: Ready) {
  return [
    ...state.context.storage.audit.listWorkspace({ workspaceId: state.workspaceId, limit: 1000 }),
  ].reverse();
}

export function windDownAudit(state: Ready) {
  return auditLog(state).filter((e) => e.action === 'roadmap.wind-down');
}
