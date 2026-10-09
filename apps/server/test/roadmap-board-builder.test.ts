import {
  type RoadmapGraph,
  roadmapBoardSchema,
  roadmapGraphSchema,
} from '@craftingtable/contracts';
import { asWorkItemId, type RoadmapEntry, type RoadmapStatusList } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { slicesHeldBy, slicesWaitingOn } from '../src/services/decision-demand.js';
import {
  buildBoard,
  itemNodeKeys,
  itemSubjectOf,
  mapGraph,
  sequenceGraph,
  sequenceKey,
} from '../src/services/roadmap-board.js';
import { localScopeSource } from './map-test-support.js';

/**
 * R-E3b: the board's pure builder. The static graph is the map's milestones by revision; the
 * board says, per node, what the daemon evaluated: satisfied, its entries and run, its unmet
 * requirements, its root blockers and the slices it unblocks, and the gates ranked by slices.
 */

const workItem = asWorkItemId('wi-local-01');
/** The local map, with an architecture decision slice a starts on and slice b after a merges. */
function source() {
  const base = localScopeSource();
  const [a, b] = base.slices;
  return {
    ...base,
    checkpoints: [
      ...base.checkpoints,
      {
        ...base.checkpoints[0]!,
        id: 'LOCAL-ADR-01',
        kind: 'architecture_decision' as const,
        owner: 'local',
        title: 'Transport contract',
        requires: [],
      },
    ],
    slices: [
      {
        ...a!,
        start_requires: [
          { kind: 'checkpoint' as const, id: 'LOCAL-ADR-01', state: 'passed' as const },
        ],
      },
      {
        ...b!,
        start_requires: [{ kind: 'slice' as const, id: a!.id, state: 'merged' as const }],
      },
    ],
  };
}
const bindings = [
  {
    alias: 'local',
    sourceArtifacts: [],
    workItems: [{ sourceId: 'local/AQ-01', workItemId: workItem, sourceRecordDigest: 'x' }],
  },
];
const roadmapId = '00000000-0000-4000-8000-000000000001';
const entryId = (n: number) => `00000000-0000-4000-8000-00000000001${n}`;

function graph() {
  const s = source();
  return mapGraph({
    roadmapId,
    revision: 3,
    source: s,
    bindings,
    targetId: s.planning_targets[0]!.id,
    selection: 'prioritize-full',
  });
}
const indexOf = (g: ReturnType<typeof graph>, key: string) =>
  g.nodes.findIndex((n) => n.key === key);

it('serves the map as index-encoded milestones with lanes, parents and declared requirements', () => {
  const g = roadmapGraphSchema.parse(graph());
  expect(g).toMatchObject({ roadmapId, revision: 3, model: 'map' });
  expect(g.lanes.map((l) => l.key)).toEqual(['local']);
  const merged = g.nodes[indexOf(g, 'slice:local/AQ-01/a:merged')]!;
  expect(merged).toMatchObject({ kind: 'slice', state: 'merged', lane: 0 });
  expect(merged.workItemId).toBeUndefined();
  expect(g.nodes[merged.parent!]).toMatchObject({
    key: 'work_item:local/AQ-01:accepted',
    workItemId: workItem,
  });
  expect(merged.requires.map((r) => g.nodes[r]!.key)).toContain('slice:local/AQ-01/a:started');
  const adr = g.nodes[indexOf(g, 'checkpoint:LOCAL-ADR-01:passed')]!;
  expect(adr).toMatchObject({ checkpointKind: 'architecture_decision', included: true });
  expect(adr.lane).toBeUndefined();
});

it("builds each node's state, roots and unblocked slices from the daemon's evaluation", () => {
  const g = graph();
  const key = (i: number) => g.nodes[i]!.key;
  // Nothing satisfied but the map's own setup checkpoints; requirements as declared.
  const satisfied = new Set(
    g.nodes
      .filter((n) => n.kind === 'checkpoint' && n.sourceId !== 'LOCAL-ADR-01')
      .map((n) => n.key),
  );
  const state = new Map(
    g.nodes.map((n) => [
      n.key,
      { satisfied: satisfied.has(n.key), requirements: n.requires.map(key) },
    ]),
  );
  const entries = [
    {
      id: entryId(1),
      workItemId: workItem,
      executionScope: { kind: 'slice', sourceId: 'local/AQ-01/a' },
    },
    {
      id: entryId(2),
      workItemId: workItem,
      executionScope: { kind: 'slice', sourceId: 'local/AQ-01/b' },
    },
    {
      id: entryId(3),
      workItemId: workItem,
      executionScope: { kind: 'parent-acceptance', sourceId: 'local/AQ-01' },
    },
  ] as unknown as RoadmapEntry[];
  const row = (id: string, actor: 'operator' | 'agent' | 'controller', runId?: string) => ({
    entryId: id,
    sourceId: 'x',
    scope: 'slice' as const,
    title: 'x',
    workItemId: workItem,
    state: 'running' as const,
    actor,
    waitsOn: { source: 'progress' as const, reason: 'r', ...(runId ? { runId } : {}) },
  });
  const status: RoadmapStatusList = {
    roadmapId,
    name: 'Map',
    status: 'running',
    reason: 'Scheduling.',
    completed: 4,
    entries: [
      row(entryId(1), 'agent', 'run-1'),
      row(entryId(2), 'controller'),
      row(entryId(3), 'operator'),
    ],
  };
  const board = roadmapBoardSchema.parse(
    buildBoard({
      graph: g,
      state: (k) => state.get(k),
      status,
      entries,
      checkpointItems: new Map([['LOCAL-ADR-01', 'item-adr']]),
    }),
  );
  const adr = indexOf(g, 'checkpoint:LOCAL-ADR-01:passed');
  const startA = indexOf(g, 'slice:local/AQ-01/a:started');
  const startB = indexOf(g, 'slice:local/AQ-01/b:started');
  const parent = indexOf(g, 'work_item:local/AQ-01:accepted');

  expect(board.summary).toEqual({ needsYou: 1, agentsAtWork: 1, waiting: 1, done: 4 });
  // Slice a's entry works toward its start and merge; the agent's run is on both.
  expect(board.nodes[startA]).toMatchObject({
    entries: [0],
    runId: 'run-1',
    unmet: [adr],
  });
  expect(board.nodes[indexOf(g, 'slice:local/AQ-01/a:merged')]?.entries).toEqual([0]);
  expect(board.nodes[parent]?.entries).toEqual([2]);
  // The decision is the one root behind the parent, however deep.
  expect(board.nodes[parent]?.roots).toEqual([adr]);
  expect(board.nodes[startB]?.roots).toEqual([adr]);
  expect(board.nodes[adr]).toMatchObject({ attentionItemId: 'item-adr', satisfied: false });
  expect(board.nodes[adr]?.roots).toBeUndefined();
  // It unblocks both slices, each by its first unmet milestone, as slicesWaitingOn counts.
  expect(board.nodes[adr]?.unblocks).toEqual([startA, startB]);
  const demand = g.nodes.map((n) => ({
    key: n.key,
    kind: n.kind,
    sourceId: n.sourceId,
    included: n.included,
    satisfied: satisfied.has(n.key),
    requirements: n.requires.map(key),
  }));
  for (const [i, node] of board.nodes.entries())
    if (!node.satisfied)
      expect(node.unblocks?.length ?? 0, key(i)).toBe(slicesWaitingOn(demand, key(i)));
  expect(board.gates).toEqual([{ node: adr, slices: 2, attentionItemId: 'item-adr' }]);
  // One lane, one open card, which waits directly on the one gate.
  expect(board.lanes).toEqual([{ lane: 0, cards: [{ node: parent, gates: 1 }], done: [] }]);
});

it('reads requirements as evaluated (a decision covering a slice drops its edge) and collapses done cards', () => {
  const g = graph();
  const key = (i: number) => g.nodes[i]!.key;
  const adrKey = 'checkpoint:LOCAL-ADR-01:passed';
  const parentKey = 'work_item:local/AQ-01:accepted';
  // Everything but the decision is satisfied; slice a's start no longer requires the decision.
  const state = (k: string) => {
    const node = g.nodes.find((n) => n.key === k)!;
    return {
      satisfied: k !== adrKey,
      requirements: node.requires.map(key).filter((r) => r !== adrKey),
    };
  };
  const status: RoadmapStatusList = {
    roadmapId,
    name: 'Map',
    status: 'running',
    reason: '',
    completed: 3,
    entries: [],
  };
  const board = buildBoard({ graph: g, state, status, entries: [], checkpointItems: new Map() });
  const adr = indexOf(g, adrKey);
  expect(board.nodes[adr]).toMatchObject({ satisfied: false });
  expect(board.nodes[adr]?.unblocks).toBeUndefined();
  expect(board.gates).toEqual([]);
  expect(board.lanes).toEqual([{ lane: 0, cards: [], done: [indexOf(g, parentKey)] }]);
});

it("draws a sequential roadmap's work items by project, with their required predecessors (R-E3b 7)", () => {
  const items: Record<string, { sourceId: string; title: string; projectId: string }> = {
    a: { sourceId: 'AQ-01', title: 'First', projectId: 'aq' },
    b: { sourceId: 'AQ-02', title: 'Second', projectId: 'aq' },
    x: { sourceId: 'WI-01', title: 'Outside', projectId: 'wi' },
  };
  const predecessors: Record<string, string[]> = { b: ['a', 'x'] };
  const g = roadmapGraphSchema.parse(
    sequenceGraph({
      roadmapId,
      revision: 1,
      entries: [{ workItemId: asWorkItemId('a') }, { workItemId: asWorkItemId('b') }],
      workItem: (id) => items[id],
      predecessors: (id) => (predecessors[id] ?? []).map(asWorkItemId),
      projectName: (id) => ({ aq: 'ActionQueue', wi: 'WorldInterface' })[id],
    }),
  );
  expect(g.model).toBe('sequence');
  expect(g.lanes).toEqual([
    { key: 'aq', label: 'ActionQueue' },
    { key: 'wi', label: 'WorldInterface' },
  ]);
  expect(g.nodes.map((n) => [n.sourceId, n.included, n.requires])).toEqual([
    ['AQ-01', true, []],
    ['AQ-02', true, [0, 2]],
    ['WI-01', false, []],
  ]);
  // The board places each entry on its work item; the outside predecessor is a root, not a card.
  const status: RoadmapStatusList = {
    roadmapId,
    name: 'AQ',
    status: 'running',
    reason: '',
    completed: 1,
    entries: [],
  };
  const board = buildBoard({
    graph: g,
    state: (key) => ({
      satisfied: key === sequenceKey('a'),
      requirements: g.nodes.find((n) => n.key === key)!.requires.map((r) => g.nodes[r]!.key),
    }),
    status,
    entries: [
      { id: entryId(1), workItemId: asWorkItemId('a') },
      {
        id: entryId(2),
        workItemId: asWorkItemId('b'),
        executionScope: { kind: 'slice', sourceId: 'AQ-02/a' } as RoadmapEntry['executionScope'],
      },
    ],
    checkpointItems: new Map(),
  });
  expect(board.nodes.map((n) => n.entries)).toEqual([[0], [1], undefined]);
  expect(board.nodes[1]).toMatchObject({ unmet: [2], roots: [2] });
  expect(board.gates).toEqual([]);
  expect(board.lanes).toEqual([
    { lane: 0, cards: [{ node: 1, gates: 0 }], done: [0] },
    { lane: 1, cards: [], done: [] },
  ]);
});

it('names the nodes an inbox item is about and counts the slices it holds (R-E3b 8)', () => {
  const g = graph();
  const entries = [
    {
      id: entryId(1),
      workItemId: workItem,
      executionScope: { kind: 'slice', sourceId: 'local/AQ-01/a' },
    },
    {
      id: entryId(2),
      workItemId: workItem,
      executionScope: { kind: 'slice-verification', sourceId: 'local/AQ-01/b' },
    },
  ] as unknown as RoadmapEntry[];
  expect(itemNodeKeys(g, entries, { entryIds: [entryId(1)] })).toEqual([
    'slice:local/AQ-01/a:started',
    'slice:local/AQ-01/a:merged',
  ]);
  expect(itemNodeKeys(g, entries, { entryIds: [entryId(2)] })).toEqual([
    'slice:local/AQ-01/b:verified',
  ]);
  expect(itemNodeKeys(g, entries, { checkpointId: 'LOCAL-ADR-01' })).toEqual([
    'checkpoint:LOCAL-ADR-01:passed',
  ]);
  expect([...itemNodeKeys(g, entries, { workItemId: workItem })].sort()).toEqual(
    [
      'work_item:local/AQ-01:accepted',
      ...['a', 'b'].flatMap((s) =>
        ['started', 'merged', 'verified'].map((m) => `slice:local/AQ-01/${s}:${m}`),
      ),
    ].sort(),
  );
  expect(itemNodeKeys(g, entries, { roadmap: true })).toHaveLength(6);

  // Nothing met: the decision holds both slices, as slicesWaitingOn counts; slice b's own
  // verification holds b alone; slice a's start holds a and b, which starts after a merges.
  const nodes = g.nodes.map((n) => ({
    key: n.key,
    kind: n.kind,
    sourceId: n.sourceId,
    included: n.included,
    satisfied: n.kind === 'checkpoint' && n.sourceId !== 'LOCAL-ADR-01',
    requirements: n.requires.map((r) => g.nodes[r]!.key),
  }));
  const adr = 'checkpoint:LOCAL-ADR-01:passed';
  expect(slicesHeldBy(nodes, [adr])).toBe(slicesWaitingOn(nodes, adr));
  expect(slicesHeldBy(nodes, [adr])).toBe(2);
  expect(slicesHeldBy(nodes, ['slice:local/AQ-01/b:verified'])).toBe(1);
  expect(slicesHeldBy(nodes, ['slice:local/AQ-01/a:started'])).toBe(2);
  // A met slice holds nothing of its own.
  expect(
    slicesHeldBy(
      nodes.map((n) => (n.sourceId === 'local/AQ-01/b' ? { ...n, satisfied: true } : n)),
      ['slice:local/AQ-01/b:verified'],
    ),
  ).toBe(0);
});

it('counts only unfinished, selected slices, ranks gates, and attributes runs and cards by the daemon (R-E3b review M3)', () => {
  const node = (
    sourceId: string,
    kind: 'checkpoint' | 'work_item' | 'slice',
    extra: Partial<RoadmapGraph['nodes'][number]> = {},
  ) => {
    const state =
      extra.state ?? (kind === 'checkpoint' ? 'passed' : kind === 'slice' ? 'started' : 'accepted');
    return {
      key: `${kind}:${sourceId}:${state}`,
      kind,
      sourceId,
      state,
      title: sourceId,
      requires: [] as number[],
      included: true,
      ...extra,
    };
  };
  const g: RoadmapGraph = {
    roadmapId,
    revision: 1,
    model: 'map',
    lanes: [{ key: 'l', label: 'L' }],
    nodes: [
      node('G1', 'checkpoint'), // 0
      node('G2', 'checkpoint'), // 1
      node('GX', 'checkpoint', { included: false }), // 2: not selected
      node('W1', 'work_item', { lane: 0 }), // 3
      node('s1', 'slice', { lane: 0, parent: 3, requires: [0] }), // 4
      node('s1', 'slice', { lane: 0, parent: 3, requires: [4], state: 'merged' }), // 5
      node('s2', 'slice', { lane: 0, parent: 3, requires: [1, 0] }), // 6: G1 covered by a decision
      node('s3', 'slice', { lane: 0, parent: 3, requires: [1], included: false }), // 7: not selected
      node('s4', 'slice', { lane: 0, parent: 3, requires: [1] }), // 8: finished
      node('W2', 'work_item', { lane: 0 }), // 9
      node('s5', 'slice', { lane: 0, parent: 9, requires: [2] }), // 10
      node('s6', 'slice', { lane: 0, parent: 9, requires: [0] }), // 11
    ],
  };
  const met = new Set([8]);
  const state = (key: string) => {
    const i = g.nodes.findIndex((n) => n.key === key);
    // As evaluated: s2's requirement on G1 is covered, so it needs G2 alone.
    const requires = i === 6 ? [1] : g.nodes[i]!.requires;
    return { satisfied: met.has(i), requirements: requires.map((r) => g.nodes[r]!.key) };
  };
  const scope = (sourceId: string) =>
    ({ kind: 'slice', sourceId }) as unknown as RoadmapEntry['executionScope'];
  const entries = [
    { id: entryId(1), workItem: 'w2', executionScope: scope('s6') },
    { id: entryId(2), workItem: 'w1', executionScope: scope('s1') },
    { id: entryId(3), workItem: 'w2', executionScope: scope('s5') },
  ].map((e) => ({ ...e, workItemId: asWorkItemId(e.workItem) }));
  const row = (id: string, actor: 'controller' | 'agent', runId: string) => ({
    entryId: id,
    sourceId: id,
    scope: 'slice' as const,
    title: id,
    workItemId: workItem,
    state: 'running' as const,
    actor,
    waitsOn: { source: 'progress' as const, reason: 'r', runId },
  });
  const board = buildBoard({
    graph: g,
    state,
    status: {
      roadmapId,
      name: 'x',
      status: 'running',
      reason: '',
      completed: 0,
      // s1's run has stopped (the controller acts); s6's agent is at work.
      entries: [row(entryId(2), 'controller', 'old-run'), row(entryId(1), 'agent', 'live-run')],
    },
    entries,
    checkpointItems: new Map(),
  });
  // Requirements as evaluated: s2 waits on G2 only.
  expect(board.nodes[6]).toMatchObject({ unmet: [1], roots: [1] });
  // G2 unblocks s2 alone: s3 is not selected and s4 is finished. G1 unblocks s1 and s6.
  expect(board.nodes[1]?.unblocks).toEqual([6]);
  expect(board.nodes[0]?.unblocks).toEqual([4, 11]);
  // GX holds s5 but is not selected: no gate. The rest rank most slices first.
  expect(board.gates.map((x) => [g.nodes[x.node]!.sourceId, x.slices])).toEqual([
    ['G1', 2],
    ['G2', 1],
  ]);
  // A run is named only while an agent is at work on the node.
  expect(board.nodes[4]?.runId).toBeUndefined();
  expect(board.nodes[11]?.runId).toBe('live-run');
  // W1 has a met slice and unmet ones: open. Cards stand by their first entry: W2's comes first.
  expect(board.lanes[0]).toMatchObject({ cards: [{ node: 9 }, { node: 3 }], done: [] });
});

it("finds an item's subject from its typed references alone (R-E3b review M4)", () => {
  const subject = (
    refs: { roadmapId?: string; entryId?: string; cycleId?: string; workItemId?: string },
    extra: {
      members?: string[];
      checkpointId?: string;
      owner?: { roadmapId: string; entryId: string };
      cycle?: boolean;
    } = {},
  ) =>
    itemSubjectOf({
      item: { refs, ...(extra.members ? { members: extra.members } : {}) },
      roadmapId: 'r',
      checkpointId: extra.checkpointId,
      cycle:
        extra.cycle || extra.owner ? { ...(extra.owner ? { owner: extra.owner } : {}) } : undefined,
      bindsWorkItem: (id) => id === 'bound',
    });
  expect(subject({ roadmapId: 'r' }, { checkpointId: 'ADR-1' })).toEqual({ checkpointId: 'ADR-1' });
  expect(subject({ roadmapId: 'r', entryId: 'e1' })).toEqual({ entryIds: ['e1'] });
  // A cycle's stop is its owning entry's, though the item names no roadmap.
  expect(
    subject({ cycleId: 'c', workItemId: 'bound' }, { owner: { roadmapId: 'r', entryId: 'e2' } }),
  ).toEqual({ entryIds: ['e2'] });
  expect(subject({ roadmapId: 'r' }, { members: ['e3', 'e4'] })).toEqual({
    entryIds: ['e3', 'e4'],
  });
  expect(subject({ roadmapId: 'r' })).toEqual({ roadmap: true });
  expect(subject({ workItemId: 'bound' })).toEqual({ workItemId: 'bound' });
  // Not on this roadmap: another roadmap's, another roadmap's cycle, a work item the map does not
  // bind, or a work item whose cycle nobody here owns.
  expect(subject({ roadmapId: 'other', entryId: 'e1' })).toBeUndefined();
  expect(
    subject({ cycleId: 'c' }, { owner: { roadmapId: 'other', entryId: 'e2' } }),
  ).toBeUndefined();
  expect(subject({ workItemId: 'unbound' })).toBeUndefined();
  expect(subject({ cycleId: 'c', workItemId: 'bound' }, { cycle: true })).toBeUndefined();
});

it('holds only selected slices, for an item and for the whole roadmap (R-E3b review M4)', () => {
  // Target-only: slice b's milestones are not selected.
  const s = source();
  const g = mapGraph({
    roadmapId,
    revision: 1,
    source: s,
    bindings,
    targetId: s.planning_targets[0]!.id,
    selection: 'target-only',
  });
  const unselected = g.nodes.filter((n) => !n.included && n.kind === 'slice');
  expect(unselected.length).toBeGreaterThan(0);
  const keys = itemNodeKeys(g, [], { roadmap: true });
  expect(keys.every((k) => g.nodes.find((n) => n.key === k)!.included)).toBe(true);
  const nodes = g.nodes.map((n) => ({
    key: n.key,
    kind: n.kind,
    sourceId: n.sourceId,
    included: n.included,
    satisfied: false,
    requirements: n.requires.map((r) => g.nodes[r]!.key),
  }));
  const selectedSlices = new Set(
    g.nodes.filter((n) => n.kind === 'slice' && n.included).map((n) => n.sourceId),
  );
  expect(slicesHeldBy(nodes, keys)).toBe(selectedSlices.size);
  expect(
    slicesHeldBy(
      nodes,
      unselected.map((n) => n.key),
    ),
  ).toBe(0);
});

it('serves any title and id the map format allows (R-E3b review L1)', () => {
  const s = source();
  const long = 'T'.repeat(16000);
  const g = mapGraph({
    roadmapId,
    revision: 1,
    source: { ...s, work_items: s.work_items.map((w) => ({ ...w, title: long })) },
    bindings,
    targetId: s.planning_targets[0]!.id,
    selection: 'prioritize-full',
  });
  expect(roadmapGraphSchema.parse(g).nodes.some((n) => n.title === long)).toBe(true);
});
