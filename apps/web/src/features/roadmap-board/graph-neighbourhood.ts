import { type BoardModel, nodeAt } from './board-model.js';

/**
 * The neighbourhood graph's structure (R-E3b, ADR-072), traversed for drawing only: the map's
 * selected milestones folded to work-item level, the selection's neighbourhood within some hops,
 * and its transitive reduction. States and counts stay the daemon's.
 */

/** A drawn node: a work item with its slices, or a checkpoint. */
export interface GraphGroup {
  /** The graph node that stands for the group: the work item's own, or the checkpoint. */
  readonly node: number;
  /** Every selected graph node in the group. */
  readonly members: readonly number[];
}

export interface Neighbourhood {
  readonly groups: readonly GraphGroup[];
  /** Requirement edges between groups, from the required group to the one that requires it. */
  readonly edges: readonly (readonly [number, number])[];
  /** The selection's group. */
  readonly centre: number;
  /** How many groups the hops reach in all; more than `groups.length` when the cap cut them. */
  readonly reached: number;
}

/** The groups of a graph: each selected node to the node that stands for its group. */
export function groupsOf(model: BoardModel): ReadonlyMap<number, number> {
  const owner = new Map<number, number>();
  model.graph.nodes.forEach((node, i) => {
    if (!node.included) return;
    owner.set(i, node.kind === 'slice' && node.parent !== undefined ? node.parent : i);
  });
  return owner;
}

/** Requirement edges between groups, without a group's own internal edges. */
export function groupEdges(
  model: BoardModel,
  owner: ReadonlyMap<number, number>,
): readonly (readonly [number, number])[] {
  const edges = new Map<string, readonly [number, number]>();
  model.graph.nodes.forEach((node, i) => {
    const to = owner.get(i);
    if (to === undefined) return;
    for (const r of node.requires) {
      const from = owner.get(r);
      if (from === undefined || from === to) continue;
      edges.set(`${from}>${to}`, [from, to]);
    }
  });
  return [...edges.values()];
}

/**
 * The groups within `hops` of the selection's group, up and downstream, nearest first, at most
 * `cap` of them, with the edges between them.
 */
export function neighbourhood(
  model: BoardModel,
  selected: number,
  hops: number,
  cap: number,
): Neighbourhood | undefined {
  const owner = groupsOf(model);
  const centre = owner.get(selected) ?? (nodeAt(model, selected).included ? selected : undefined);
  if (centre === undefined) return undefined;
  const edges = groupEdges(model, owner);
  const up = new Map<number, number[]>();
  const down = new Map<number, number[]>();
  for (const [from, to] of edges) {
    up.set(to, [...(up.get(to) ?? []), from]);
    down.set(from, [...(down.get(from) ?? []), to]);
  }
  // Breadth first in each direction separately: a node two hops up and one down is not "near".
  const distance = new Map<number, number>([[centre, 0]]);
  for (const next of [up, down]) {
    let frontier = [centre];
    for (let hop = 1; hop <= hops && frontier.length; hop++) {
      const reached: number[] = [];
      for (const group of frontier)
        for (const n of next.get(group) ?? [])
          if (!distance.has(n) || distance.get(n)! > hop) {
            if (!distance.has(n)) reached.push(n);
            distance.set(n, Math.min(distance.get(n) ?? hop, hop));
          }
      frontier = reached;
    }
  }
  const ordered = [...distance].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([g]) => g);
  const kept = new Set(ordered.slice(0, cap));
  const members = new Map<number, number[]>();
  for (const [node, group] of owner)
    if (kept.has(group)) members.set(group, [...(members.get(group) ?? []), node]);
  return {
    groups: [...kept].map((node) => ({ node, members: members.get(node) ?? [node] })),
    edges: transitiveReduction(
      [...kept],
      edges.filter(([from, to]) => kept.has(from) && kept.has(to)),
    ),
    centre,
    reached: ordered.length,
  };
}

/**
 * The edges of a directed acyclic graph that no longer path implies: an edge from a to b goes
 * when b is reachable from a through another node.
 */
export function transitiveReduction<T>(
  nodes: readonly T[],
  edges: readonly (readonly [T, T])[],
): (readonly [T, T])[] {
  const next = new Map<T, T[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) next.get(from)?.push(to);
  const reach = new Map<T, Set<T>>();
  const reachable = (from: T): Set<T> => {
    const known = reach.get(from);
    if (known) return known;
    const found = new Set<T>();
    reach.set(from, found);
    for (const to of next.get(from) ?? []) {
      found.add(to);
      for (const further of reachable(to)) found.add(further);
    }
    return found;
  };
  return edges.filter(
    ([from, to]) =>
      !(next.get(from) ?? []).some((middle) => middle !== to && reachable(middle).has(to)),
  );
}
