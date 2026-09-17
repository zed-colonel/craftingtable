import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  crossProjectRequirements,
  DependencyGraph,
  PhaseRequirements,
  type MapNode,
} from './DependencyRequirements.js';
afterEach(cleanup);
const node = (
  sourceId: string,
  repository: string,
  state: string,
  requirements: string[] = [],
  kind: MapNode['kind'] = 'slice',
): MapNode => ({
  key: `${sourceId}:${state}`,
  sourceId,
  repository,
  state,
  requirements,
  kind,
  title: sourceId,
  included: true,
  priority: false,
  satisfied: false,
  status: 'Waiting for requirements',
  blockers: [],
  action: 'none',
});
const wi = node('wi/WI-02', 'wi', 'accepted', [], 'work_item');
const gate = node('EXO-WI-G1', 'wi', 'passed', [wi.key], 'checkpoint');
const start = node('exo/EXO-03/integration', 'exo', 'started');
const merge = node(start.sourceId, 'exo', 'merged', [start.key, gate.key]);
const verify = node(start.sourceId, 'exo', 'verified', [merge.key]);
const nodes = [wi, gate, start, merge, verify];
it('shows cross-project merge prerequisites and inherited verification without inventing a start gate', () => {
  expect(crossProjectRequirements(nodes, [start])).toEqual([]);
  expect(crossProjectRequirements(nodes, [merge])).toEqual([gate]);
  expect(crossProjectRequirements(nodes, [verify])).toEqual([gate]);
  const trace = vi.fn();
  render(<PhaseRequirements nodes={nodes} roots={[start, merge, verify]} onTrace={trace} />);
  fireEvent.click(screen.getByText(/Cross-project requirements/));
  expect(screen.queryByText('Needed to start')).toBeNull();
  expect(screen.getByText('Needed to merge')).toBeTruthy();
  expect(screen.getByText('Needed to verify')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: /wi\/WI-02/ })[0]!);
  expect(trace).toHaveBeenCalledWith(wi.key);
});
it('traces the checkpoint provider chain and offers navigation back to its project', () => {
  const trace = vi.fn(),
    locate = vi.fn();
  render(<DependencyGraph nodes={nodes} selected={merge} onTrace={trace} onLocate={locate} />);
  const graph = screen.getByRole('region', { name: 'Dependency graph' });
  fireEvent.click(within(graph).getByRole('button', { name: 'WI · wi/WI-02 · accepted' }));
  expect(trace).toHaveBeenCalledWith(wi.key);
  fireEvent.click(within(graph).getAllByRole('button', { name: 'Show in project' }).at(-1)!);
  expect(locate).toHaveBeenCalledWith(wi.key);
});
