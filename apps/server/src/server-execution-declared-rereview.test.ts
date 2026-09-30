import { afterEach, expect, it, vi } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  commitFile,
  designDone,
  implementationDone,
  roadmapControl,
  runScopedFixtureCheck,
  scopeReport,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

/**
 * LIVE-24: the roadmap's own merge of a slice whose review did not run the adopted checks is
 * refused. The controller sends the slice back for one fresh review, which runs them; a review
 * that skips them again holds the entry with the refusal.
 */

afterEach(cleanupExecutionFixtures);

async function fixture(
  skips: number,
  beforeStart?: (f: Awaited<ReturnType<typeof supervisedMapFixture>>) => void,
) {
  const f = await supervisedMapFixture();
  const { state } = f;
  const ws = state.workspaceId;
  const reviews = new Map<string, number>();
  f.backend.replyForRequest = async (request) => {
    if (request.model === 'design-model') return designDone;
    const tree = state.context.storage.execution.worktrees
      .listActive(ws)
      .find((t) => t.path === request.cwd)!;
    if (request.model === 'review-model') {
      const key = `${tree.executionScope!.kind}:${tree.executionScope!.sourceId}`;
      const seen = (reviews.get(key) ?? 0) + 1;
      reviews.set(key, seen);
      // The first slice's first reviews skip the adopted check, as LIVE-23's agents did.
      if (!(tree.executionScope!.kind === 'slice' && seen <= skips))
        await runScopedFixtureCheck(request);
      return {
        resultText:
          '## Open questions\nnone\n## Review report\n' +
          scopeReport({ ...state, workItemId: tree.workItemId! }, tree.executionScope!),
      };
    }
    commitFile(request.cwd, `slice-${tree.id}.txt`, 'Implemented bounded slice');
    return implementationDone;
  };
  f.service.save(f.auth, ws, f.input);
  await adoptSupervisedMap(f);
  beforeStart?.(f);
  expect((await roadmapControl(state, 'start')).statusCode).toBe(200);
  return { f, state, ws, reviews };
}

const slice = (state: Awaited<ReturnType<typeof fixture>>['state'], ws: string) =>
  state.context.storage.execution.worktrees
    .listForWorkItem(ws as never, state.workItemId)
    .filter((t) => t.executionScope?.kind === 'slice');

it('sends a slice whose review skipped the adopted checks back for one fresh review, then merges it (LIVE-24)', {
  timeout: 45000,
}, async () => {
  const { state, ws, reviews } = await fixture(1);
  await waitFor(
    () => {
      const hold = Object.values(storedRoadmap(state).entryHolds ?? {}).find(
        (h) => h.status === 'needs-attention',
      );
      if (hold) throw new Error(hold.reason);
      return slice(state, ws).some((t) => t.mergedAt);
    },
    'the slice merged after a fresh review',
    35000,
  );
  expect(
    [...reviews.entries()].filter(([k]) => k.startsWith('slice:')).map(([, n]) => n),
  ).toContain(2);
});

it('holds the entry with the refusal when the fresh review skips the adopted checks again (LIVE-24)', {
  timeout: 45000,
}, async () => {
  const { state, ws, reviews } = await fixture(99);
  await waitFor(
    () =>
      Object.values(storedRoadmap(state).entryHolds ?? {}).some(
        (h) => h.status === 'needs-attention' && h.reason.includes('ct-check --declared fixture'),
      ),
    'the refusal held',
    35000,
  );
  expect(slice(state, ws).some((t) => t.mergedAt)).toBe(false);
  // The item says why, and does not offer a merge the roadmap owns and could not make.
  state.context.services.roadmapService.syncAttention(true);
  const cycle = state.context.storage.execution.cycles.activeForWorktree(
    ws as never,
    slice(state, ws)[0]!.id,
  )!;
  const item = state.context.storage.attention
    .open(ws as never)
    .find((i) => i.subjectKey === `cycle:${cycle.id}`);
  expect(item?.kind).toBe('attention');
  expect(item?.message).toContain('The roadmap holds this item: The review needs');
  // One fresh review, not a loop.
  const counts = [...reviews.entries()].filter(([k]) => k.startsWith('slice:')).map(([, n]) => n);
  expect(Math.max(...counts)).toBe(2);
});

it('does not start the fresh review once the operator has paused the roadmap during the merge (LIVE-24 review)', {
  timeout: 45000,
}, async () => {
  let paused: Promise<unknown> | undefined;
  const { state, ws, reviews } = await fixture(99, (f) => {
    const execution = f.state.context.services.executionService;
    const merge = execution.mergeWorktree.bind(execution);
    vi.spyOn(execution, 'mergeWorktree').mockImplementation(async (...args) => {
      // The operator pauses while the roadmap's merge is under way.
      paused ??= roadmapControl(f.state, 'pause');
      await paused;
      return merge(...args);
    });
  });
  await waitFor(
    () => paused !== undefined && storedRoadmap(state).status === 'paused',
    'paused',
    35000,
  );
  await state.context.services.roadmapService.tick();
  const counts = [...reviews.entries()].filter(([k]) => k.startsWith('slice:')).map(([, n]) => n);
  expect(Math.max(...counts)).toBe(1);
  expect(
    state.context.storage.execution.cycles
      .listForWorkspace(ws as never)
      .some((c) => c.status === 'running' && c.step === 'review'),
  ).toBe(false);
});
