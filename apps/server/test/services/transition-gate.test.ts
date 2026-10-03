import type { WorkItemId, WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories, WorkItemDependencySummary } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { predecessorGate } from '../../src/services/transition-gate.js';

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
