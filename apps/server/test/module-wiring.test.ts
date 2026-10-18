import { afterEach, expect, it, vi } from 'vitest';
import { cleanupExecutionFixtures, ready } from './execution-test-support.js';

/**
 * The services R-B7 split into modules are wired as one (increment 6 and 7 review, LOW-2 and
 * LOW-1/LOW-2): every module holds the service's own shared objects (one lock set, one writer, one
 * `RunState`, the daemon's one worktree guard), never a copy, and every delegate the facades kept
 * hands its module the arguments it was given and returns what the module returns.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

type Fields = Record<string, unknown>;

/** The service's fields that hold one of the modules made from it. */
function modulesOf(service: object): [string, Fields][] {
  return Object.entries(service as Fields).filter(
    (entry): entry is [string, Fields] =>
      typeof entry[1] === 'object' &&
      entry[1] !== null &&
      /^(Cycle|Run)[A-Z]/.test(entry[1].constructor.name),
  );
}

/** How many parameters a method declares, defaults and all (`length` stops at a default). */
function parameters(method: (...args: unknown[]) => unknown): number {
  const source = String(method);
  let depth = 0;
  let count = 0;
  let any = false;
  for (const char of source.slice(source.indexOf('(') + 1)) {
    if (depth === 0 && char === ')') break;
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) count++;
    else if (!/\s/.test(char)) any = true;
  }
  return any ? count + 1 : 0;
}

it('gives every module the service’s own shared objects and the daemon’s one guard', async () => {
  const state = await ready();
  const { workCycleService, agentRunService, storageService } = state.context.services;
  const guard = (storageService as unknown as Fields).mutations;
  expect(guard).toBeDefined();
  let checked = 0;
  for (const service of [workCycleService, agentRunService]) {
    const fields = service as unknown as Fields;
    const modules = modulesOf(service);
    expect(modules.length).toBeGreaterThan(4);
    for (const [name, module] of modules)
      for (const [key, value] of Object.entries(module)) {
        if (typeof value !== 'object' || value === null) continue;
        if (key === 'mutations') {
          expect(value, `${name}.mutations`).toBe(guard);
          checked++;
        } else if (key in fields) {
          expect(value, `${name}.${key}`).toBe(fields[key]);
          checked++;
        }
      }
  }
  // The locks, the writer, the gates, the settings, the state and the guard, in every module.
  expect(checked).toBeGreaterThan(60);
});

it('hands each delegate’s arguments to its module, and returns what the module returns', async () => {
  const state = await ready();
  const { workCycleService, agentRunService } = state.context.services;
  const delegates: string[] = [];
  for (const service of [workCycleService, agentRunService]) {
    const fields = service as unknown as Fields;
    const modules = modulesOf(service);
    const prototype = Object.getPrototypeOf(service) as Fields;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === 'constructor' || typeof prototype[method] !== 'function') continue;
      const owners = modules.filter(([, module]) => typeof module[method] === 'function');
      if (owners.length !== 1) continue;
      const [owner, module] = owners[0]!;
      const facade = fields[method] as (...args: unknown[]) => unknown;
      const args = Array.from({ length: parameters(facade) }, (_, i) => ({ argument: i }));
      const answer = { from: `${owner}.${method}` };
      const spy = vi
        .spyOn(module as Record<string, (...args: unknown[]) => unknown>, method)
        .mockImplementation(() => answer);
      // A void delegate returns nothing; any other returns its module's answer.
      const returns = /\breturn\b/.test(String(facade));
      expect(facade.apply(service, args), `${method} returns ${owner}'s answer`).toBe(
        returns ? answer : undefined,
      );
      expect(spy, `${method} → ${owner}`).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0], `${method} → ${owner}`).toEqual(args);
      expect(spy.mock.calls[0]?.every((arg, i) => arg === args[i])).toBe(true);
      spy.mockRestore();
      delegates.push(`${method} → ${owner}`);
    }
  }
  // Among them the replay's interception points and the run profiles' reads (spot checks).
  expect(delegates).toEqual(
    expect.arrayContaining([
      'resolveIntegration → integration',
      'refreshIntegration → integration',
      'start → starts',
      'control → controls',
      'repeatScopeReview → controls',
      'delegateScopeRepair → recovery',
      'listRunProfiles → profiles',
      'recoverInterrupted → processes',
    ]),
  );
});
