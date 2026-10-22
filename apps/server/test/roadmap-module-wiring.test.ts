import { afterEach, expect, it, vi } from 'vitest';
import { cleanupExecutionFixtures, ready } from './execution-test-support.js';

/**
 * The roadmap scheduler R-B7 split into modules is wired as one (scheduler half, increment 7):
 * every module holds the facade's own state, writer and modules, and composition's own service
 * instances (the ones the scheduler replay patches), never a copy; and every delegate the facade
 * kept hands its module the arguments it was given and returns what the module returns.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

type Fields = Record<string, unknown>;

/** The facade's fields that hold one of the modules made from it. */
function modulesOf(service: object): [string, Fields][] {
  return Object.entries(service as Fields).filter(
    (entry): entry is [string, Fields] =>
      typeof entry[1] === 'object' &&
      entry[1] !== null &&
      /^Roadmap[A-Z]/.test(entry[1].constructor.name),
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

it('gives every module the facade’s own state, writer and modules, and composition’s services', async () => {
  const state = await ready();
  const { services, storage } = state.context;
  const roadmaps = services.roadmapService;
  const fields = roadmaps as unknown as Fields;
  // What composition hands the facade, by the name every module gives it.
  const composed: Fields = {
    storage,
    workspaces: services.workspaceService,
    items: services.workItemService,
    execution: services.executionService,
    cycles: services.workCycleService,
    agents: services.agentRunService,
    runtimeEvidence: services.runtimeEvidenceService,
    // The daemon's one Git, which the execution service holds too.
    git: (services.executionService as unknown as { git: unknown }).git,
  };
  // R-B7 scheduler half, review of increment 7 (NIT-2): the facade's own fields, which the
  // modules are checked against below, are composition's objects.
  expect(fields.storage, 'the facade’s storage').toBe(storage);
  expect(fields.workspaces, 'the facade’s workspaces').toBe(services.workspaceService);
  const modules = modulesOf(roadmaps);
  expect(modules.map(([name]) => name).sort()).toEqual(
    [
      'admission',
      'roadmapAttention',
      'controls',
      'drain',
      'holds',
      'integration',
      'preparations',
      'recovery',
      'selection',
      'settings',
      'settlement',
      'state',
      'views',
      'writer',
    ].sort(),
  );
  let checked = 0;
  for (const [name, module] of modules)
    for (const [key, value] of Object.entries(module)) {
      if (typeof value !== 'object' || value === null) continue;
      if (key in fields) {
        expect(value, `${name}.${key}`).toBe(fields[key]);
        checked++;
      } else if (key in composed) {
        expect(value, `${name}.${key}`).toBe(composed[key]);
        checked++;
      }
    }
  // Every module's state, writer and the modules below it, and the services it was built over.
  expect(checked).toBeGreaterThan(60);
});

it('hands each delegate’s arguments to its module, and returns what the module returns', async () => {
  const state = await ready();
  const roadmaps = state.context.services.roadmapService;
  const fields = roadmaps as unknown as Fields;
  const modules = modulesOf(roadmaps).filter(([name]) => name !== 'settlement');
  const prototype = Object.getPrototypeOf(roadmaps) as Fields;
  const delegates: string[] = [];
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
    expect(facade.apply(roadmaps, args), `${method} returns ${owner}'s answer`).toBe(
      returns ? answer : undefined,
    );
    expect(spy, `${method} → ${owner}`).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0], `${method} → ${owner}`).toEqual(args);
    expect(spy.mock.calls[0]?.every((arg, i) => arg === args[i])).toBe(true);
    spy.mockRestore();
    delegates.push(`${method} → ${owner}`);
  }
  // Every public member but the facade's own (its wind-down, seams and attach points).
  expect(delegates.sort()).toEqual(
    [
      'agentSettings → views',
      'applyAgentSettings → settings',
      'applyDelegation → settings',
      'assignCycleEntryAgents → settings',
      'capacities → views',
      'configureDecisionPreparation → settings',
      'configureReverification → settings',
      'configureScopeRecovery → settings',
      'control → controls',
      'controlEntry → controls',
      'decisionSettings → views',
      'definition → views',
      'delegateScopeRepair → recovery',
      'figures → drain',
      'graph → views',
      'history → views',
      'holdAdmissions → drain',
      'list → views',
      'lockReleased → drain',
      'mapItemSlices → views',
      'page → views',
      'passAttention → roadmapAttention',
      'prepareDecision → preparations',
      'recoverInterrupted → controls',
      'reverifyEntry → controls',
      'save → settings',
      'saveCapacity → settings',
      'saveDefinition → settings',
      'shutdown → drain',
      'startWorker → drain',
      'statusList → views',
      'statusOf → views',
      'summaries → views',
      'syncAttention → roadmapAttention',
      'tick → drain',
      'wake → drain',
      'workspaceProfiles → settings',
    ].sort(),
  );
});

it('keeps no scheduler member on the facade that a module holds (a seam left there reaches nothing)', async () => {
  const state = await ready();
  const roadmaps = state.context.services.roadmapService;
  const prototype = Object.getPrototypeOf(roadmaps) as Fields;
  for (const name of [
    'advance',
    'advanceEntry',
    'evaluateEntry',
    'integrate',
    'blocker',
    'complete',
    'change',
    'persist',
    'authority',
    'roundBody',
    'launchPreparation',
    'prepareNeededDecisions',
    'adoptManualRepairs',
    'releaseHold',
    'assertRunnable',
    'view',
  ])
    expect(name in prototype, name).toBe(false);
});
