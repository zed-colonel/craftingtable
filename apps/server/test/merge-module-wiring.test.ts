import { afterEach, expect, it, vi } from 'vitest';
import { cleanupExecutionFixtures, ready } from './execution-test-support.js';

/**
 * The merge executor and the scope receipts R-B7 moved out of the execution service are wired to
 * it (scheduler half, increment 10): each holds the service's own branches (whose merge lane and
 * `mergesContained` the scheduler replay patches), its worktree guard and evidence service, never
 * a copy; and the service's delegates hand them exactly their arguments.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

type Fields = Record<string, unknown>;

it('gives the merge modules the execution service’s own objects', async () => {
  const state = await ready();
  const { executionService, runtimeEvidenceService, workItemService } = state.context.services;
  const fields = executionService as unknown as Fields;
  for (const name of ['merges', 'receipts']) {
    const module = fields[name] as Fields;
    expect(module.branches, `${name}.branches`).toBe(executionService.branches);
    expect(module.mutations, `${name}.mutations`).toBe(fields.mutations);
    expect(module.runtimeEvidence, `${name}.runtimeEvidence`).toBe(runtimeEvidenceService);
    expect(module.workItemService, `${name}.workItemService`).toBe(workItemService);
    expect(module.storage, `${name}.storage`).toBe(state.context.storage);
    // The review of increment 10 (NIT-3): its clock, notifier, workspace service and Git too.
    for (const field of ['now', 'notifier', 'workspaceService', 'git'])
      expect(module[field], `${name}.${field}`).toBe(fields[field]);
  }
  expect((fields.merges as Fields).repositoryChecks).toBe(executionService.repositoryChecks);
  expect((fields.merges as Fields).config).toBe(fields.config);
  expect(fields.workspaceService).toBe(state.context.services.workspaceService);
});

it('hands mergeWorktree and recordScopeReceipt their arguments, and returns the modules’ answers', async () => {
  const state = await ready();
  const { executionService } = state.context.services;
  const fields = executionService as unknown as Record<string, Record<string, unknown>>;
  const cases = [
    ['merges', 'mergeWorktree', 7],
    ['receipts', 'recordScopeReceipt', 5],
  ] as const;
  for (const [module, method, count] of cases) {
    const args = Array.from({ length: count }, (_, i) => ({ argument: i }));
    const answer = { from: `${module}.${method}` };
    const spy = vi
      .spyOn(fields[module] as Record<string, (...args: unknown[]) => unknown>, method)
      .mockImplementation(() => answer);
    const facade = fields[method] as unknown as (...args: unknown[]) => unknown;
    expect(facade.apply(executionService, args)).toBe(answer);
    expect(spy.mock.calls).toEqual([args]);
    expect(spy.mock.calls[0]?.every((arg, i) => arg === args[i])).toBe(true);
  }
});
