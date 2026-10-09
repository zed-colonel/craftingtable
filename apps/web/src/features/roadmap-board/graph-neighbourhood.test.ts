import { describe, expect, it } from 'vitest';
import { MODEL } from './board-testing.js';
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

  it('keeps parallel paths of length one', () => {
    const edges = [
      ['a', 'c'],
      ['b', 'c'],
    ] as const;
    expect(transitiveReduction(['a', 'b', 'c'], edges)).toEqual(edges);
  });
});
