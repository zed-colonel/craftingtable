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
    // A layout that sweeps once more than it needs gives the same crossings it found best.
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'];
    const edges = [
      ['a', 'e'],
      ['b', 'd'],
      ['c', 'f'],
      ['a', 'd'],
      ['c', 'd'],
    ] as const;
    const once = layeredLayout(nodes, edges, { ...options, sweeps: 1 });
    const many = layeredLayout(nodes, edges, { ...options, sweeps: 8 });
    expect(many.crossings).toBeLessThanOrEqual(once.crossings);
    // Every recorded count is the count of the order placed.
    const y = (n: string) => many.nodes.get(n)!.y;
    let crossings = 0;
    for (const [a1, b1] of edges)
      for (const [a2, b2] of edges) if ((y(a1) - y(a2)) * (y(b1) - y(b2)) < 0) crossings += 1;
    expect(crossings / 2).toBe(many.crossings);
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
