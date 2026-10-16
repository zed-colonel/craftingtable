import type { WorkItemId, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories, WorkItemDependencySummary } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { itemGate, predecessorGate } from '../../src/services/transition-gate.js';

const edge = (sourceId: string, status: WorkItemDependencySummary['status'], kind = 'required') =>
  ({ workItemId: `item-${sourceId}`, sourceId, status, kind }) as WorkItemDependencySummary;
const tx = (edges: readonly WorkItemDependencySummary[]) =>
  ({
    planning: { dependencies: { listPredecessors: () => edges } },
  }) as unknown as StorageRepositories;
const ws = 'ws' as WorkspaceId;
const item = 'item' as WorkItemId;

describe('predecessorGate (R-A7, CTRL-12)', () => {
  it('blocks on required predecessors that are not completed, ignoring recommended ones', () => {
    const gate = predecessorGate(
      tx([edge('A', 'completed'), edge('B', 'admitted'), edge('C', 'proposed', 'recommended')]),
      ws,
      item,
    );
    expect(gate.required.map((e) => e.sourceId)).toEqual(['A', 'B']);
    expect(gate.pending.map((e) => e.sourceId)).toEqual(['B']);
    expect(gate.blocked).toBe(true);
  });

  it('lets a caller count completed predecessors still in flight, as the roadmap scheduler does', () => {
    const edges = [edge('A', 'completed')];
    expect(predecessorGate(tx(edges), ws, item).blocked).toBe(false);
    const gate = predecessorGate(tx(edges), ws, item, undefined, (e) => e.sourceId === 'A');
    expect(gate.pending.map((e) => e.sourceId)).toEqual(['A']);
    expect(gate.blocked).toBe(true);
  });

  it('never applies the early-start exception to whole-item work', () => {
    const gate = predecessorGate(tx([edge('A', 'admitted')]), ws, item);
    expect(gate.early).toBe(false);
    expect(gate.blocked).toBe(true);
  });
});

/**
 * One item-status rule for commands, the cycle core, the roadmap scheduler and the launch (R-B4,
 * decision 2). Each row is an item, the scope its work runs in, and what the gate answers.
 */
describe('itemGate (R-B4, decision 2)', () => {
  const at = (status: 'proposed' | 'admitted' | 'completed', planVersionId = 'plan-1') =>
    ({ status, planVersionId }) as never;
  const merged = {
    status: 'completed',
    planVersionId: 'plan-1',
    mergeSha: 'a'.repeat(40),
  } as never;
  const slice = { kind: 'slice' } as never;
  const verification = { kind: 'slice-verification' } as never;
  const acceptance = { kind: 'parent-acceptance' } as never;
  it.each([
    ['an admitted item', at('admitted'), undefined, false, undefined],
    ['a missing item', undefined, undefined, false, 'item-unavailable'],
    [
      'a proposed item, for a command or the cycle',
      at('proposed'),
      undefined,
      false,
      'item-not-admitted',
    ],
    [
      'a proposed item, which the scheduler admits itself',
      at('proposed'),
      undefined,
      true,
      undefined,
    ],
    [
      'a completed whole item, its worktree unmerged',
      at('completed'),
      undefined,
      false,
      'item-completed-unmerged',
    ],
    [
      'a completed item, in the scheduler too',
      at('completed'),
      undefined,
      true,
      'item-completed-unmerged',
    ],
    // Was: any scope ran on under an item marked complete by hand, so a slice held its entry
    // while its cycle ran.
    [
      'a slice of an item marked complete without a merge',
      at('completed'),
      slice,
      false,
      'item-completed-unmerged',
    ],
    // A recovery round repairs a slice of an item its merge completed (2026-09-27, 2026-10-07).
    ['a slice of an item completed by its merge', merged, slice, false, undefined],
    ['a whole item completed by a merge', merged, undefined, true, 'item-completed-unmerged'],
    ['a verification of a completed item', at('completed'), verification, false, undefined],
    ['an acceptance of a completed item', at('completed'), acceptance, true, undefined],
  ] as const)('%s', (_name, item, scope, admits, code) =>
    expect(itemGate(item, scope, { admits })).toBe(code),
  );

  it('refuses an item of another plan version than the one the scheduler bound', () => {
    expect(
      itemGate(at('admitted', 'plan-2'), undefined, {
        admits: true,
        planVersionId: 'plan-1' as never,
      }),
    ).toBe('item-unavailable');
    expect(
      itemGate(at('admitted'), undefined, { admits: true, planVersionId: 'plan-1' as never }),
    ).toBeUndefined();
  });
});
