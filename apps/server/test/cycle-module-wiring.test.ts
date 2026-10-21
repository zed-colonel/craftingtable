import { afterEach, expect, it, vi } from 'vitest';
import { cleanupExecutionFixtures, ready } from './execution-test-support.js';

/**
 * The cycle projection and the step outcome's application R-B7 moved out of the work-cycle
 * service are wired to it (scheduler half, increment 11): each holds the service's own locks,
 * writer and effect modules and composition's services, never a copy; and the service's
 * delegates hand the projection exactly their arguments and return its answers.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

type Fields = Record<string, unknown>;

it('gives the projection and the outcomes the work-cycle service’s own objects', async () => {
  const state = await ready();
  const { workCycleService, workspaceService, agentRunService } = state.context.services;
  const fields = workCycleService as unknown as Fields;
  const projections = fields.projections as Fields;
  expect(projections.storage).toBe(state.context.storage);
  expect(projections.workspaceService).toBe(workspaceService);
  expect(projections.locks).toBe(fields.locks);
  const outcomes = fields.outcomes as Fields;
  expect(outcomes.runs).toBe(agentRunService);
  for (const name of [
    'writer',
    'locks',
    'remediation',
    'integration',
    'workflow',
    'finalizationStage',
    'restart',
  ])
    expect(outcomes[name], `outcomes.${name}`).toBe(fields[name]);
});

it('hands the projection’s delegates their arguments, and returns its answers', async () => {
  const state = await ready();
  const { workCycleService } = state.context.services;
  const fields = workCycleService as unknown as Record<string, Record<string, unknown>>;
  const cases = [
    ['storedWork', 2],
    ['list', 3],
    ['views', 3],
    ['present', 1],
    ['holdsReminders', 2],
  ] as const;
  for (const [method, count] of cases) {
    const args = Array.from({ length: count }, (_, i) => ({ argument: i }));
    const answer = { from: `projections.${method}` };
    const spy = vi
      .spyOn(fields.projections as Record<string, (...args: unknown[]) => unknown>, method)
      .mockImplementation(() => answer);
    const facade = fields[method] as unknown as (...args: unknown[]) => unknown;
    expect(facade.apply(workCycleService, args), method).toBe(answer);
    expect(spy.mock.calls, method).toEqual([args]);
    expect(spy.mock.calls[0]?.every((arg, i) => arg === args[i])).toBe(true);
  }
});
