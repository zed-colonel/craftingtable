import {
  type WorkspaceEventEnvelope,
  workspaceEventEnvelopeSchema,
} from '@craftingtable/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GIT_DERIVED_FAMILIES, invalidationsFor, queryKeys } from './event-invalidations.js';
import { createQueryStore } from './query-store.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ws = 'ws-1';
/** An event of a kind, with the identifiers the table reads; the rest is not looked at. */
const event = (kind: string, fields: Record<string, unknown> = {}) =>
  ({ kind, workspaceId: ws, payload: {}, ...fields }) as unknown as WorkspaceEventEnvelope;

const KINDS = workspaceEventEnvelopeSchema.options.map((option) => option.shape.kind.value);

it('gives every workspace event kind a row, so no event is mapped by default (R-D4)', () => {
  for (const kind of KINDS) expect(() => invalidationsFor(event(kind)), kind).not.toThrow();
  expect(() => invalidationsFor(event('not-an-event-kind'))).toThrow(/no invalidation row/);
});

it("invalidates a roadmap's own status, and a definition's own environment, by the identifiers events carry", () => {
  expect(invalidationsFor(event('roadmap-changed', { payload: { roadmapId: 'r1' } }))).toEqual(
    expect.arrayContaining([queryKeys.roadmaps(ws), queryKeys.roadmapStatus(ws, 'r1')]),
  );
  expect(invalidationsFor(event('roadmap-changed', { payload: { roadmapId: 'r1' } }))).not.toEqual(
    expect.arrayContaining([['roadmap-status', ws]]),
  );
  const runtime = invalidationsFor(
    event('runtime-evidence-changed', { payload: { definitionId: 'd1', message: 'x' } }),
  );
  expect(runtime).toEqual(
    expect.arrayContaining([queryKeys.runtime(ws, 'd1'), queryKeys.crossProject(ws, 'd1')]),
  );
  expect(runtime).not.toEqual(expect.arrayContaining([['runtime', ws]]));
  // A plan's finalization changes with its own cycle's, runs' and worktrees' events.
  expect(
    invalidationsFor(event('work-cycle-changed', { payload: { planVersionId: 'p1' } })),
  ).toEqual(expect.arrayContaining([queryKeys.finalizations(ws, 'p1')]));
  expect(
    invalidationsFor(
      event('work-cycle-changed', { workItemId: 'w1', payload: { workItemId: 'w1' } }),
    ),
  ).not.toEqual(expect.arrayContaining([['finalizations', ws]]));
  expect(
    invalidationsFor(event('notifications-changed', { payload: { action: 'settings' } })),
  ).toEqual([queryKeys.notifications(ws)]);
});

it('makes no request for an event that changes nothing a mounted query shows (R-D4 done-when)', async () => {
  const store = createQueryStore({ debounceMs: 400, maxWaitMs: 2000 });
  const loads = vi.fn(async () => ({}));
  const mounted = [
    queryKeys.roadmaps(ws),
    queryKeys.roadmapStatus(ws, 'r1'),
    queryKeys.roadmapStatus(ws, 'r2'),
    queryKeys.runtime(ws, 'd1'),
    queryKeys.crossProject(ws, 'd1'),
    queryKeys.finalizations(ws, 'p1'),
    queryKeys.notifications(ws),
  ];
  for (const key of mounted) store.subscribe(key, loads, () => undefined);
  await vi.advanceTimersByTimeAsync(0);
  loads.mockClear();
  for (const unrelated of [
    event('repository-registered', { repositoryId: 'repo' }),
    event('repository-evidence-changed', { repositoryId: 'repo' }),
    event('workspace-updated'),
    event('project-created', { projectId: 'p' }),
  ])
    store.invalidate(invalidationsFor(unrelated));
  await vi.advanceTimersByTimeAsync(5000);
  expect(loads).not.toHaveBeenCalled();
  // A related event re-reads exactly the mounted queries it names: not r2's status.
  const changed = invalidationsFor(event('roadmap-changed', { payload: { roadmapId: 'r1' } }));
  store.invalidate(changed);
  await vi.advanceTimersByTimeAsync(5000);
  const named = mounted.filter((key) =>
    changed.some((prefix) => prefix.every((part, index) => key[index] === part)),
  );
  expect(named).not.toContainEqual(queryKeys.roadmapStatus(ws, 'r2'));
  expect(loads).toHaveBeenCalledTimes(named.length);
});

it("refreshes every plan's branches and finalizations on a work item's merge, completion or evidence, which name no plan (R-D4 review F5)", () => {
  for (const kind of ['worktree-merged', 'work-item-completed', 'scope-evidence-recorded'])
    expect(
      invalidationsFor(event(kind, { workItemId: 'w', payload: { workItemId: 'w' } })),
      kind,
    ).toEqual(
      expect.arrayContaining([
        ['finalizations', ws],
        ['plan-branches', ws],
      ]),
    );
  // A plan's own merge names it: that plan only.
  const own = invalidationsFor(event('worktree-merged', { payload: { planVersionId: 'p1' } }));
  expect(own).toEqual(expect.arrayContaining([queryKeys.planBranches(ws, 'p1')]));
  expect(own).not.toEqual(expect.arrayContaining([['plan-branches', ws]]));
});

it("re-reads only Git's data on the visible tab's minute: plan branches and maps' environments (R-D4 review F1)", () => {
  expect(GIT_DERIVED_FAMILIES).toEqual([['plan-branches'], ['runtime']]);
});
