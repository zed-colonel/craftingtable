/**
 * A layered layout for a small directed acyclic graph (R-E3b, ADR-072), left to right: what is
 * required stands left of what requires it. Pure, and with no dependency:
 *
 * 1. layers by longest path from the sources, so every edge points rightwards;
 * 2. a dummy node on every layer a long edge crosses, so edges route between nodes, not over them;
 * 3. order within each layer by the barycentre of the neighbours in the layer before (then after),
 *    a few sweeps each way, keeping the order with the fewest crossings;
 * 4. coordinates on a grid, each layer centred on the tallest.
 *
 * The board caps the graph it lays out, so the quadratic steps stay small.
 */

export interface LayoutOptions {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  /** Space between layers, and between nodes in a layer. */
  readonly layerGap: number;
  readonly nodeGap: number;
  /** Ordering sweeps, down and up each. */
  readonly sweeps?: number;
}

export interface PlacedNode {
  readonly x: number;
  readonly y: number;
  readonly layer: number;
}

export interface PlacedEdge<T> {
  readonly from: T;
  readonly to: T;
  /** From the source's right edge to the target's left edge, through the edge's dummy nodes. */
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface Layout<T> {
  readonly nodes: ReadonlyMap<T, PlacedNode>;
  readonly edges: readonly PlacedEdge<T>[];
  readonly width: number;
  readonly height: number;
  /** Edge crossings between adjacent layers in the order chosen. */
  readonly crossings: number;
}

type Slot<T> = { readonly node: T } | { readonly dummy: number };

/** Longest-path layers: a source is at 0, every other node one right of its furthest requirement. */
export function layersOf<T>(
  nodes: readonly T[],
  edges: readonly (readonly [T, T])[],
): Map<T, number> {
  const before = new Map<T, T[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) before.get(to)?.push(from);
  const layer = new Map<T, number>();
  const visiting = new Set<T>();
  const place = (node: T): number => {
    const known = layer.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) throw new Error('The graph has a cycle.');
    visiting.add(node);
    const at = Math.max(-1, ...(before.get(node) ?? []).map(place)) + 1;
    visiting.delete(node);
    layer.set(node, at);
    return at;
  };
  for (const node of nodes) place(node);
  return layer;
}

/** Crossings between two adjacent layers' orders, for the edges between them. */
function crossingsBetween(edges: readonly (readonly [number, number])[]): number {
  let count = 0;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const [a1, b1] = edges[i]!;
      const [a2, b2] = edges[j]!;
      if ((a1 - a2) * (b1 - b2) < 0) count += 1;
    }
  return count;
}

export function layeredLayout<T>(
  nodes: readonly T[],
  edges: readonly (readonly [T, T])[],
  options: LayoutOptions,
): Layout<T> {
  const layerOf = layersOf(nodes, edges);
  const depth = Math.max(-1, ...layerOf.values()) + 1;
  // Each layer's slots, in input order to start with; an edge's chain of slots.
  const layers: Slot<T>[][] = Array.from({ length: depth }, () => []);
  const slotOf = new Map<T, Slot<T>>();
  for (const node of nodes) {
    const slot = { node };
    slotOf.set(node, slot);
    layers[layerOf.get(node)!]!.push(slot);
  }
  let dummies = 0;
  const chains = edges.map(([from, to]) => {
    const chain: Slot<T>[] = [slotOf.get(from)!];
    for (let l = layerOf.get(from)! + 1; l < layerOf.get(to)!; l++) {
      const dummy = { dummy: dummies++ };
      layers[l]!.push(dummy);
      chain.push(dummy);
    }
    chain.push(slotOf.get(to)!);
    return chain;
  });
  // Links between adjacent layers, both ways.
  const left = new Map<Slot<T>, Slot<T>[]>();
  const right = new Map<Slot<T>, Slot<T>[]>();
  for (const chain of chains)
    for (let i = 0; i + 1 < chain.length; i++) {
      right.set(chain[i]!, [...(right.get(chain[i]!) ?? []), chain[i + 1]!]);
      left.set(chain[i + 1]!, [...(left.get(chain[i + 1]!) ?? []), chain[i]!]);
    }
  const totalCrossings = (order: Slot<T>[][]) => {
    let count = 0;
    for (let l = 0; l + 1 < order.length; l++) {
      const position = new Map(order[l + 1]!.map((s, i) => [s, i]));
      count += crossingsBetween(
        order[l]!.flatMap((s, i) =>
          (right.get(s) ?? []).map((t) => [i, position.get(t)!] as const),
        ),
      );
    }
    return count;
  };
  /** Reorders a layer by its slots' mean position among their neighbours in `fixed`. */
  const reorder = (layer: Slot<T>[], fixed: Slot<T>[], links: Map<Slot<T>, Slot<T>[]>) => {
    const position = new Map(fixed.map((s, i) => [s, i]));
    const keyed = layer.map((slot, i) => {
      const near = (links.get(slot) ?? []).map((n) => position.get(n)!);
      return { slot, key: near.length ? near.reduce((a, b) => a + b, 0) / near.length : i, i };
    });
    keyed.sort((a, b) => a.key - b.key || a.i - b.i);
    return keyed.map((k) => k.slot);
  };
  let best = layers.map((l) => [...l]);
  let fewest = totalCrossings(best);
  let order = best;
  for (let sweep = 0; sweep < (options.sweeps ?? 4) && fewest > 0; sweep++) {
    order = order.map((l) => [...l]);
    for (let l = 1; l < order.length; l++) order[l] = reorder(order[l]!, order[l - 1]!, left);
    for (let l = order.length - 2; l >= 0; l--) order[l] = reorder(order[l]!, order[l + 1]!, right);
    const crossings = totalCrossings(order);
    if (crossings < fewest) {
      fewest = crossings;
      best = order;
    }
  }

  const tallest = Math.max(0, ...best.map((l) => l.length));
  const rowHeight = options.nodeHeight + options.nodeGap;
  const placed = new Map<Slot<T>, { x: number; y: number }>();
  best.forEach((layer, l) => {
    const offset = ((tallest - layer.length) * rowHeight) / 2;
    for (const [i, slot] of layer.entries())
      placed.set(slot, {
        x: l * (options.nodeWidth + options.layerGap),
        y: offset + i * rowHeight,
      });
  });
  const placedNodes = new Map<T, PlacedNode>(
    nodes.map((node) => [node, { ...placed.get(slotOf.get(node)!)!, layer: layerOf.get(node)! }]),
  );
  const middle = options.nodeHeight / 2;
  const placedEdges = chains.map((chain, e) => {
    const [from, to] = edges[e]!;
    const points = chain.map((slot, i) => {
      const at = placed.get(slot)!;
      return 'node' in slot
        ? { x: at.x + (i === 0 ? options.nodeWidth : 0), y: at.y + middle }
        : { x: at.x + options.nodeWidth / 2, y: at.y + middle };
    });
    return { from, to, points };
  });
  return {
    nodes: placedNodes,
    edges: placedEdges,
    width: Math.max(0, depth * (options.nodeWidth + options.layerGap) - options.layerGap),
    height: Math.max(0, tallest * rowHeight - options.nodeGap),
    crossings: fewest,
  };
}
