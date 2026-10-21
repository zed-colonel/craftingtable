import { randomUUID } from 'node:crypto';
import { ownerPolicy } from '../src/services/roadmap/owner-policy.js';
import { readFileSync } from 'node:fs';
import {
  asConcurrencyDefinitionId,
  asDelegationAssignmentId,
  asFinalizationId,
  asPlanningTargetId,
  asProjectId,
  asPlanVersionId,
  asRoadmapAttemptId,
  asRoadmapEntryId,
  asRoadmapId,
  asSourceRepositoryId,
  asUserId,
  asWorkCycleId,
  asWorkItemId,
  asWorkspaceMembershipId,
  asWorktreeId,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  type Finalization,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapAutomation,
  type RoadmapDefinition,
  type RoadmapEntry,
  roadmapAttention,
  stopRecord,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { cycleOwnership } from '../src/services/cycle-ownership.js';
import { prioritizeRoadmapCycles } from '../src/services/cycle-priority.js';
import { currentCycleAttention } from '../src/services/cycle/core/attention-policy.js';
import {
  cycleFacts,
  onlyOperatorCanAdvance,
  refreshOwner,
} from '../src/services/cycle/core/facts.js';
import { TypedRefusalError } from '../src/services/errors.js';
import {
  controllerReviewRunnable,
  reviewAuthorityMissing,
  workflowDelegation,
} from '../src/services/workflow-policy.js';
import { type CycleFixture, createCycleFixture, storedCycle } from './cycle-test-support.js';
import { cleanupExecutionFixtures, startCycle } from './execution-test-support.js';

/**
 * What each scheduling reader of a cycle's owning roadmap answers today (R-B7 scheduler half,
 * increment 1; "Roadmap policy read outside the scheduler"): `cycleFacts`' `roadmapPaused` and
 * `settling`, `refreshOwner` (plain and launching) with its typed refusals,
 * `onlyOperatorCanAdvance`, `workflowDelegation`, `controllerReviewRunnable`,
 * `reviewAuthorityMissing`, the declared attention's roadmap claim, `providerRoadmapPaused`, the
 * launch's service-retry precondition and the pass's priority, over one table of owner states.
 * `OwnerPolicy` replaces their reads of the `Roadmap` record; every row must read the same after.
 *
 * Each row's roadmap is written by hand into a stepped daemon's storage, owning the fixture's
 * running cycle on its second entry (`subject`); a second attempt on the first entry (`sibling`)
 * lets the pass's ordering show. A row lists only where it differs from the running roadmap.
 */

afterEach(cleanupExecutionFixtures);

let f: CycleFixture;
let base: WorkCycle;
let branch: string;
const at = '2026-10-21T00:00:00.000Z';
const lostUser = asUserId('owner-policy-lost-user');
const viewer = asUserId('owner-policy-viewer');

/** A fresh stepped daemon per row: a workspace holds one roadmap, a plan one finalization. */
async function setup() {
  f = await createCycleFixture();
  base = await startCycle(f, f.worktreeId);
  branch = f.context.storage.execution.worktrees.find(f.workspaceId, f.worktreeId)!
    .integrationBranch!;
  f.context.storage.transaction((tx) => {
    tx.users.insert({
      id: viewer,
      username: 'owner-policy-viewer',
      usernameNormalized: 'owner-policy-viewer',
      passwordHash: `$argon2id$test$${Buffer.from('unused-password').toString('base64url')}`,
      occurredAt: at,
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId('owner-policy-viewer-membership'),
      workspaceId: f.workspaceId,
      userId: viewer,
      role: 'viewer',
      occurredAt: at,
    });
  });
}

const profile = { backend: 'claude-code' as const, permissionMode: 'auto' as const };
const profiles = { design: profile, implement: profile, review: profile, remediate: profile };
const automatic: RoadmapAutomation = {
  integrationMerge: 'automatic',
  integrationConflicts: 'automatic',
};
const manual: RoadmapAutomation = { integrationMerge: 'manual', integrationConflicts: 'manual' };
const parallel = {
  mode: 'parallel',
  maxInFlight: 2,
  maxPerRepository: 2,
  maxIntegrationRefreshes: 5,
} as const;
const sequential = { ...parallel, mode: 'sequential', maxIntegrationRefreshes: 4 } as const;

/** The parts of a row's roadmap; each defaults to the running roadmap's. */
interface OwnerState {
  readonly roadmap?: (ids: Ids) => Partial<Roadmap>;
  /** The definition the attempts were started under (revision 1). */
  readonly started?: (definition: RoadmapDefinition, ids: Ids) => Partial<RoadmapDefinition>;
  /** A later revision (2), current when given; the attempts stay on revision 1. */
  readonly current?: (definition: RoadmapDefinition, ids: Ids) => Partial<RoadmapDefinition>;
  readonly attempt?: (ids: Ids) => Partial<RoadmapAttempt>;
  /** Whether the subject attempt was retired (`retiredAttempts`). */
  readonly retired?: true;
  readonly cycle?: (cycle: WorkCycle) => WorkCycle;
  /** No roadmap at all: the cycle's own `owner` and fields decide. */
  readonly unowned?: true;
  /** A plan finalization's cycle, its finalization started by `creator`. */
  readonly finalization?: { readonly creator: 'operator' | 'lost' };
  /**
   * The subject's tree a review scope's: a worktree of that scope, the attempt's. Storage pins a
   * cycle's worktree, so the stored cycle keeps the fixture's and the claim is asked of the cycle
   * at this tree (`claimTree`).
   */
  readonly scope?: 'slice-verification' | 'parent-acceptance';
}
interface Ids {
  readonly roadmapId: ReturnType<typeof asRoadmapId>;
  readonly sibling: ReturnType<typeof asRoadmapEntryId>;
  readonly subject: ReturnType<typeof asRoadmapEntryId>;
}

function entry(id: Ids['subject'], sourceId: string, overrides: Partial<RoadmapEntry> = {}) {
  return {
    id,
    workItemId: asWorkItemId(sourceId === 'AQ-01' ? 'item-1' : 'item-2'),
    projectId: asProjectId('project-1'),
    planVersionId: asPlanVersionId('version-1'),
    sourceId,
    title: sourceId,
    repositoryId: asSourceRepositoryId(f.repositoryId),
    integrationBranch: branch,
    profiles,
    policy: DEFAULT_COMPLETION_POLICY,
    instructions: '',
    reviewerRoles: ['independent-reviewer'],
    ...overrides,
  } satisfies RoadmapEntry;
}

interface Arranged {
  readonly cycle: WorkCycle;
  readonly sibling: WorkCycle;
  /** The review scope's tree the claim is asked at, when the row gives one. */
  readonly claimTree?: WorkCycle['worktreeId'];
}

/** Writes the row's roadmap and cycle, and returns the stored cycle with its sibling. */
async function arrange(state: OwnerState): Promise<Arranged> {
  await setup();
  const storage = f.context.storage;
  const ids: Ids = {
    roadmapId: asRoadmapId(randomUUID()),
    sibling: asRoadmapEntryId(randomUUID()),
    subject: asRoadmapEntryId(randomUUID()),
  };
  const subjectAttempt = asRoadmapAttemptId(randomUUID());
  const siblingAttempt = asRoadmapAttemptId(randomUUID());
  const siblingCycle = asWorkCycleId(randomUUID());
  const current = storedCycle(f, base.id);
  let reviewTree: WorkCycle['worktreeId'] | undefined;
  let cycle: WorkCycle = { ...current, owner: null };
  if (state.finalization) {
    const recorded = JSON.parse(
      readFileSync(
        new URL('../../../fixtures/records/legacy-finalization-2026-09-13.json', import.meta.url),
        'utf8',
      ),
    ) as { finalization: Finalization };
    const finalization: Finalization = {
      ...recorded.finalization,
      id: asFinalizationId(randomUUID()),
      workspaceId: f.workspaceId,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      repositoryId: asSourceRepositoryId(f.repositoryId),
      worktreeId: f.worktreeId,
      cycleId: base.id,
      status: 'active',
      version: 1,
      createdByUserId: f.userId,
    };
    delete (finalization as { integrationCleanup?: unknown }).integrationCleanup;
    storage.transaction((tx) => tx.execution.finalizations.save(finalization, 0));
    cycle = {
      ...cycle,
      workItemId: undefined,
      planVersionId: asPlanVersionId('version-1'),
      finalizationId: finalization.id,
      createdByUserId: state.finalization.creator === 'lost' ? lostUser : f.userId,
    };
  } else if (!state.unowned) {
    const started: RoadmapDefinition = {
      roadmapId: ids.roadmapId,
      revision: 1,
      name: 'Owner policy readers',
      createdAt: at,
      createdByUserId: f.userId,
      scheduling: parallel,
      automation: automatic,
      crossProject: {
        definitionId: asConcurrencyDefinitionId(randomUUID()),
        bindingRevision: 1,
        targetId: asPlanningTargetId('ALL'),
        selection: 'prioritize-full',
        parentAcceptance: 'manual',
        defaults: {
          profiles,
          policy: DEFAULT_COMPLETION_POLICY,
          instructions: '',
          automation: manual,
        },
        overrides: [],
      },
      entries: [entry(ids.sibling, 'AQ-02'), entry(ids.subject, 'AQ-01')],
    };
    const first = { ...started, ...state.started?.(started, ids) };
    const later = state.current && { ...first, revision: 2, ...state.current(first, ids) };
    if (state.scope) {
      const own = storage.execution.worktrees.find(f.workspaceId, f.worktreeId)!;
      const id = asWorktreeId(randomUUID());
      reviewTree = storage.execution.worktrees.insert({
        id,
        workspaceId: f.workspaceId,
        repositoryId: own.repositoryId,
        projectId: own.projectId,
        workItemId: own.workItemId,
        branchName: `ct/review-${id.slice(0, 8)}`,
        baseSha: own.baseSha,
        baseBranch: own.baseBranch,
        integrationBranch: own.integrationBranch,
        path: `/nonexistent/review-${id}`,
        createdAt: at,
        createdByUserId: f.userId,
        executionScope: {
          kind: state.scope,
          definitionId: first.crossProject!.definitionId,
          bindingRevision: 1,
          sourceId: state.scope === 'slice-verification' ? 'local/AQ-01/a' : 'local/AQ-01',
        },
      }).id;
    }
    const attempt: RoadmapAttempt = {
      id: subjectAttempt,
      entryId: ids.subject,
      definitionRevision: 1,
      worktreeId: reviewTree ?? f.worktreeId,
      cycleId: base.id,
      status: 'active',
      createdAt: at,
      ...state.attempt?.(ids),
    };
    const sibling: RoadmapAttempt = {
      id: siblingAttempt,
      entryId: ids.sibling,
      definitionRevision: 1,
      worktreeId: asWorktreeId(randomUUID()),
      cycleId: siblingCycle,
      status: 'active',
      createdAt: at,
    };
    const roadmap: Roadmap = {
      id: ids.roadmapId,
      workspaceId: f.workspaceId,
      version: 1,
      status: 'running',
      reason: 'Running',
      createdAt: at,
      updatedAt: at,
      createdByUserId: f.userId,
      delegatedByUserId: f.userId,
      definition: first,
      attempts: state.retired ? [sibling] : [attempt, sibling],
      ...(state.retired
        ? {
            retiredAttempts: [
              { ...attempt, retiredAt: at, retiredByUserId: f.userId, reason: 'Re-verify.' },
            ],
          }
        : {}),
      ...state.roadmap?.(ids),
    };
    storage.roadmaps.save(roadmap, 0);
    if (later) storage.roadmaps.save({ ...roadmap, version: 2, definition: later }, 1);
    cycle = {
      ...cycle,
      owner: {
        roadmapId: ids.roadmapId,
        attemptId: attempt.id,
        entryId: attempt.entryId,
        definitionRevision: attempt.definitionRevision,
      },
    };
  }
  cycle = state.cycle ? state.cycle(cycle) : cycle;
  // A stored cycle keeps its subject (a work item or a finalization), so the finalization's
  // cycle is read as given beside the stored one, at its version: the launch reads only that.
  const written = state.finalization
    ? cycle
    : storage.execution.cycles.replace({ ...cycle, version: current.version + 1 }, current.version);
  if (!written) throw new Error('The row’s cycle was not written');
  return {
    cycle: written,
    ...(reviewTree ? { claimTree: reviewTree } : {}),
    sibling: {
      ...written,
      id: siblingCycle,
      owner: {
        roadmapId: ids.roadmapId,
        attemptId: siblingAttempt,
        entryId: ids.sibling,
        definitionRevision: 1,
      },
    },
  };
}

/** `refreshOwner`'s answer: its settings and user, nothing, or its typed refusal's code. */
function refresh(cycle: WorkCycle, launching: boolean) {
  try {
    const owner = refreshOwner(f.context.storage, cycle, launching);
    return owner
      ? {
          mode: owner.settings.mode,
          refreshes: owner.settings.maxIntegrationRefreshes,
          user: owner.context.user.id === f.userId ? 'operator' : owner.context.user.id,
        }
      : 'none';
  } catch (error) {
    if (error instanceof TypedRefusalError) return error.stop;
    throw error;
  }
}

/** Every reader's answer for the cycle as stored. */
function answers({ cycle, sibling, claimTree }: Arranged) {
  const storage = f.context.storage;
  const owner = cycleOwnership(storage, cycle);
  const facts = cycleFacts(storage, cycle, {
    now: new Date(),
    settling: new Set([owner?.roadmap.id ?? 'no-roadmap']),
    owner: () => ownerPolicy(storage, cycle),
  });
  const delegation = workflowDelegation(storage, cycle);
  // The roadmap claim, with the cycle at a merge approval and at a detected conflict.
  const claim = (stopped: WorkCycle) => currentCycleAttention(storage, stopped)?.claim;
  const atMerge = {
    ...cycle,
    ...(claimTree ? { worktreeId: claimTree } : {}),
    status: 'awaiting-merge',
    stop: stopRecord(cycleAttention('merge-approval'), at),
  } as WorkCycle;
  const atConflict = {
    ...cycle,
    ...(claimTree ? { worktreeId: claimTree } : {}),
    status: 'needs-attention',
    stop: stopRecord(cycleAttention('integration-conflict'), at),
    integrationResolution: {
      id: 'resolution-1',
      status: 'detected',
      headSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: branch,
      paths: ['src/lib.rs'],
      diagnostics: '',
      createdAt: at,
      attempts: 0,
    },
  } as WorkCycle;
  // A slice cycle with a workflow: the delegation then decides `onlyOperatorCanAdvance`.
  const slice = {
    ...cycle,
    executionScope: { kind: 'slice', definitionId: 'map', bindingRevision: 1, sourceId: 'wi/A' },
    workflow: {},
  } as unknown as WorkCycle;
  const controls = (
    f.services.workCycleService as unknown as {
      controls: { providerRoadmapPaused(cycle: WorkCycle): boolean };
    }
  ).controls;
  const preconditions = (
    f.services.agentRunService as unknown as {
      preconditions: { requireCycleLaunchAuthority(cycle: WorkCycle): void };
    }
  ).preconditions;
  let serviceRetry: string | undefined;
  try {
    preconditions.requireCycleLaunchAuthority({
      ...cycle,
      attempt: {
        providerRecovery: {
          attempts: 1,
          sourceRunId: cycle.currentRunId,
          failure: { kind: 'capacity', message: 'Overloaded.', safeToRetry: true },
          profile,
        },
      },
    } as unknown as WorkCycle);
  } catch (error) {
    serviceRetry = (error as Error).message;
  }
  const order = (cycles: WorkCycle[]) =>
    prioritizeRoadmapCycles(cycles, (c) => ownerPolicy(storage, c)).map((c) =>
      c.id === cycle.id ? 'subject' : 'sibling',
    );
  const forward = order([cycle, sibling]);
  const reverse = order([sibling, cycle]);
  return {
    roadmapPaused: facts.roadmapPaused(),
    settling: facts.settling(),
    refresh: refresh(cycle, false),
    refreshLaunching: refresh(cycle, true),
    onlyOperator: onlyOperatorCanAdvance(storage, cycle),
    onlyOperatorSlice: onlyOperatorCanAdvance(storage, slice),
    delegation: delegation && { runnable: delegation.runnable, roles: delegation.roles },
    reviewRunnable: controllerReviewRunnable(storage, cycle),
    authorityMissing: reviewAuthorityMissing(storage, cycle),
    claimAtMerge: claim(atMerge),
    claimAtConflict: claim(atConflict),
    providerPaused: controls.providerRoadmapPaused(cycle),
    serviceRetry,
    // The pass's order of the subject beside its sibling (the first entry), either way round.
    priority:
      forward[0] === 'subject' && reverse[0] === 'subject'
        ? 'ahead'
        : forward[0] === 'sibling' && reverse[0] === 'sibling'
          ? 'behind'
          : 'kept',
  };
}

const PARALLEL = { mode: 'parallel', refreshes: 5, user: 'operator' } as const;
const SEQUENTIAL = { mode: 'sequential', refreshes: 4, user: 'operator' } as const;
/** The running roadmap: parallel, automatic merges and conflicts, a reviewer delegated. */
const RUNNING = {
  roadmapPaused: false,
  settling: true,
  refresh: PARALLEL as unknown,
  refreshLaunching: PARALLEL as unknown,
  onlyOperator: false,
  onlyOperatorSlice: false,
  delegation: { runnable: true, roles: ['independent-reviewer'] } as unknown,
  reviewRunnable: true,
  authorityMissing: undefined as unknown,
  claimAtMerge: 'roadmap-merge' as unknown,
  claimAtConflict: 'conflict-automation' as unknown,
  providerPaused: false,
  serviceRetry: undefined as unknown,
  priority: 'behind',
};
/** What a roadmap that does not schedule the cycle answers (paused, needing attention). */
const NOT_RUNNING = {
  roadmapPaused: true,
  refresh: 'none',
  onlyOperator: true,
  onlyOperatorSlice: true,
  delegation: { runnable: false, roles: ['independent-reviewer'] },
  reviewRunnable: false,
  claimAtMerge: undefined,
  claimAtConflict: undefined,
  providerPaused: true,
  serviceRetry: 'Roadmap scheduling is paused; service retry is held.',
  priority: 'kept',
};
/** What a hold on the cycle's own entry answers. */
const HELD = {
  refresh: 'none',
  onlyOperator: true,
  onlyOperatorSlice: true,
  delegation: { runnable: false, roles: ['independent-reviewer'] },
  reviewRunnable: false,
  claimAtMerge: undefined,
  claimAtConflict: undefined,
};
const recovery = (ids: Ids, requestedByUserId?: ReturnType<typeof asUserId>) => ({
  recovery: {
    sourceEntryId: ids.sibling,
    sourceRunId: 'parent-run' as never,
    sourceSequence: 1,
    findingFingerprint: 'f'.repeat(64),
    phase: 'repair' as const,
    reviewRunIds: {},
    ...(requestedByUserId ? { requestedByUserId } : {}),
  },
});
const recoveryOn = {
  enabled: true,
  maxRoundsPerParent: 3,
  grantedByUserId: 'x' as never,
  grantedAt: at,
};
const grant = (ids: Ids, automation: RoadmapAutomation) => ({
  delegationAssignments: [
    {
      id: asDelegationAssignmentId(randomUUID()),
      entryIds: [ids.subject],
      automation,
      reviewerRoles: ['grant-reviewer'],
      rationale: 'Delegated.',
      appliedAt: at,
      appliedByUserId: f.userId,
    },
  ],
});
const manualSequential = () => ({ scheduling: sequential, automation: manual });

/** What a cycle no roadmap owns answers. */
const NO_OWNER = {
  settling: false,
  refresh: 'none',
  refreshLaunching: 'none',
  onlyOperator: true,
  onlyOperatorSlice: true,
  delegation: undefined,
  claimAtMerge: undefined,
  claimAtConflict: undefined,
  priority: 'kept',
};
const automaticAcceptance = (d: RoadmapDefinition) => ({
  crossProject: { ...d.crossProject!, parentAcceptance: 'automatic' as const },
});
const manualAcceptance = (d: RoadmapDefinition) => ({
  crossProject: { ...d.crossProject!, parentAcceptance: 'manual' as const },
});

const rows: readonly (readonly [string, OwnerState, Partial<typeof RUNNING>])[] = [
  ['no owner', { unowned: true }, NO_OWNER],
  ['the roadmap running', {}, {}],
  ['the roadmap paused', { roadmap: () => ({ status: 'paused' }) }, NOT_RUNNING],
  [
    'the roadmap needing attention',
    {
      roadmap: () => ({
        status: 'needs-attention',
        attention: roadmapAttention('scheduler-error'),
      }),
    },
    NOT_RUNNING,
  ],
  [
    'the roadmap stopped: its delegation ended, even for a launch',
    { roadmap: () => ({ status: 'stopped' }) },
    { ...NOT_RUNNING, refreshLaunching: 'none' },
  ],
  [
    'the roadmap paused and the cycle paused: a launch needs a running cycle',
    { roadmap: () => ({ status: 'paused' }), cycle: (c) => ({ ...c, status: 'paused' }) },
    {
      ...NOT_RUNNING,
      refreshLaunching: 'none',
      serviceRetry: 'Cycle no longer has authority to launch this step',
    },
  ],
  [
    'the entry held (needs-attention): the system’s hold holds a launch too',
    {
      roadmap: (ids) => ({
        entryHolds: {
          [ids.subject]: {
            status: 'needs-attention',
            reason: 'Blocked.',
            attention: roadmapAttention('entry-blocked'),
          },
        },
      }),
    },
    { ...HELD, refreshLaunching: 'none' },
  ],
  [
    'the entry paused by the operator: a launch still refreshes',
    {
      roadmap: (ids) => ({
        entryHolds: { [ids.subject]: { status: 'paused', reason: 'Paused.' } },
      }),
    },
    HELD,
  ],
  [
    'the round’s source entry held (paused): the delegation stays runnable',
    {
      attempt: (ids) => recovery(ids),
      roadmap: (ids) => ({
        scopeRecovery: recoveryOn,
        entryHolds: { [ids.sibling]: { status: 'paused', reason: 'Paused.' } },
      }),
    },
    {
      refresh: 'none',
      onlyOperator: true,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
    },
  ],
  [
    'the round’s source entry held (needs-attention)',
    {
      attempt: (ids) => recovery(ids),
      roadmap: (ids) => ({
        scopeRecovery: recoveryOn,
        entryHolds: {
          [ids.sibling]: {
            status: 'needs-attention',
            reason: 'Not converging.',
            attention: roadmapAttention('recovery-not-converging'),
          },
        },
      }),
    },
    {
      refresh: 'none',
      refreshLaunching: 'none',
      onlyOperator: true,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
    },
  ],
  [
    'a recovery round carried by automatic recovery',
    { attempt: (ids) => recovery(ids), roadmap: () => ({ scopeRecovery: recoveryOn }) },
    {},
  ],
  [
    'a recovery round carried for the operator who delegated it',
    { attempt: (ids) => recovery(ids, f.userId) },
    {},
  ],
  [
    'a recovery round not carried (recovery off, not delegated)',
    { attempt: (ids) => recovery(ids) },
    {
      refresh: 'none',
      refreshLaunching: 'none',
      onlyOperator: true,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
    },
  ],
  // A retired attempt still owns its cycle (R-C10), and it keeps the status it had.
  ['a retired attempt, its cycle still running', { retired: true }, {}],
  [
    'a retired attempt, its cycle ended',
    {
      retired: true,
      cycle: (c) => ({
        ...c,
        status: 'stopped',
        stop: { kind: 'ended', code: 'operator-stopped', at },
      }),
    },
    {
      refreshLaunching: 'none',
      serviceRetry: 'Cycle no longer has authority to launch this step',
    },
  ],
  // The claim has no attempt-active test; the priority and the refresh do.
  [
    'a completed attempt',
    { attempt: () => ({ status: 'completed', completedAt: at }) },
    { refresh: 'none', refreshLaunching: 'none', onlyOperator: true, priority: 'kept' },
  ],
  [
    'manual delegation in sequence: nothing refreshes it',
    { started: manualSequential },
    {
      refresh: 'none',
      refreshLaunching: 'none',
      onlyOperator: true,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
      priority: 'kept',
    },
  ],
  [
    'automatic merges by a delegation grant',
    {
      started: manualSequential,
      roadmap: (ids) =>
        grant(ids, { integrationMerge: 'automatic', integrationConflicts: 'manual' }),
    },
    {
      refresh: SEQUENTIAL,
      refreshLaunching: SEQUENTIAL,
      delegation: { runnable: true, roles: ['grant-reviewer'] },
      claimAtConflict: undefined,
      priority: 'kept',
    },
  ],
  [
    'automatic conflicts by a delegation grant',
    {
      started: manualSequential,
      roadmap: (ids) =>
        grant(ids, { integrationMerge: 'manual', integrationConflicts: 'automatic' }),
    },
    {
      refresh: SEQUENTIAL,
      refreshLaunching: SEQUENTIAL,
      delegation: { runnable: true, roles: ['grant-reviewer'] },
      claimAtMerge: undefined,
      priority: 'kept',
    },
  ],
  // The refresh reads the attempt's revision; the pass's priority the current one.
  [
    'the mode changed to sequential after the attempt',
    { current: () => ({ scheduling: sequential }) },
    { priority: 'kept' },
  ],
  [
    'the mode changed to parallel after the attempt',
    { started: () => ({ scheduling: sequential }), current: () => ({ scheduling: parallel }) },
    { refresh: SEQUENTIAL, refreshLaunching: SEQUENTIAL },
  ],
  [
    'the entry order changed after the attempt',
    { current: (d) => ({ entries: [d.entries[1]!, d.entries[0]!] }) },
    { priority: 'ahead' },
  ],
  [
    'the entry dropped from the current definition',
    { current: (d) => ({ entries: [d.entries[0]!] }) },
    {
      refresh: 'roadmap-binding-changed',
      refreshLaunching: 'roadmap-binding-changed',
      priority: 'kept',
    },
  ],
  [
    'the entry’s integration branch changed',
    {
      current: (d, ids) => ({
        entries: [d.entries[0]!, entry(ids.subject, 'AQ-01', { integrationBranch: 'elsewhere' })],
      }),
    },
    { refresh: 'roadmap-binding-changed', refreshLaunching: 'roadmap-binding-changed' },
  ],
  [
    'the entry’s repository changed',
    {
      current: (d, ids) => ({
        entries: [
          d.entries[0]!,
          entry(ids.subject, 'AQ-01', { repositoryId: asSourceRepositoryId(randomUUID()) }),
        ],
      }),
    },
    { refresh: 'roadmap-binding-changed', refreshLaunching: 'roadmap-binding-changed' },
  ],
  [
    'the delegator gone',
    { roadmap: () => ({ delegatedByUserId: lostUser }) },
    { refresh: 'delegation-authority-lost', refreshLaunching: 'delegation-authority-lost' },
  ],
  [
    'the delegator now a viewer',
    { roadmap: () => ({ delegatedByUserId: viewer }) },
    { refresh: 'delegation-authority-lost', refreshLaunching: 'delegation-authority-lost' },
  ],
  [
    'the delegator gone, under manual delegation in sequence: no refusal',
    { started: manualSequential, roadmap: () => ({ delegatedByUserId: lostUser }) },
    {
      refresh: 'none',
      refreshLaunching: 'none',
      onlyOperator: true,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
      priority: 'kept',
    },
  ],
  [
    'the binding changed and the delegator gone: the binding first',
    {
      roadmap: () => ({ delegatedByUserId: lostUser }),
      current: (d, ids) => ({
        entries: [d.entries[0]!, entry(ids.subject, 'AQ-01', { integrationBranch: 'elsewhere' })],
      }),
    },
    { refresh: 'roadmap-binding-changed', refreshLaunching: 'roadmap-binding-changed' },
  ],
  [
    'a single-project roadmap: no reviewer is delegated',
    { started: () => ({ crossProject: undefined }) },
    {
      delegation: undefined,
      reviewRunnable: false,
      authorityMissing: 'no-delegation',
    },
  ],
  [
    'the attempt’s revision unreadable: the refresh falls back to the current definition',
    { attempt: () => ({ definitionRevision: 3 }) },
    {
      delegation: undefined,
      reviewRunnable: false,
      authorityMissing: 'delegation-unreadable',
    },
  ],
  // R-B7 scheduler half, review LOW-5: the claim's review-scope branches. A slice verification's
  // merge is the roadmap's to verify, whatever the merge automation says.
  [
    'the subject’s tree a slice verification’s, at its merge',
    { scope: 'slice-verification' },
    { claimAtMerge: 'roadmap-verification' },
  ],
  // R-B7 scheduler half, review LOW-5: a parent acceptance's claim reads the attempt's frozen
  // revision's `parentAcceptance`, not the current revision's.
  [
    'a parent acceptance’s tree, automatic for the attempt and manual now',
    { scope: 'parent-acceptance', started: automaticAcceptance, current: manualAcceptance },
    { claimAtMerge: 'roadmap-acceptance' },
  ],
  [
    'a parent acceptance’s tree, manual for the attempt and automatic now',
    { scope: 'parent-acceptance', current: automaticAcceptance },
    { claimAtMerge: undefined },
  ],
  // R-B7 scheduler half, review LOW-5: a cycle whose recorded owner names an attempt the roadmap
  // no longer holds (in neither `attempts` nor `retiredAttempts`) is owned by no roadmap, even
  // though the roadmap's attempt still names the cycle; the search is only for a cycle with no
  // recorded owner.
  [
    'the cycle’s owner an attempt the roadmap no longer holds',
    {
      cycle: (c) => ({ ...c, owner: { ...c.owner!, attemptId: asRoadmapAttemptId(randomUUID()) } }),
    },
    NO_OWNER,
  ],
  // R-B7 scheduler half, review LOW-5: a cycle written without `owner` (before schema 29) is
  // resolved by the search over the roadmaps' attempts (`cycleOwnership`), and reads as owned.
  [
    'the cycle’s owner unrecorded, found by the search',
    {
      cycle: ({ owner: _owner, ...c }) => c,
    },
    {},
  ],
  [
    'a plan finalization’s cycle',
    { finalization: { creator: 'operator' } },
    {
      settling: false,
      refresh: { mode: 'sequential', refreshes: 3, user: 'operator' },
      refreshLaunching: { mode: 'sequential', refreshes: 3, user: 'operator' },
      delegation: undefined,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
      priority: 'kept',
    },
  ],
  [
    'a plan finalization whose creator lost authority',
    { finalization: { creator: 'lost' } },
    {
      settling: false,
      refresh: 'authority-lost',
      refreshLaunching: 'authority-lost',
      delegation: undefined,
      claimAtMerge: undefined,
      claimAtConflict: undefined,
      serviceRetry: 'Cycle no longer has authority to launch this step',
      priority: 'kept',
    },
  ],
];

describe('each owner-policy reader over one table of owner states (R-B7 scheduler half)', () => {
  it.each(rows)('%s', async (_name, state, differs) =>
    expect(answers(await arrange(state))).toEqual({ ...RUNNING, ...differs }),
  );
});
