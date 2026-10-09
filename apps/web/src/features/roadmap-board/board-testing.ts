import type {
  RoadmapBoard,
  RoadmapGraph,
  RoadmapStatusListResponse,
} from '@craftingtable/contracts';
import type { BoardModel } from './board-model.js';

/**
 * A small map roadmap's board for tests (R-E3b): WI-01's slice waits on the architecture
 * decision ADR-1, which Needs you holds; EXO-01 is done.
 *
 *   0 checkpoint ADR-1 (architecture decision, unmet)   4 WI-01/impl verified
 *   1 WI-01 accepted (requires 4)                        5 EXO-01 accepted (met)
 *   2 WI-01/impl started (requires 0)                    6 PLAN plan approval (met)
 *   3 WI-01/impl merged (requires 2)
 */
export const ROADMAP_ID = '00000000-0000-4000-8000-0000000000aa';
export const ENTRY_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const;

export const GRAPH: RoadmapGraph = {
  roadmapId: ROADMAP_ID,
  revision: 2,
  model: 'map',
  lanes: [
    { key: 'wi', label: 'zed/worldinterface' },
    { key: 'exo', label: 'zed/exoskeleton' },
  ],
  nodes: [
    {
      key: 'checkpoint:ADR-1:passed',
      kind: 'checkpoint',
      sourceId: 'ADR-1',
      state: 'passed',
      title: 'Transport contract',
      requires: [],
      included: true,
      checkpointKind: 'architecture_decision',
    },
    {
      key: 'work_item:wi/WI-01:accepted',
      kind: 'work_item',
      sourceId: 'wi/WI-01',
      state: 'accepted',
      title: 'World interface core',
      lane: 0,
      requires: [4],
      included: true,
      workItemId: 'wi-01' as RoadmapGraph['nodes'][number]['workItemId'],
    },
    ...(['started', 'merged', 'verified'] as const).map((state, i) => ({
      key: `slice:wi/WI-01/impl:${state}`,
      kind: 'slice' as const,
      sourceId: 'wi/WI-01/impl',
      state,
      title: 'Implementation',
      lane: 0,
      parent: 1,
      requires: i === 0 ? [0] : [1 + i],
      included: true,
    })),
    {
      key: 'work_item:exo/EXO-01:accepted',
      kind: 'work_item',
      sourceId: 'exo/EXO-01',
      state: 'accepted',
      title: 'Exoskeleton domain',
      lane: 1,
      requires: [],
      included: true,
      workItemId: 'exo-01' as RoadmapGraph['nodes'][number]['workItemId'],
    },
    {
      key: 'checkpoint:PLAN:passed',
      kind: 'checkpoint',
      sourceId: 'PLAN',
      state: 'passed',
      title: 'Plan accepted',
      requires: [],
      included: true,
      checkpointKind: 'plan_approval',
    },
  ],
};

export const BOARD: RoadmapBoard = {
  revision: 2,
  summary: { needsYou: 1, agentsAtWork: 0, waiting: 2, done: 3 },
  nodes: [
    { satisfied: false, attentionItemId: 'item-adr', unblocks: [2] },
    { satisfied: false, entries: [2], unmet: [4], roots: [0] },
    { satisfied: false, entries: [0], unmet: [0], roots: [0] },
    { satisfied: false, entries: [0], unmet: [2], roots: [0] },
    { satisfied: false, entries: [1], unmet: [3], roots: [0] },
    { satisfied: true },
    { satisfied: true },
  ],
  gates: [{ node: 0, slices: 1, attentionItemId: 'item-adr' }],
  lanes: [
    { lane: 0, cards: [{ node: 1, gates: 1 }], done: [] },
    { lane: 1, cards: [], done: [5] },
  ],
};

const row = (
  entry: number,
  scope: 'slice' | 'slice-verification' | 'parent-acceptance',
  actor: 'operator' | 'controller',
  reason: string,
  attentionItemId?: string,
) => ({
  entryId: ENTRY_IDS[entry]!,
  sourceId: scope === 'parent-acceptance' ? 'wi/WI-01' : 'wi/WI-01/impl',
  scope,
  title: 'World interface core',
  workItemId: 'wi-01',
  state: 'dependency-blocked' as const,
  actor,
  waitsOn: {
    source: attentionItemId ? ('attention-item' as const) : ('progress' as const),
    reason,
    ...(attentionItemId ? { attentionItemId } : {}),
  },
});

export const STATUS: RoadmapStatusListResponse = {
  roadmapId: ROADMAP_ID,
  name: 'Cross-project roadmap',
  status: 'running',
  reason: 'Scheduling.',
  completed: 3,
  entries: [
    row(
      0,
      'slice',
      'operator',
      'ADR-1 has a prepared brief awaiting your approval; wi/WI-01/impl starts once it is approved.',
      'item-slice',
    ),
    row(1, 'slice-verification', 'controller', 'verify · dependency: wi/WI-01/impl merged.'),
    row(2, 'parent-acceptance', 'controller', 'accept · dependency: wi/WI-01/impl verified.'),
  ] as RoadmapStatusListResponse['entries'],
};

export const MODEL: BoardModel = {
  graph: GRAPH,
  board: BOARD,
  status: STATUS,
  entryIds: ENTRY_IDS,
};
