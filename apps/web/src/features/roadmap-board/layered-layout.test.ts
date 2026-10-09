import { describe, expect, it } from 'vitest';
import { backEdges, layeredLayout, layersOf } from './layered-layout.js';

/** R-E3b, ADR-072: the neighbourhood graph's layered layout, left to right. */

const options = { nodeWidth: 100, nodeHeight: 40, layerGap: 60, nodeGap: 20 };

describe('layered layout', () => {
  it('layers by longest path, so a requirement stands left of what requires it', () => {
    const layers = layersOf(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['a', 'c'],
        ['d', 'c'],
      ],
    );
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });

  it('refuses a cycle', () => {
    expect(() =>
      layersOf(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a'],
        ],
      ),
    ).toThrow('The graph has a cycle.');
  });

  it('points every edge rightwards and routes a long edge through its own slots', () => {
    const nodes = ['a', 'b', 'c'];
    const edges = [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
    ] as const;
    const layout = layeredLayout(nodes, edges, options);
    for (const { from, to, points } of layout.edges) {
      const [start, end] = [points[0]!, points.at(-1)!];
      expect(start.x).toBe(layout.nodes.get(from)!.x + options.nodeWidth);
      expect(end.x).toBe(layout.nodes.get(to)!.x);
      expect(end.x).toBeGreaterThan(start.x);
    }
    // a → c skips a layer: one slot of its own in b's layer, beside b, not on it.
    const long = layout.edges.find((e) => e.from === 'a' && e.to === 'c')!;
    expect(long.points).toHaveLength(3);
    expect(long.points[1]!.y).not.toBe(layout.nodes.get('b')!.y + options.nodeHeight / 2);
    expect(layout.width).toBe(3 * 100 + 2 * 60);
  });

  it('never stacks two nodes on one spot', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [
      ['a', 'd'],
      ['b', 'd'],
      ['c', 'e'],
      ['a', 'f'],
    ] as const;
    const layout = layeredLayout(nodes, edges, options);
    const spots = [...layout.nodes.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(spots).size).toBe(nodes.length);
    for (const p of layout.nodes.values()) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y + options.nodeHeight).toBeLessThanOrEqual(layout.height);
    }
  });

  it('orders a layer to remove the crossings its input order had', () => {
    // In input order a→d and b→c cross; the barycentre sweep uncrosses them.
    const layout = layeredLayout(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'd'],
        ['b', 'c'],
      ],
      options,
    );
    expect(layout.crossings).toBe(0);
    const y = (n: string) => layout.nodes.get(n)!.y;
    expect(Math.sign(y('a') - y('b'))).toBe(Math.sign(y('d') - y('c')));
  });

  it('lays out nothing as nothing', () => {
    expect(layeredLayout([], [], options)).toMatchObject({ width: 0, height: 0, crossings: 0 });
  });
});

describe('cycles (R-E3b review H1)', () => {
  it('lays out a cycle by turning a back edge around, and draws that edge backwards', () => {
    const edges = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ] as const;
    expect([...backEdges(['a', 'b', 'c'], edges)]).toEqual([2]);
    const layout = layeredLayout(['a', 'b', 'c'], edges, options);
    const x = (n: string) => layout.nodes.get(n)!.x;
    expect(x('a')).toBeLessThan(x('b'));
    expect(x('b')).toBeLessThan(x('c'));
    const back = layout.edges.find((e) => e.from === 'c')!;
    expect(back.back).toBe(true);
    // From c's left edge, right to left, to a's right edge, through its own slot.
    expect(back.points[0]!.x).toBe(x('c'));
    expect(back.points.at(-1)!.x).toBe(x('a') + options.nodeWidth);
    expect(back.points).toHaveLength(3);
    expect(layout.edges.filter((e) => !e.back)).toHaveLength(2);
  });

  it('draws a two-node loop as one edge each way, and ignores a self-loop', () => {
    const layout = layeredLayout(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['b', 'a'],
        ['a', 'a'],
      ],
      options,
    );
    expect(layout.edges.map((e) => [e.from, e.to, e.back])).toEqual([
      ['a', 'b', false],
      ['b', 'a', true],
    ]);
  });
});

describe('ordering and placement', () => {
  it('keeps the order with the fewest crossings, not the last sweep', () => {
    // Seeded random layered graphs: one more sweep never ends with more crossings, since the best
    // order so far is kept, and the count reported is the order placed.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let worsened = 0;
    for (let graph = 0; graph < 300; graph++) {
      const layers = [0, 1, 2, 3].map((l) =>
        Array.from({ length: 2 + Math.floor(random() * 4) }, (_, i) => `${l}-${i}`),
      );
      const edges: [string, string][] = [];
      for (let l = 0; l < 3; l++)
        for (const to of layers[l + 1]!) {
          // Every node past the first layer has a requirement in the layer before, so the layers
          // are the longest paths and every edge spans one layer (no dummy slots to count).
          const from = layers[l]!.filter(() => random() < 0.35);
          if (!from.length) from.push(layers[l]![Math.floor(random() * layers[l]!.length)]!);
          for (const f of from) edges.push([f, to]);
        }
      const nodes = layers.flat();
      let previous = Number.POSITIVE_INFINITY;
      for (let sweeps = 0; sweeps <= 6; sweeps++) {
        const layout = layeredLayout(nodes, edges, { ...options, sweeps });
        if (layout.crossings > previous) worsened += 1;
        previous = layout.crossings;
        const y = (n: string) => layout.nodes.get(n)!.y;
        const layer = (n: string) => layout.nodes.get(n)!.layer;
        let placed = 0;
        for (const [a1, b1] of edges)
          for (const [a2, b2] of edges)
            if (layer(a1) === layer(a2) && (y(a1) - y(a2)) * (y(b1) - y(b2)) < 0) placed += 1;
        expect(placed / 2).toBe(layout.crossings);
      }
    }
    expect(worsened).toBe(0);
  });

  it('centres a shorter layer on the tallest', () => {
    const layout = layeredLayout(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'd'],
        ['b', 'd'],
        ['c', 'd'],
      ],
      options,
    );
    const ys = ['a', 'b', 'c'].map((n) => layout.nodes.get(n)!.y);
    expect(layout.nodes.get('d')!.y).toBe((Math.min(...ys) + Math.max(...ys)) / 2);
  });
});
