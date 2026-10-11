import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from './api-client.js';
import { agentGroups, applyRoadmapAgents } from './roadmap-api.js';

vi.mock('./api-client.js', () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

/** R-E5b: a roadmap setup's agent changes, as ADR-064 assignments. */
const set = (model: string) =>
  ({
    design: { backend: 'claude-code', model },
    implement: { backend: 'claude-code' },
    review: { backend: 'claude-code' },
    remediate: { backend: 'claude-code' },
  }) as const;

it('gives the entries that chose the same agents one assignment, and each other set its own', () => {
  expect(
    agentGroups(
      new Map([
        ['a', set('x')],
        ['b', set('y')],
        ['c', set('x')],
      ]),
    ),
  ).toEqual([
    { entryIds: ['a', 'c'], selections: set('x') },
    { entryIds: ['b'], selections: set('y') },
  ]);
});

it('applies each assignment at the version the last one left, and reports each as applied', async () => {
  vi.mocked(request).mockResolvedValueOnce({ version: 6 }).mockResolvedValueOnce({ version: 7 });
  const applied = vi.fn();
  const groups = [
    { entryIds: ['a'], selections: set('x') },
    { entryIds: ['b'], selections: set('y') },
  ];
  const latest = await applyRoadmapAgents(asWorkspaceId('ws'), 'r', 5, groups, 'csrf', applied);
  const sent = vi
    .mocked(request)
    .mock.calls.map(([, , init]) => JSON.parse((init as { body: string }).body).expectedVersion);
  expect(sent).toEqual([5, 6]);
  expect(applied.mock.calls.map(([group]) => group)).toEqual(groups);
  expect(latest).toEqual({ version: 7 });
});
