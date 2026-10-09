import { describe, expect, it } from 'vitest';
import { loopModel, MODEL } from './board-testing.js';
import { groupsOf, neighbourhood, transitiveReduction } from './graph-neighbourhood.js';

/** R-E3b, ADR-072: the neighbourhood graph's structure, traversed for drawing only. */

describe('neighbourhood', () => {
  it('folds a slice into its work item and keeps checkpoints apart', () => {
    const owner = groupsOf(MODEL);
    expect(owner.get(2)).toBe(1);
    expect(owner.get(4)).toBe(1);
    expect(owner.get(1)).toBe(1);
    expect(owner.get(0)).toBe(0);
  });

  it("draws the selection's group with what it requires and what requires it", () => {
    // Selecting a slice centres on its work item; the decision its start requires is one hop up.
    const near = neighbourhood(MODEL, 3, 2, 40)!;
    expect(near.centre).toBe(1);
    expect(near.groups.map((g) => g.node).sort()).toEqual([0, 1]);
    expect([...near.groups.find((g) => g.node === 1)!.members].sort()).toEqual([1, 2, 3, 4]);
    expect(near.edges).toEqual([[0, 1]]);
    expect(near.reached).toBe(2);
  });

  it('keeps the nearest groups under the cap and says how many it reached', () => {
    const near = neighbourhood(MODEL, 0, 2, 1)!;
    expect(near.groups.map((g) => g.node)).toEqual([0]);
    expect(near.edges).toEqual([]);
    expect(near.reached).toBe(2);
  });

  it('stops at the hops asked for', () => {
    expect(neighbourhood(MODEL, 0, 0, 40)!.groups.map((g) => g.node)).toEqual([0]);
  });
});

describe('transitive reduction', () => {
  it('drops an edge another path implies, and keeps the rest', () => {
    expect(
      transitiveReduction(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['a', 'c'],
          ['c', 'd'],
          ['a', 'd'],
          ['b', 'd'],
        ],
      ),
    ).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]);
  });

  it('drops an edge implied through two or more nodes', () => {
    expect(
      transitiveReduction(
        ['a', 'b', 'c', 'd'],
        [
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
          ['a', 'd'],
        ],
      ),
    ).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]);
  });

  it('keeps parallel paths of length one', () => {
    const edges = [
      ['a', 'c'],
      ['b', 'c'],
    ] as const;
    expect(transitiveReduction(['a', 'b', 'c'], edges)).toEqual(edges);
  });
});

describe('cycles at work-item level (R-E3b review H1)', () => {
  it('draws a work item and a decision that require each other, with both edges', () => {
    const near = neighbourhood(loopModel(), 3, 2, 40)!;
    expect(near.groups.map((g) => g.node).sort()).toEqual([0, 1]);
    expect([...near.edges].sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it('keeps every edge inside a cycle and reduces only between components', () => {
    // a and b require each other; both lead to c, and a also leads to c through d.
    const edges = [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'c'],
      ['b', 'c'],
      ['a', 'd'],
      ['d', 'c'],
    ] as const;
    // Both a → c and b → c are implied: the pair reaches c through d.
    expect(transitiveReduction(['a', 'b', 'c', 'd'], edges)).toEqual([
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'd'],
      ['d', 'c'],
    ]);
    // Without d, the pair's own edges to c both stay.
    expect(
      transitiveReduction(['a', 'b', 'c'], edges.slice(0, 4)).map(([f, t]) => `${f}${t}`),
    ).toEqual(['ab', 'ba', 'ac', 'bc']);
  });
});

describe('hops and the cap', () => {
  // A chain e0 → e1 → … → e5 of checkpoints, each its own group.
  const chain = {
    ...MODEL,
    graph: {
      ...MODEL.graph,
      nodes: Array.from({ length: 6 }, (_, i) => ({
        key: `checkpoint:e${i}:passed`,
        kind: 'checkpoint' as const,
        sourceId: `e${i}`,
        state: 'passed' as const,
        title: `e${i}`,
        requires: i === 0 ? [] : [i - 1],
        included: true,
      })),
    },
    board: { ...MODEL.board, nodes: Array.from({ length: 6 }, () => ({ satisfied: false })) },
  };
  it('reaches a node exactly the hops away and no further', () => {
    expect(neighbourhood(chain, 2, 2, 40)!.groups.map((g) => g.node)).toEqual([2, 1, 3, 0, 4]);
    expect(neighbourhood(chain, 2, 3, 40)!.groups.map((g) => g.node)).toContain(5);
  });
  it('keeps the nearest under the cap, not the lowest-numbered', () => {
    // From e5 the nearest are e5, e4, e3; e0 is numbered lowest but is furthest.
    expect(neighbourhood(chain, 5, 5, 3)!.groups.map((g) => g.node)).toEqual([5, 4, 3]);
  });
});
