import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentRun,
  type AgentRunId,
  DEFAULT_ROADMAP_SCHEDULING,
  type WorkCycle,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRequestError, TypedRefusalError } from '../src/services/errors.js';
import {
  admit,
  beginFinalization,
  branchCommand,
  cleanupExecutionFixtures,
  commitFile,
  controlCycle,
  CycleBackend,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  finalizationCycle,
  finalizationFixture,
  fixtureRepository,
  git,
  implementationDone,
  mutationHeaders,
  present,
  type Ready,
  ready,
  registerAndWorktree,
  reviewText,
  stagedInput,
  stagedLedger,
  stagedText,
  stageIdea,
  startCycle,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B7 increment 3 (CTRL-14, operator decision 4): the cycle half's copies of a shared validator,
 * one row per site with the refusal it gives today, written before the rule moved into one
 * function each. Every site keeps its own refusal: class, code, status and message (and
 * `startWorkflowReview`'s audit row). The pure sites' rows are in `cycle-commands.test.ts`,
 * `typed-refusal-sites.test.ts`, `typed-refusal-bindings.test.ts` and `cycle-facts.test.ts`.
 */

/**
 * Two sites sit behind a check another policy answers first, so their rows force that answer:
 * a cycle whose owner may refresh it (`refreshOwner`), and a controller review a delegating
 * roadmap runs (`workflowContext`, `workflowDelegation`, `controllerReviewRunnable`). Off, each
 * answers as before.
 */
const forced = vi.hoisted(() => ({ refreshOwner: false, workflow: false }));
vi.mock('../src/services/cycle/core/facts.js', async (original) => {
  const actual = await original<typeof import('../src/services/cycle/core/facts.js')>();
  return {
    ...actual,
    refreshOwner: (...args: Parameters<typeof actual.refreshOwner>) =>
      forced.refreshOwner
        ? {
            settings: { ...DEFAULT_ROADMAP_SCHEDULING, maxIntegrationRefreshes: 3 },
            context: { user: args[0].users.findById(args[1].createdByUserId) },
          }
        : actual.refreshOwner(...args),
  };
});
vi.mock('../src/services/workflow-policy.js', async (original) => {
  const actual = await original<typeof import('../src/services/workflow-policy.js')>();
  return {
    ...actual,
    workflowContext: (...args: Parameters<typeof actual.workflowContext>) =>
      forced.workflow
        ? ({ checkpoints: [], definitionId: 'none' } as never)
        : actual.workflowContext(...args),
    workflowDelegation: (...args: Parameters<typeof actual.workflowDelegation>) =>
      forced.workflow ? ({ roles: [] } as never) : actual.workflowDelegation(...args),
    controllerReviewRunnable: (...args: Parameters<typeof actual.controllerReviewRunnable>) =>
      forced.workflow || actual.controllerReviewRunnable(...args),
  };
});

afterEach(async () => {
  forced.refreshOwner = false;
  forced.workflow = false;
  vi.restoreAllMocks();
  await cleanupExecutionFixtures();
});

/** A refusal as a caller meets it: the error's class, its code or stop, and its message. */
async function refusalOf(call: () => unknown) {
  try {
    await call();
  } catch (error) {
    if (error instanceof TypedRefusalError)
      return {
        class: 'TypedRefusalError',
        stop: error.stop,
        code: error.code,
        message: error.message,
      };
    if (error instanceof ExecutionRequestError)
      return { class: error.constructor.name, code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

/** Takes a user's authority away as every read sees it from now on: inactive, or a viewer. */
function revoke(state: Ready, userId: string, how: 'disabled' | 'viewer') {
  const database = openDatabase(state.context.storage.databasePath);
  try {
    if (how === 'disabled')
      database.prepare(`UPDATE users SET status = 'disabled' WHERE id = ?`).run(userId);
    else
      database
        .prepare(
          `UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = ? AND workspace_id = ?`,
        )
        .run(userId, state.workspaceId);
  } finally {
    database.close();
  }
}

const NOW = new Date('2026-10-17T12:00:00Z');

/** How many audit rows of an action the daemon has written. */
function auditCount(state: Ready, action: string): number {
  const database = openDatabase(state.context.storage.databasePath);
  try {
    return (
      database.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action = ?').get(action) as {
        n: number;
      }
    ).n;
  } finally {
    database.close();
  }
}

describe("the delegated user's authority (activeEditor)", () => {
  it.each(['disabled', 'viewer'] as const)(
    "refuses a cycle's launch once its creator is %s (requireCycleLaunchAuthority)",
    async (how) => {
      const { state, backend, worktree } = await cycleFixture([], () => NOW);
      let release!: () => void;
      backend.replyForRequest = () => ({
        ...designDone,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });
      const cycle = await startCycle(state, worktree.id);
      await waitFor(() => backend.launches.length === 1, 'the design launch');
      revoke(state, state.userId, how);
      expect(
        await refusalOf(() =>
          state.context.services.agentRunService.startForCycle(currentCycle(state, cycle)),
        ),
      ).toEqual({
        class: 'ExecutionRequestError',
        code: 'conflict',
        message: 'Cycle no longer has authority to launch this step',
      });
      release();
    },
  );

  it.each(['disabled', 'viewer'] as const)(
    'refuses a manual review whose starter is %s once its checks ran (launchRefusal)',
    async (how) => {
      const { state, worktree } = await cycleFixture([], () => NOW);
      const runs = state.context.services.agentRunService as unknown as {
        launchRefusal(
          workspaceId: string,
          runId: AgentRunId,
          worktreeId: string,
          userId: string,
          cycle: WorkCycle | undefined,
        ): string | undefined;
      };
      const refusal = () =>
        runs.launchRefusal(
          state.workspaceId,
          'run-1' as AgentRunId,
          worktree.id,
          state.userId,
          undefined,
        );
      expect(refusal()).toBeUndefined();
      revoke(state, state.userId, how);
      expect(refusal()).toBe('Run launch permission changed while the review’s checks ran.');
    },
  );

  it.each(['disabled', 'viewer'] as const)(
    'refuses a manual launch whose starter is %s during its preparation (the launch)',
    async (how) => {
      const { state, backend, worktree } = await cycleFixture([implementationDone], () => NOW);
      const branches = state.context.services.executionService.branches;
      const validate = branches.validateLaunch.bind(branches);
      vi.spyOn(branches, 'validateLaunch').mockImplementation(async (...args) => {
        await validate(...args);
        revoke(state, state.userId, how);
      });
      const response = await state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
        headers: mutationHeaders(state),
        payload: { worktreeId: worktree.id, role: 'implement', permissionMode: 'auto' },
      });
      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 409,
        body: {
          error: { code: 'conflict', message: 'Run launch permission changed during preparation.' },
        },
      });
      expect(backend.launches).toHaveLength(0);
    },
  );
});

describe("the delegated user's authority in the cycle's effects", () => {
  it.each(['disabled', 'viewer', 'removed'] as const)(
    'refuses a controller review once the cycle creator is %s (startWorkflowReview)',
    async (how) => {
      const { state, worktree } = await cycleFixture([designDone], () => NOW);
      const cycle = await startCycle(state, worktree.id);
      await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'the stop');
      const source = present(
        state.context.storage.execution.runs.find(
          state.workspaceId,
          currentCycle(state, cycle).currentRunId,
        ),
      );
      forced.workflow = true;
      if (how === 'removed') {
        const database = openDatabase(state.context.storage.databasePath);
        try {
          database
            .prepare('DELETE FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?')
            .run(state.userId, state.workspaceId);
        } finally {
          database.close();
        }
      } else revoke(state, state.userId, how);
      const denied = () => auditCount(state, 'workspace.access.denied');
      const before = denied();
      // The workflow's controller reviews (R-B7 increment 7: the workflow effects).
      const cycles = (
        state.context.services.workCycleService as unknown as {
          workflow: {
            startWorkflowReview(
              cycle: WorkCycle,
              source: AgentRun,
              kind: 'reassessment',
            ): Promise<void>;
          };
        }
      ).workflow;
      let refused: unknown;
      try {
        await cycles.startWorkflowReview(currentCycle(state, cycle), source, 'reassessment');
      } catch (error) {
        refused = error;
      }
      expect({
        class: (refused as Error | undefined)?.constructor.name,
        stop: (refused as { stop?: string } | undefined)?.stop,
        message: (refused as Error | undefined)?.message,
        audited: denied() - before,
      }).toEqual(
        how === 'disabled'
          ? {
              class: 'TypedRefusalError',
              stop: 'delegation-authority-lost',
              message: 'Delegating user is no longer active.',
              audited: 0,
            }
          : how === 'viewer'
            ? { class: 'ForbiddenError', stop: undefined, message: expect.any(String), audited: 0 }
            : { class: 'NotFoundError', stop: undefined, message: expect.any(String), audited: 1 },
      );
    },
  );

  it.each(['disabled', 'viewer'] as const)(
    "stops an implementation's checkpoint once the cycle creator is %s (finalizeImplementation)",
    async (how) => {
      const { state, backend, worktree } = await cycleFixture(
        [designDone, implementationDone, { resultText: reviewText([]) }],
        () => NOW,
      );
      backend.onLaunch = (request) => {
        if (request.model === 'implement-model')
          writeFileSync(join(worktree.path, 'uncommitted.txt'), 'left by the agent\n');
      };
      const branches = state.context.services.executionService.branches;
      const busy = branches.repositoryBusy.bind(branches);
      let revoked = false;
      // Just before the checkpoint's guard, once the implementation has finished.
      vi.spyOn(branches, 'repositoryBusy').mockImplementation((root) => {
        if (!revoked && backend.launches.length === 2) {
          const run = state.context.storage.execution.runs
            .listForWorktree(state.workspaceId, worktree.id)
            .find((r) => r.role === 'implement');
          if (run?.status === 'finished') {
            revoked = true;
            revoke(state, state.userId, how);
          }
        }
        return busy(root);
      });
      const cycle = await startCycle(state, worktree.id);
      await waitFor(
        () => revoked && currentCycle(state, cycle).status !== 'running',
        'the checkpoint stop',
      );
      const stopped = currentCycle(state, cycle);
      expect({
        status: stopped.status,
        attention: stopped.attention,
        reason: stopped.reason,
      }).toEqual({
        status: 'needs-attention',
        attention: { code: 'implementation-commit-failed', owner: 'operator' },
        reason: 'Finalization was superseded or its authority was revoked.',
      });
      expect(backend.launches).toHaveLength(2);
    },
  );
});

describe("the delegated user's authority over integration", () => {
  it.each(['disabled', 'viewer'] as const)(
    'stops an integration refresh once the cycle creator is %s (performIntegrationRefresh)',
    async (how) => {
      const { state, backend, worktree, root } = await cycleFixture(
        [designDone, implementationDone, { resultText: reviewText([]) }],
        () => NOW,
      );
      // An owner that may refresh the cycle, as a roadmap's attempt or a finalization has.
      forced.refreshOwner = true;
      backend.onLaunch = (request) => {
        if (request.model === 'implement-model') {
          commitFile(worktree.path, 'item.txt', 'item\n');
          commitFile(root, 'advanced.txt', 'integration moved on\n');
        }
      };
      const branches = state.context.services.executionService.branches;
      const advanced = branches.integrationAdvanced.bind(branches);
      let revoked = false;
      vi.spyOn(branches, 'integrationAdvanced').mockImplementation(async (...args) => {
        const answer = await advanced(...args);
        if (answer && !revoked) {
          revoked = true;
          revoke(state, state.userId, how);
        }
        return answer;
      });
      const cycle = await startCycle(state, worktree.id);
      await waitFor(
        () => revoked && currentCycle(state, cycle).status !== 'running',
        'the refresh stop',
      );
      const stopped = currentCycle(state, cycle);
      expect({
        status: stopped.status,
        attention: stopped.attention,
        reason: stopped.reason,
      }).toEqual({
        status: 'needs-attention',
        attention: { code: 'integration-update-failed', owner: 'operator' },
        reason: 'The initiating user no longer has permission to run this cycle.',
      });
      expect(backend.launches).toHaveLength(2);
    },
  );

  it.each(['disabled', 'viewer'] as const)(
    'refuses an integration resolution once the user it acts for is %s (resolveIntegration)',
    async (how) => {
      const { state, backend, worktree, root } = await cycleFixture(
        [designDone, implementationDone, { resultText: reviewText([]) }],
        () => NOW,
      );
      backend.onLaunch = (request) => {
        if (request.model === 'implement-model')
          commitFile(worktree.path, 'README.md', 'item behavior\n');
      };
      const cycle = await startCycle(state, worktree.id);
      await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'the approval');
      await controlCycle(state, currentCycle(state, cycle), 'pause');
      commitFile(root, 'README.md', 'integration behavior\n');
      const resolution = (input: Record<string, unknown>) =>
        state.context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/integration-resolution`,
          headers: mutationHeaders(state),
          payload: { expectedVersion: currentCycle(state, cycle).version, ...input },
        });
      const inspected = await resolution({ action: 'inspect' });
      expect(inspected.statusCode, inspected.body).toBe(200);
      const branches = state.context.services.executionService.branches;
      const validate = branches.validateResolutionCommand.bind(branches);
      vi.spyOn(branches, 'validateResolutionCommand').mockImplementation(async (...args) => {
        await validate(...args);
        revoke(state, state.userId, how);
      });
      const launches = backend.launches.length;
      const response = await resolution({
        action: 'start',
        profile: { ...cycleProfiles.remediate, model: 'resolution-model' },
        instructions: 'Preserve both behaviors',
      });
      expect({ status: response.statusCode, body: response.json() }).toEqual({
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'Resolution was superseded or delegation was revoked',
          },
        },
      });
      expect(backend.launches).toHaveLength(launches);
    },
  );
});

describe('extra remediation rounds', () => {
  it.each([0, 21, 1.5])(
    "refuses %s rounds for a cycle's Authorize more remediation (authorizeWorkItemRemediation)",
    async (rounds) => {
      const { state, worktree } = await cycleFixture(
        [designDone, implementationDone, { resultText: reviewText([]) }],
        () => NOW,
      );
      const cycle = await startCycle(state, worktree.id);
      await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'the approval');
      const user = present(state.context.storage.users.findById(state.userId));
      expect(
        await refusalOf(() =>
          state.context.services.workCycleService.authorizeWorkItemRemediation(
            { user },
            state.workspaceId,
            cycle.id,
            {
              action: 'authorize-remediation',
              expectedVersion: currentCycle(state, cycle).version,
              additionalRounds: rounds,
              instructions: '',
            },
          ),
        ),
      ).toEqual({
        class: 'ExecutionRequestError',
        code: 'conflict',
        message: 'Authorize between 1 and 20 additional remediation attempts.',
      });
    },
  );
});

/** A staged finalization stopped on one correctness finding with no remediation budget. */
async function findingCheckpoint() {
  const fixture = await finalizationFixture();
  const finding = { ...structuredFinding, category: 'correctness', severity: 'nit' };
  fixture.backend.replyForRequest = (request) => ({
    resultText: stagedText(request, [finding], { questions: 'Fix this finding?' }),
  });
  const value = await beginFinalization(
    fixture,
    stagedInput(fixture.legacyInput, { maxRemediationRounds: 0 }),
  );
  await waitFor(
    () => finalizationCycle(fixture.state, value).status === 'needs-attention',
    'the finding decision',
  );
  const user = present(fixture.state.context.storage.users.findById(fixture.state.userId));
  return { ...fixture, value, finding, user };
}

/** A staged finalization at its simplification stage's optional selection. */
async function selectingStage() {
  const fixture = await finalizationFixture();
  const input = stagedInput(fixture.legacyInput);
  input.stages = input.stages.map((s) =>
    s.kind === 'simplification' ? { ...s, policy: { ...s.policy, maxRemediationRounds: 0 } } : s,
  );
  const idea = { ...stageIdea, id: 'S-1' };
  fixture.backend.replyForRequest = (request) => {
    if (request.model?.endsWith('-implement'))
      return { resultText: 'Selected batch committed.\n\n## Open questions\nnone' };
    const ledger = stagedLedger(request);
    const current = ledger.stages[ledger.progress.stageIndex];
    return {
      resultText: stagedText(request, current?.kind === 'simplification' ? [idea] : []),
    };
  };
  const value = await beginFinalization(fixture, input);
  await waitFor(
    () => finalizationCycle(fixture.state, value).status === 'needs-attention',
    'the optional selection',
  );
  expect(
    finalizationCycle(fixture.state, value).finalizationProgress?.stages[
      finalizationCycle(fixture.state, value).finalizationProgress?.stageIndex ?? 0
    ]?.status,
  ).toBe('selecting');
  const user = present(fixture.state.context.storage.users.findById(fixture.state.userId));
  return { ...fixture, value, idea, user };
}

describe('the instruction bound and extra rounds in a staged finalization', () => {
  it('refuses a findings decision whose rationale and guidance together pass 16,000 characters, or 0 or 21 rounds (decideFinalizationFindings)', async () => {
    const { state, value, finding, user } = await findingCheckpoint();
    const cycles = state.context.services.workCycleService;
    const decide = (input: {
      rationale: string;
      instructions?: string;
      additionalRounds?: number;
    }) =>
      refusalOf(() =>
        cycles.decideFinalizationFindings({ user }, finalizationCycle(state, value), {
          action: 'remediate-findings',
          findingIds: [finding.id],
          ...input,
        }),
      );
    expect(
      await decide({
        rationale: 'r'.repeat(8000),
        instructions: 'i'.repeat(8000),
        additionalRounds: 1,
      }),
    ).toEqual({
      class: 'ExecutionRequestError',
      code: 'invalid-request',
      message:
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
    });
    for (const additionalRounds of [undefined, 0, 21, 1.5])
      expect(
        await decide({
          rationale: 'Fix it.',
          ...(additionalRounds === undefined ? {} : { additionalRounds }),
        }),
      ).toEqual({
        class: 'ExecutionRequestError',
        code: 'invalid-request',
        message: 'Authorize 1–20 additional remediation attempts.',
      });
  });

  it('refuses a stage decision whose rationale and guidance together pass 16,000 characters (decideFinalizationStage)', async () => {
    const { state, value, user } = await findingCheckpoint();
    expect(
      await refusalOf(() =>
        state.context.services.workCycleService.decideFinalizationStage(
          { user },
          finalizationCycle(state, value),
          {
            action: 'select-stage-findings',
            selectedFindingIds: [],
            rationale: 'r'.repeat(8000),
            instructions: 'i'.repeat(8000),
          } as never,
        ),
      ),
    ).toEqual({
      class: 'ExecutionRequestError',
      code: 'invalid-request',
      message:
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
    });
  });

  it('refuses a stage selection with -1 or 21 extra attempts (decideFinalizationStage)', async () => {
    const { state, value, idea, user } = await selectingStage();
    for (const additionalRounds of [-1, 21, 1.5])
      expect(
        await refusalOf(() =>
          state.context.services.workCycleService.decideFinalizationStage(
            { user },
            finalizationCycle(state, value),
            {
              action: 'select-stage-findings',
              selectedFindingIds: [idea.id],
              rationale: 'Keep this change focused.',
              additionalRounds,
            } as never,
          ),
        ),
      ).toEqual({
        class: 'ExecutionRequestError',
        code: 'invalid-request',
        message: 'Authorize at most 20 additional stage attempts.',
      });
  });

  it("refuses a finalization's Authorize more remediation with 0 or 21 rounds (authorizeFinalizationRemediation)", async () => {
    const { state, value, user } = await findingCheckpoint();
    for (const rounds of [0, 21, 1.5])
      expect(
        await refusalOf(() =>
          state.context.services.workCycleService.authorizeFinalizationRemediation(
            { user },
            finalizationCycle(state, value),
            rounds,
            '',
          ),
        ),
      ).toEqual({
        class: 'ExecutionRequestError',
        code: 'conflict',
        message: 'Authorize between 1 and 20 additional remediation attempts.',
      });
  });
});

describe('the repository policy match', () => {
  /** An item worktree on `main`, under a policy adopted once the plan integrates into `revision`. */
  async function mismatched() {
    const backend = new CycleBackend([implementationDone]);
    const state = await ready({ backend, now: () => NOW });
    const root = fixtureRepository();
    const { worktree, repository } = await registerAndWorktree(state, root);
    await admit(state);
    git(['branch', 'revision'], root);
    const moved = await branchCommand(state, 'plan-versions/version-1/branch-settings', {
      expectedVersion: 1,
      repositoryId: repository.id,
      integrationBranch: 'revision',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const path = 'plan-versions/version-1/repository-policy';
    const preview = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/${path}`,
      headers: { cookie: state.cookie },
    });
    const adopted = await branchCommand(state, path, {
      expectedVersion: 0,
      expectedBranchSettingsVersion: 2,
      controlMode: 'controller-local',
      experimentalFreeze: preview.json().proposedFreeze,
      interpretation: 'Use controller gates now.',
      publicationRequirement: 'Verify remote protections before first publication.',
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    const launch = (role: 'implement' | 'review') =>
      state.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
        headers: mutationHeaders(state),
        payload: { worktreeId: worktree.id, role, permissionMode: 'auto' },
      });
    return { state, backend, launch };
  }

  it('refuses a launch in a worktree that does not match the adopted policy (the launch)', async () => {
    const { backend, launch } = await mismatched();
    const response = await launch('implement');
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'The worktree does not match the adopted repository policy.',
        },
      },
    });
    expect(backend.launches).toHaveLength(0);
  });

  it("refuses a review's capture in a worktree that does not match the adopted policy (reviewSnapshot)", async () => {
    const { backend, launch } = await mismatched();
    const response = await launch('review');
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message:
            'Worktree destination differs from the adopted repository policy. Retarget or review the policy.',
        },
      },
    });
    expect(backend.launches).toHaveLength(0);
  });
});
