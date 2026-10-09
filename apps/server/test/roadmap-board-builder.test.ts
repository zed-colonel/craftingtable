import { roadmapBoardSchema, roadmapGraphSchema } from '@craftingtable/contracts';
import { asWorkItemId, type RoadmapEntry, type RoadmapStatusList } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { slicesWaitingOn } from '../src/services/decision-demand.js';
import { buildBoard, mapGraph } from '../src/services/roadmap-board.js';
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
