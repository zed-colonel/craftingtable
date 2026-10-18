import { type AgentRun, asAgentRunId, type WorkCycle } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { continuesLineage } from '../../src/services/run-lineage.js';

/**
 * Whether a newer run continues a cycle's handoff lineage, so a resume may adopt it (R-B4,
 * decision 14; increment 6 review, LOW-3): from the cycle's current run, or the parent it was
 * reserved from when the current run was never created; with neither, any run continues it.
 */

const run = (id: string, parentRunId?: string) =>
  ({
    id,
    workspaceId: 'ws',
    worktreeId: 'tree-1',
    workItemId: 'item-1',
    ...(parentRunId ? { parentRunId } : {}),
  }) as unknown as AgentRun;
const stored = new Map<string, AgentRun>(
  [run('run-0'), run('run-1', 'run-0'), run('run-2', 'run-1'), run('run-9')].map((r) => [r.id, r]),
);
const execution = { runs: { find: (_ws: string, id: string) => stored.get(id) } } as never;
const cycle = (currentRunId: string, parentRunId?: string) =>
  ({
    workspaceId: 'ws',
    currentRunId: asAgentRunId(currentRunId),
    ...(parentRunId ? { parentRunId: asAgentRunId(parentRunId) } : {}),
  }) as WorkCycle;

it.each([
  ['a run handed off from the current one', cycle('run-1'), 'run-2', true],
  ['the current run itself', cycle('run-1'), 'run-1', true],
  ['an unrelated run', cycle('run-1'), 'run-9', false],
  ['a run from the reserved step’s parent', cycle('run-missing', 'run-0'), 'run-2', true],
  ['an unrelated run, from the parent', cycle('run-missing', 'run-0'), 'run-9', false],
  ['any run, with no anchor at all', cycle('run-missing'), 'run-9', true],
] as const)('%s', (_name, at, id, expected) =>
  expect(continuesLineage(execution, at, stored.get(id)!)).toBe(expected),
);
