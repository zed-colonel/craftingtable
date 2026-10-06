import {
  type WorkspaceEventEnvelope,
  workspaceEventEnvelopeSchema,
} from '@craftingtable/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GIT_DERIVED_FAMILIES,
  invalidationsFor,
  queryKeys,
  workspaceScoped,
} from './event-invalidations.js';
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

it("re-reads only Git's data on the visible tab's minute: plan and worktree branches, repository policy and maps' environments (R-D4 review F1, 4b)", () => {
  expect(GIT_DERIVED_FAMILIES).toEqual([
    ['plan-branches'],
    ['runtime'],
    ['worktree-branch'],
    ['repository-policy'],
  ]);
});

// R-D4 increment 4b: the panels that re-read on every page round have keys of their own.
it("narrows a work item's reads to the work item an event names, and reads them all when it names none", () => {
  const own = invalidationsFor(event('work-cycle-changed', { workItemId: 'w1', payload: {} }));
  expect(own).toEqual(expect.arrayContaining([queryKeys.workItem(ws, 'w1')]));
  expect(own).not.toEqual(expect.arrayContaining([['work-item', ws]]));
  for (const kind of [
    'worktree-created',
    'worktree-removed',
    'branches-changed',
    'agent-run-started',
    'agent-run-status-changed',
  ])
    expect(invalidationsFor(event(kind, { workItemId: 'w1', payload: {} })), kind).toEqual(
      expect.arrayContaining([queryKeys.workItem(ws, 'w1')]),
    );
  // A map's or roadmap's change moves every item's phase readiness.
  for (const kind of ['roadmap-changed', 'runtime-evidence-changed', 'scope-scheduling-authorized'])
    expect(
      invalidationsFor(event(kind, { payload: { roadmapId: 'r', definitionId: 'd' } })),
      kind,
    ).toEqual(expect.arrayContaining([['work-item', ws]]));
  expect(invalidationsFor(event('work-cycle-changed', { payload: {} }))).toEqual(
    expect.arrayContaining([['work-item', ws]]),
  );
  for (const kind of ['notifications-changed', 'workspace-updated', 'attention-changed'])
    expect(
      invalidationsFor(event(kind, { repositoryId: 'repo', payload: {} })).some(
        (key) => key[0] === 'work-item',
      ),
      kind,
    ).toBe(false);
});

it("reads a work item's view again when a repository changes, since the view lists them (R-D5)", () => {
  const view = queryKeys.workItemView(ws, 'w1');
  const under = (prefix: readonly string[]) => prefix.every((part, index) => view[index] === part);
  for (const kind of [
    'repository-registered',
    'repository-status-changed',
    'repository-evidence-changed',
    'source-repository-registered',
    'project-repository-bound',
    'project-repository-binding-retired',
  ])
    expect(
      invalidationsFor(event(kind, { repositoryId: 'repo', projectId: 'p', payload: {} })).some(
        (key) => under(key),
      ),
      kind,
    ).toBe(true);
});

it('re-reads branches, repositories, checks and policy on the events that change them, and on nothing else', () => {
  const touches = (kind: string, family: string) =>
    invalidationsFor(event(kind, { repositoryId: 'repo', workItemId: 'w1', payload: {} })).some(
      (key) => key[0] === family,
    );
  const rows: Record<string, readonly string[]> = {
    'worktree-branch': [
      'worktree-created',
      'worktree-removed',
      'worktree-merged',
      'branches-changed',
      'work-cycle-changed',
      'agent-run-status-changed',
    ],
    repositories: [
      'repository-registered',
      'repository-status-changed',
      'repository-evidence-changed',
      'source-repository-registered',
      'project-repository-bound',
      'project-repository-binding-retired',
    ],
    'repository-checks': [
      'repository-registered',
      'repository-status-changed',
      'repository-evidence-changed',
      'work-cycle-changed',
      'agent-run-status-changed',
      'worktree-merged',
    ],
    'repository-policy': [
      'repository-status-changed',
      'repository-evidence-changed',
      'branches-changed',
      'worktree-merged',
    ],
  };
  for (const [family, kinds] of Object.entries(rows))
    for (const kind of KINDS)
      expect(touches(kind, family), `${kind} -> ${family}`).toBe(kinds.includes(kind));
});

// R-D4 increment 4b-3: the pages' own reads. Each family is checked against every event kind.
it("re-reads each page's data on the events that change it, and on nothing else", () => {
  const touches = (kind: string, family: string) =>
    invalidationsFor(
      event(kind, {
        repositoryId: 'repo',
        workItemId: 'w1',
        projectId: 'p1',
        runId: 'run-1',
        payload: { roadmapId: 'r', definitionId: 'd', planVersionId: 'v' },
      }),
    ).some((key) => key[0] === family);
  const summary = [
    'project-created',
    'plan-version-imported',
    'work-item-admitted',
    'work-item-removed-from-agenda',
    'work-item-completed',
    'scope-scheduling-authorized',
    'scope-evidence-recorded',
    'worktree-created',
    'worktree-removed',
    'work-cycle-changed',
    'worktree-merged',
    'branches-changed',
    'agent-run-started',
    'agent-run-status-changed',
  ];
  const audited = KINDS.filter((kind) => kind !== 'notifications-changed');
  const rows: Record<string, readonly string[]> = {
    // The rail's run and work-item counts and Home's counts come with the list (4b review F1).
    workspaces: [
      ...summary,
      'workspace-created',
      'workspace-updated',
      'runtime-evidence-changed',
      'roadmap-changed',
      'attention-changed',
    ],
    snapshot: [
      ...summary,
      'workspace-created',
      'workspace-updated',
      'runtime-evidence-changed',
      'roadmap-changed',
      'attention-changed',
    ],
    agenda: summary,
    project: [...summary, 'project-repository-bound', 'project-repository-binding-retired'],
    cycles: [
      ...summary.filter((kind) => !['project-created', 'plan-version-imported'].includes(kind)),
      'runtime-evidence-changed',
      'roadmap-changed',
    ],
    attention: ['attention-changed', 'work-item-completed', 'roadmap-changed'],
    audit: audited,
    runs: ['agent-run-started', 'agent-run-status-changed'],
    run: [
      'agent-run-started',
      'agent-run-status-changed',
      'worktree-created',
      'worktree-removed',
      'worktree-merged',
      'branches-changed',
    ],
  };
  for (const [family, kinds] of Object.entries(rows))
    for (const kind of KINDS)
      expect(touches(kind, family), `${kind} -> ${family}`).toBe(kinds.includes(kind));
  // Nothing marks the per-session or static reads stale: commands and visits read them.
  for (const family of ['execution-status', 'run-profiles', 'sessions'])
    for (const kind of KINDS) expect(touches(kind, family), `${kind} -> ${family}`).toBe(false);
});

it("narrows a project's reads to the one an event names; a run's event reads every run page", () => {
  const own = invalidationsFor(
    event('agent-run-status-changed', { projectId: 'p1', runId: 'run-1', payload: {} }),
  );
  expect(own).toEqual(expect.arrayContaining([queryKeys.project(ws, 'p1')]));
  expect(own).not.toEqual(expect.arrayContaining([['project', ws]]));
  // A run page's view lists its item's runs, so another run's start or change reads it (R-D5).
  for (const kind of ['agent-run-started', 'agent-run-status-changed'])
    expect(invalidationsFor(event(kind, { runId: 'run-2', payload: {} })), kind).toEqual(
      expect.arrayContaining([['run', ws]]),
    );
  expect(queryKeys.runView(ws, 'run-1').slice(0, 2)).toEqual(['run', ws]);
  // A plan version sits beneath its project.
  expect(queryKeys.planVersion(ws, 'p1', 'v1').slice(0, 3)).toEqual(queryKeys.project(ws, 'p1'));
  // Without identifiers, every project's and run's reads.
  expect(invalidationsFor(event('worktree-merged', { payload: {} }))).toEqual(
    expect.arrayContaining([
      ['project', ws],
      ['run', ws],
    ]),
  );
});

it('keeps reads that belong to no workspace when the workspace changes', () => {
  expect(workspaceScoped(queryKeys.workspaces())).toBe(false);
  expect(workspaceScoped(queryKeys.executionStatus())).toBe(false);
  expect(workspaceScoped(queryKeys.sessions())).toBe(false);
  expect(workspaceScoped(queryKeys.snapshot(ws))).toBe(true);
  expect(workspaceScoped(queryKeys.workItem(ws, 'w1'))).toBe(true);
});

// R-D4 4b review F2: a work item's readiness, slices and waits depend on its predecessors',
// repositories' and plan's state, which events about those name, not the dependent item.
it("reads every work item's data when a predecessor, repository or plan changes", () => {
  for (const kind of [
    'work-item-admitted',
    'work-item-removed-from-agenda',
    'work-item-completed',
    'scope-evidence-recorded',
    'worktree-merged',
    'repository-status-changed',
    'plan-version-imported',
  ])
    expect(
      invalidationsFor(event(kind, { workItemId: 'w1', repositoryId: 'repo', payload: {} })),
      kind,
    ).toEqual(expect.arrayContaining([['work-item', ws]]));
  // A run's or a cycle's own events still name only their item.
  for (const kind of ['agent-run-status-changed', 'work-cycle-changed'])
    expect(invalidationsFor(event(kind, { workItemId: 'w1', payload: {} })), kind).not.toEqual(
      expect.arrayContaining([['work-item', ws]]),
    );
});

// B1-UI-003/B1-UI-013 and A2B-JRN-007, carried from the projection's former stale scopes: a
// binding event names its project structurally, and a payload that disagrees is never read.
it("reads the project a binding event names structurally, never the payload's", () => {
  const keys = invalidationsFor(
    event('project-repository-bound', {
      projectId: 'structural-project',
      repositoryId: 'structural-repository',
      payload: { projectId: 'payload-project', repositoryId: 'payload-repository' },
    }),
  );
  expect(keys).toEqual(expect.arrayContaining([queryKeys.project(ws, 'structural-project')]));
  expect(keys.some((key) => key.includes('payload-project'))).toBe(false);
});

it('reads a roadmap page again whenever its roadmap or its status list would be (R-D5)', () => {
  const page = queryKeys.roadmapPage(ws, 'r1');
  const reads = (kind: string, fields: Record<string, unknown> = {}) =>
    invalidationsFor(event(kind, fields)).some((key) =>
      key.every((part, index) => page[index] === part),
    );
  // A run's change moves the status list; a roadmap's change, the roadmap itself.
  expect(reads('agent-run-status-changed', { runId: 'run-1', payload: {} })).toBe(true);
  expect(reads('roadmap-changed', { payload: { roadmapId: 'r1' } })).toBe(true);
  expect(reads('work-cycle-changed', { workItemId: 'w1', payload: {} })).toBe(true);
  for (const kind of ['notifications-changed', 'repository-registered', 'workspace-updated'])
    expect(reads(kind, { repositoryId: 'repo', payload: {} }), kind).toBe(false);
  // Every kind: read exactly when the roadmaps or a status list are.
  for (const kind of KINDS) {
    const keys = invalidationsFor(
      event(kind, { payload: { roadmapId: 'r1', definitionId: 'd' }, runId: 'run-1' }),
    );
    expect(
      keys.some((key) => key[0] === 'roadmap-page'),
      kind,
    ).toBe(keys.some((key) => key[0] === 'roadmaps' || key[0] === 'roadmap-status'));
  }
  // A definition's revision never changes: no event reads one again.
  for (const kind of KINDS)
    expect(
      invalidationsFor(event(kind, { payload: { roadmapId: 'r1', definitionId: 'd' } })).some(
        (key) => key[0] === 'roadmap-definition',
      ),
      kind,
    ).toBe(false);
});
