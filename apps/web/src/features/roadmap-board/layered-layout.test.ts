import { describe, expect, it } from 'vitest';
import { layeredLayout, layersOf } from './layered-layout.js';

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
