import type {
  RoadmapBoard,
  RoadmapGraph,
  RoadmapGraphNode,
  RoadmapStatusListResponse,
} from '@craftingtable/contracts';

/**
 * The board as the browser draws it (R-E3b): the daemon's graph, board and status list joined by
 * node. Nothing is decided here. States, actors, waits, counts, roots and unblocked slices are the
 * daemon's; this only looks them up by index and groups a card's slices for drawing.
 */

export type StatusRow = RoadmapStatusListResponse['entries'][number];

export interface BoardModel {
  readonly graph: RoadmapGraph;
  readonly board: RoadmapBoard;
  readonly status: RoadmapStatusListResponse;
  /** The roadmap entries' ids at the board's revision, by position. */
  readonly entryIds: readonly string[];
}

export interface SliceGroup {
  readonly sourceId: string;
  readonly title: string;
  /** The slice's selected milestones, in the order the map lists them. */
  readonly milestones: readonly number[];
}

export interface Card {
  readonly node: number;
  readonly gates: number;
  /** Its selected milestones: its own acceptance, when selected, then its slices'. */
  readonly nodes: readonly number[];
  readonly slices: readonly SliceGroup[];
  /** The card's first open entry in roadmap order, whose state and wait the card shows. */
  readonly headline: StatusRow | undefined;
  /** A run at work on one of its milestones. */
  readonly runId: string | undefined;
}

export function nodeAt(model: BoardModel, index: number): RoadmapGraphNode {
  return model.graph.nodes[index]!;
}

export function indexOfKey(model: BoardModel, key: string | undefined): number | undefined {
  if (key === undefined) return undefined;
  const index = model.graph.nodes.findIndex((n) => n.key === key);
  return index < 0 ? undefined : index;
}

/**
 * The status list's open rows for a node's entries, in roadmap order. A work item's are its
 * card's: its own and its selected slices', as the card shows them.
 */
export function rowsOf(model: BoardModel, index: number): StatusRow[] {
  const rows = new Map<string, StatusRow>(model.status.entries.map((row) => [row.entryId, row]));
  const nodes = [
    index,
    ...(nodeAt(model, index).kind === 'work_item'
      ? model.graph.nodes.flatMap((n, i) => (n.parent === index && n.included ? [i] : []))
      : []),
  ];
  const positions = [...new Set(nodes.flatMap((i) => model.board.nodes[i]?.entries ?? []))];
  return positions
    .sort((a, b) => a - b)
    .flatMap((position) => {
      const row = rows.get(model.entryIds[position] ?? '');
      return row ? [row] : [];
    });
}

/** A card's selected milestones and its slices', grouped by slice for drawing. */
export function cardOf(model: BoardModel, card: { node: number; gates: number }): Card {
  const { nodes } = model.graph;
  const own = nodes[card.node]!.included ? [card.node] : [];
  const children = nodes.flatMap((n, i) => (n.parent === card.node && n.included ? [i] : []));
  const slices = new Map<string, number[]>();
  for (const i of children) {
    const sourceId = nodes[i]!.sourceId;
    slices.set(sourceId, [...(slices.get(sourceId) ?? []), i]);
  }
  const all = [...own, ...children];
  const positions = [...new Set(all.flatMap((i) => model.board.nodes[i]?.entries ?? []))].sort(
    (a, b) => a - b,
  );
  const rows = new Map<string, StatusRow>(model.status.entries.map((row) => [row.entryId, row]));
  const headline = positions
    .map((p) => rows.get(model.entryIds[p] ?? ''))
    .find((row) => row !== undefined);
  return {
    node: card.node,
    gates: card.gates,
    nodes: all,
    slices: [...slices].map(([sourceId, milestones]) => ({
      sourceId,
      title: nodes[milestones[0]!]!.title,
      milestones,
    })),
    headline,
    runId: all.map((i) => model.board.nodes[i]?.runId).find((id) => id !== undefined),
  };
}

/** The work item a node belongs to: its own, or its parent's. */
export function workItemOf(model: BoardModel, index: number): string | undefined {
  const node = nodeAt(model, index);
  return (
    node.workItemId ??
    (node.parent === undefined ? undefined : nodeAt(model, node.parent).workItemId)
  );
}

const KIND_LABELS: Record<RoadmapGraphNode['kind'], string> = {
  work_item: 'Work item',
  slice: 'Slice',
  checkpoint: 'Checkpoint',
};
const STATE_LABELS: Record<RoadmapGraphNode['state'], string> = {
  accepted: 'accepted',
  started: 'started',
  merged: 'merged',
  verified: 'verified',
  passed: 'passed',
  completed: 'completed',
};

/** "Slice · merged", "Checkpoint · architecture decision". */
export function nodeLabel(node: RoadmapGraphNode): string {
  return node.kind === 'checkpoint' && node.checkpointKind
    ? `${KIND_LABELS.checkpoint} · ${node.checkpointKind.replaceAll('_', ' ')}`
    : `${KIND_LABELS[node.kind]} · ${STATE_LABELS[node.state]}`;
}

const MILESTONES: readonly string[] = ['started', 'merged', 'verified'];

/**
 * The node a status-list row opens on: of the nodes its entry works toward, the first not yet
 * met (a slice's start before its merge), else its last.
 */
export function nodeOfEntry(model: BoardModel, entryId: string): number | undefined {
  const position = model.entryIds.indexOf(entryId);
  const nodes = model.board.nodes.flatMap((n, i) => (n.entries?.includes(position) ? [i] : []));
  const order = (i: number) => MILESTONES.indexOf(nodeAt(model, i).state);
  const sorted = [...nodes].sort((a, b) => order(a) - order(b));
  return sorted.find((i) => !model.board.nodes[i]!.satisfied) ?? sorted.at(-1);
}
