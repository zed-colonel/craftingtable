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
 * The edges no longer path implies. Folding slices into work items can make cycles, so this works
 * on the graph's strongly connected components: an edge inside a component stays, and an edge
 * between components goes when another component it leads to reaches the target's.
 */
export function transitiveReduction<T>(
  nodes: readonly T[],
  edges: readonly (readonly [T, T])[],
): (readonly [T, T])[] {
  const component = components(nodes, edges);
  const next = new Map<number, Set<number>>();
  for (const [from, to] of edges) {
    const [a, b] = [component.get(from)!, component.get(to)!];
    if (a === b) continue;
    next.set(a, (next.get(a) ?? new Set()).add(b));
  }
  // The condensation is acyclic, so reachability is a plain memoised walk.
  const reach = new Map<number, Set<number>>();
  const reachable = (from: number): Set<number> => {
    const known = reach.get(from);
    if (known) return known;
    const found = new Set<number>();
    for (const to of next.get(from) ?? []) {
      found.add(to);
      for (const further of reachable(to)) found.add(further);
    }
    reach.set(from, found);
    return found;
  };
  return edges.filter(([from, to]) => {
    const [a, b] = [component.get(from)!, component.get(to)!];
    return a === b || ![...(next.get(a) ?? [])].some((m) => m !== b && reachable(m).has(b));
  });
}

/** Each node's strongly connected component (Tarjan), numbered from 0. */
function components<T>(nodes: readonly T[], edges: readonly (readonly [T, T])[]): Map<T, number> {
  const out = new Map<T, T[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) out.get(from)?.push(to);
  const index = new Map<T, number>();
  const low = new Map<T, number>();
  const stack: T[] = [];
  const onStack = new Set<T>();
  const component = new Map<T, number>();
  let counter = 0;
  let count = 0;
  const visit = (node: T) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of out.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node)!, low.get(to)!));
      } else if (onStack.has(to)) low.set(node, Math.min(low.get(node)!, index.get(to)!));
    }
    if (low.get(node) === index.get(node)) {
      let member: T;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.set(member, count);
      } while (member !== node);
      count += 1;
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return component;
}
