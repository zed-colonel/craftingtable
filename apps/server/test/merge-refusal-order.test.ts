import { randomUUID } from 'node:crypto';
import {
  asAgentRunId,
  asCheckpointId,
  asDecisionPreparationId,
  type ExecutionScope,
  type Worktree,
} from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  merge,
  runToFinish,
  scopeTree,
  storedRoadmap,
  supervisedMapFixture,
} from './execution-test-support.js';

/**
 * The merge's refusals ahead of its own checks (R-B7 scheduler half, increment 1; "Merges"):
 * `mergeWorktree` refuses on the worktree's guard, then a decision preparation's worktree, then a
 * tree its scope refuses (`requireTreeScope`, unless recovering), then takes the phase
 * reservation, then the repository's merge lane, and only inside them builds and asks its check. `server-execution-merge-gate.test.ts` pins the gate's own refusals and two operator
 * merges meeting on the lane; these rows pin the order of the refusals before the gate, which the
 * merge-executor split must keep.
 *
 * Every row merges a started, unreviewed slice tree, so a merge that got as far as its own
 * checks would refuse at the first of them, the adopted checks' run on the reviewed commit (the
 * first row).
 */

afterEach(cleanupExecutionFixtures);

const RESERVED = 'Waiting for local-development: 1/1 reservations occupied.';
const LANE = 'Another merge or repository mutation is in progress; retry after it finishes';
/** The merge's first own refusal for an unreviewed tree, inside the lane (`assertMergeRun`). */
const GATE =
  'The review needs a successful run of each declared check on its exact clean reviewed commit: ct-check --declared fixture. Checks the agent chooses are supplemental.';
const PREPARATION =
  'Decision preparation worktrees cannot be merged. Approve the decision separately.';
/** `requireTreeScope`'s refusal for a tree whose integration branch left its frozen binding. */
const SCOPE = 'The worktree no longer matches its frozen scope binding.';

async function sliceTree() {
  const f = await supervisedMapFixture();
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await adoptSupervisedMap(f);
  const scope = f.scopes[0] as ExecutionScope;
  expect(scope.kind).toBe('slice');
  const tree = await scopeTree(f, scope);
  // Started (a slice merges only once a run started in it), never reviewed.
  await runToFinish(f.state, tree.id, { role: 'design', permissionMode: 'auto' });
  const storage = f.state.context.storage;
  const execution = f.state.context.services.executionService;
  /** Another operation's place on the development workstation, as a run's start holds it. */
  const occupy = () => {
    storage.phaseScheduling.setCapacity('local-development', 1);
    storage.phaseScheduling.acquire({
      id: randomUUID(),
      workspaceId: f.state.workspaceId,
      worktreeId: tree.id,
      ownerId: 'another-run',
      phase: 'start',
      resourceKey: 'local-development',
      capacity: 1,
      acquiredAt: new Date().toISOString(),
    });
  };
  /** Another merge or repository mutation on the tree's repository, until released. */
  const holdLane = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = storage.execution.sourceRepositories.find(
      f.state.workspaceId,
      tree.repositoryId,
    )!.rootPath;
    const done = execution.branches.duringMerge(root, () => held);
    return async () => {
      release();
      await done;
    };
  };
  /** Another operation on the tree itself (its worktree guard), until released. */
  const holdTree = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard = (
      execution as unknown as {
        mutations: { during(id: string, holder: string, op: () => Promise<void>): Promise<void> };
      }
    ).mutations;
    const done = guard.during(tree.id, 'removal', () => held);
    return async () => {
      release();
      await done;
    };
  };
  /** Names the tree as a decision preparation's, as `launchPreparation` reserves one. */
  const preparationTree = (worktree: Worktree) => {
    const roadmap = storedRoadmap(f.state);
    const at = new Date().toISOString();
    expect(
      storage.roadmaps.save(
        {
          ...roadmap,
          version: roadmap.version + 1,
          decisionPreparations: [
            {
              id: asDecisionPreparationId(randomUUID()),
              definitionId: scope.definitionId,
              bindingRevision: scope.bindingRevision,
              bindingDigest: '0'.repeat(64),
              checkpointId: asCheckpointId('LOCAL-ADR-01'),
              workspaceId: f.state.workspaceId,
              repositoryId: worktree.repositoryId,
              projectId: worktree.projectId,
              planVersionId: worktree.planVersionId ?? roadmap.definition.entries[0]!.planVersionId,
              integrationBranch: worktree.integrationBranch ?? 'main',
              integrationSha: worktree.baseSha,
              worktreeId: worktree.id,
              runId: asAgentRunId(randomUUID()),
              profile: { backend: 'claude-code', model: 'decision-model' },
              deadlineAt: new Date(Date.now() + 60_000).toISOString(),
              instructions: '',
              createdAt: at,
              createdByUserId: f.state.userId,
            },
          ],
        },
        roadmap.version,
      ),
    ).toBe(true);
  };
  /** Moves the tree's integration branch off its frozen binding, so `requireTreeScope` refuses. */
  const driftTree = () => {
    const stored = storage.execution.worktrees.find(f.state.workspaceId, tree.id)!;
    expect(
      storage.execution.worktrees.setIntegrationBranch({
        workspaceId: f.state.workspaceId,
        worktreeId: tree.id,
        integrationBranch: 'elsewhere',
        expectedVersion: stored.version,
      }),
    ).toBeDefined();
  };
  const refusal = async () => {
    const response = await merge(f.state, tree.id);
    return { status: response.statusCode, message: response.json().error.message as string };
  };
  return { f, tree, occupy, holdLane, holdTree, preparationTree, driftTree, refusal };
}

it('refuses an unreviewed slice at its own first check when nothing holds it (the baseline)', async () => {
  const { refusal } = await sliceTree();
  expect(await refusal()).toEqual({ status: 409, message: GATE });
});

it('refuses on the phase reservation before the merge’s own checks', async () => {
  const { occupy, refusal } = await sliceTree();
  occupy();
  expect(await refusal()).toEqual({ status: 409, message: RESERVED });
});

it('refuses on the busy merge lane before the merge’s own checks', async () => {
  const { holdLane, refusal } = await sliceTree();
  const release = holdLane();
  expect(await refusal()).toEqual({ status: 409, message: LANE });
  await release();
});

it('refuses on the phase reservation before the busy lane', async () => {
  const { occupy, holdLane, refusal } = await sliceTree();
  occupy();
  const release = holdLane();
  expect(await refusal()).toEqual({ status: 409, message: RESERVED });
  await release();
});

it('refuses a decision preparation’s worktree before the reservation and the lane', async () => {
  const { tree, occupy, holdLane, preparationTree, refusal } = await sliceTree();
  preparationTree(tree);
  occupy();
  const release = holdLane();
  expect(await refusal()).toEqual({ status: 409, message: PREPARATION });
  await release();
});

// R-B7 scheduler half, review LOW-1: `requireTreeScope` refuses before the phase reservation
// and the lane are taken, not only inside them through the merge's own check.
it('refuses a tree its scope refuses before the reservation and the lane', async () => {
  const { occupy, holdLane, driftTree, refusal } = await sliceTree();
  driftTree();
  occupy();
  const release = holdLane();
  expect(await refusal()).toEqual({ status: 409, message: SCOPE });
  await release();
});

// R-B7 scheduler half, review LOW-1: the decision preparation's refusal comes before
// `requireTreeScope`, so a preparation's tree that its scope also refuses gets the preparation's.
it('refuses a decision preparation’s worktree before its scope', async () => {
  const { tree, preparationTree, driftTree, refusal } = await sliceTree();
  preparationTree(tree);
  driftTree();
  expect(await refusal()).toEqual({ status: 409, message: PREPARATION });
});

it('refuses on the worktree’s guard before everything else', async () => {
  const { tree, occupy, holdLane, holdTree, preparationTree, driftTree, refusal } =
    await sliceTree();
  preparationTree(tree);
  driftTree();
  occupy();
  const lane = holdLane();
  const guard = holdTree();
  const refused = await refusal();
  expect(refused).toEqual({ status: 409, message: 'This worktree is being removed.' });
  await guard();
  await lane();
});
