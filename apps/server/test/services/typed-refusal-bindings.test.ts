import type { Finalization, WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchService } from '../../src/services/branch-service.js';
import { refreshOwner } from '../../src/services/cycle/core/facts.js';
import { TypedRefusalError } from '../../src/services/errors.js';
import {
  assertFinalizationMap,
  finalizationMapContext,
} from '../../src/services/map-finalization-policy.js';

/**
 * The stops named where a roadmap's binding, its delegation, a finalization's map or Git
 * changed under a cycle (R-B4, decision 3; increment 4 re-check). The sites read stored records
 * through policies stubbed here, so each row states only the change that refuses.
 */

const stub = vi.hoisted(() => ({
  ownership: undefined as unknown,
  delegation: undefined as unknown,
  runtimeId: 'runtime-1',
}));
vi.mock('../../src/services/cycle-ownership.js', () => ({ cycleOwnership: () => stub.ownership }));
vi.mock('../../src/services/roadmap-delegation-policy.js', () => ({
  attemptDelegation: () => stub.delegation,
}));
vi.mock('../../src/services/runtime-evidence-policy.js', () => ({
  activeRuntime: () => ({ id: stub.runtimeId }),
  parentAccepted: () => true,
}));
vi.mock('../../src/services/map-adoption-policy.js', () => ({ mapAdopted: () => true }));
vi.mock('../../src/services/scope-lineage.js', () => ({ amendmentHoldsBinding: () => false }));

/** The stop a call refuses with, or `undefined` when it does not refuse with a typed one. */
async function stopOf(call: () => unknown): Promise<string | undefined> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TypedRefusalError) return error.stop;
    throw error;
  }
  return undefined;
}

describe('the roadmap that owns a cycle (refreshOwner)', () => {
  const cycle = { id: 'cycle-1', workspaceId: 'ws', worktreeId: 'tree-1' } as unknown as WorkCycle;
  const entry = { id: 'entry-1', integrationBranch: 'revision', repositoryId: 'repo-1' };
  const storage = (
    tree: unknown,
    delegating: unknown = { id: 'user-2', status: 'active' },
    access: unknown = { membership: { role: 'owner' } },
  ) =>
    ({
      execution: { worktrees: { find: () => tree } },
      users: { findById: () => delegating },
      workspaces: { findAuthorized: () => access },
    }) as unknown as CraftingTableStorage;
  const bound = { integrationBranch: 'revision', repositoryId: 'repo-1' };
  beforeEach(() => {
    stub.ownership = {
      roadmap: { status: 'running', delegatedByUserId: 'user-2', definition: { entries: [entry] } },
      attempt: { status: 'active', entryId: 'entry-1' },
    };
    stub.delegation = {
      definition: { scheduling: { mode: 'parallel' } },
      automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
    };
  });

  it('stops a cycle whose worktree no longer matches its entry’s binding', async () => {
    expect(
      await stopOf(() => refreshOwner(storage({ ...bound, integrationBranch: 'other' }), cycle)),
    ).toBe('roadmap-binding-changed');
    expect(
      await stopOf(() => refreshOwner(storage({ ...bound, repositoryId: 'repo-2' }), cycle)),
    ).toBe('roadmap-binding-changed');
  });
  it('stops a cycle whose delegating user lost the permission', async () =>
    expect(
      await stopOf(() => refreshOwner(storage(bound, { id: 'user-2', status: 'disabled' }), cycle)),
    ).toBe('delegation-authority-lost'));
  // R-B7 increment 3 (CTRL-14): the site keeps its refusal for every way the rule fails.
  it.each([
    ['an inactive user', { id: 'user-2', status: 'disabled' }, { membership: { role: 'owner' } }],
    ['a viewer', { id: 'user-2', status: 'active' }, { membership: { role: 'viewer' } }],
    // `null` where the repository answers nothing: `undefined` would take the stub's default.
    ['a user who left the workspace', { id: 'user-2', status: 'active' }, null],
  ])('refuses a delegation by %s with its own text', (_name, user, access) => {
    let refused: unknown;
    try {
      refreshOwner(storage(bound, user, access), cycle);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(TypedRefusalError);
    expect({
      stop: (refused as TypedRefusalError).stop,
      message: (refused as Error).message,
    }).toEqual({
      stop: 'delegation-authority-lost',
      message: 'The roadmap initiating user no longer has permission.',
    });
  });
  it('refreshes a bound cycle for an editor', async () =>
    expect(
      refreshOwner(storage(bound, undefined, { membership: { role: 'editor' } }), cycle),
    ).toMatchObject({ context: { user: { id: 'user-2' } } }));
  it('refreshes a bound cycle for a user who still holds it', async () =>
    expect(refreshOwner(storage(bound), cycle)).toMatchObject({
      context: { user: { id: 'user-2' } },
    }));
});

describe('the map a finalization runs under', () => {
  const plan = 'plan-1';
  const binding = (definitionId: string) => ({
    revision: 1,
    bindings: [
      {
        alias: 'wi',
        projectId: 'project-1',
        planVersionId: plan,
        repositoryId: 'repo-1',
        integrationBranch: 'revision',
        branchSettingsVersion: 1,
      },
    ],
    definitionId,
  });
  const tx = (definitions: readonly string[], activePlan = plan) =>
    ({
      roadmaps: {
        list: () =>
          definitions.map((definitionId) => ({
            status: 'running',
            definition: { crossProject: { definitionId, bindingRevision: 1 } },
          })),
      },
      amendments: { superseded: () => false },
      imports: {
        bindings: (_ws: string, definitionId: string) => [binding(definitionId)],
        definition: (_ws: string, id: string) => ({ id, source: { work_items: [] } }),
      },
      planning: {
        workItems: { listForVersion: () => [] },
        projects: { find: () => ({ activePlanVersionId: activePlan }) },
      },
      execution: {
        finalizations: { list: () => [] },
        branchSettings: {
          find: () => ({ repositoryId: 'repo-1', integrationBranch: 'revision', version: 1 }),
        },
      },
    }) as unknown as StorageRepositories;
  const context = (definitions: readonly string[], activePlan?: string) => () =>
    finalizationMapContext(tx(definitions, activePlan), 'ws' as never, plan as never);
  beforeEach(() => {
    stub.runtimeId = 'runtime-1';
  });

  it('refuses the map’s own requirements as a phase gate', async () =>
    expect(await stopOf(context(['def-1'], 'plan-0'))).toBe('phase-gate'));
  it('refuses several bindings covering the plan as a binding change', async () =>
    expect(await stopOf(context(['def-1', 'def-2']))).toBe('roadmap-binding-changed'));
  it('names the one binding that covers the plan', () =>
    expect(context(['def-1'])()).toEqual({
      definitionId: 'def-1',
      bindingRevision: 1,
      runtimeId: 'runtime-1',
      alias: 'wi',
    }));
  it('stops a finalization whose map or pinned environment changed', async () => {
    const finalization = {
      workspaceId: 'ws',
      planVersionId: plan,
      mapContext: { definitionId: 'def-1', bindingRevision: 1, runtimeId: 'runtime-0' },
    } as unknown as Finalization;
    expect(await stopOf(() => assertFinalizationMap(tx(['def-1']), finalization))).toBe(
      'finalization-inactive',
    );
    stub.runtimeId = 'runtime-0';
    expect(await stopOf(() => assertFinalizationMap(tx(['def-1']), finalization))).toBeUndefined();
  });
});

it('stops a launch the daemon has no Git for as the service’s', async () => {
  const storage = {
    execution: {
      sourceRepositories: { find: () => ({ id: 'repo-1', rootPath: '/repo', status: 'active' }) },
    },
  } as unknown as CraftingTableStorage;
  const branches = new BranchService(
    storage,
    {} as never,
    {} as never,
    undefined,
    {} as never,
    () => new Date(),
  );
  expect(
    await stopOf(() =>
      branches.validateLaunch({
        workspaceId: 'ws',
        repositoryId: 'repo-1',
        integrationBranch: 'revision',
      } as never),
    ),
  ).toBe('service-unavailable');
});
