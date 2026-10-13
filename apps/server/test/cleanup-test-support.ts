import { createHash, randomUUID } from 'node:crypto';
import {
  asPlanVersionId,
  asProjectId,
  asRoadmapEntryId,
  asRoadmapId,
  asSessionId,
  asUserId,
  asWorkItemId,
  asWorkspaceMembershipId,
  DEFAULT_COMPLETION_POLICY,
  type WorkspaceId,
  type WorkspaceRole,
} from '@craftingtable/domain';
import { expect } from 'vitest';
import type { AuthContext } from '../src/services/auth-service.js';
import {
  awaitRoadmapMerge,
  designDone,
  git,
  implementationDone,
  mutationHeaders,
  parallelFixture,
  parallelScheduling,
  present,
  type Ready,
  reviewText,
  roadmapControl,
  roadmapId,
  saveRoadmapRequest,
  stepPermissions,
  waitFor,
} from './execution-test-support.js';

/** Fixtures for cleaning up a wound-down roadmap (R-B11). */

export const OTHER = asRoadmapId('00000000-0000-4000-8000-000000000040');
export const FOURTH = asWorkItemId('item-4');

/** The work item whose worktree a launch runs in. */
export function itemAt(state: Ready, cwd: string) {
  return state.context.storage.execution.worktrees
    .listActive(state.workspaceId)
    .find((tree) => tree.path === cwd)?.workItemId;
}

/**
 * A stopped parallel roadmap with two unmerged attempts (the first item's and the third's), the
 * third merged into main by hand afterwards, and a second roadmap running in the workspace with
 * its own worktree and branch.
 */
export async function cleanupFixture({ withOther = true }: { readonly withOther?: boolean } = {}) {
  const fixture = await parallelFixture({ independentThird: true });
  const { state, backend, input, root } = fixture;
  let releaseOther: () => void = () => undefined;
  const otherHeld = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  backend.replyForRequest = (request) =>
    request.model === 'design-model'
      ? itemAt(state, request.cwd) === FOURTH
        ? { ...designDone, release: otherHeld }
        : designDone
      : request.model === 'review-model'
        ? { resultText: reviewText([]) }
        : implementationDone;
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await awaitRoadmapMerge(state, 0);
  await awaitRoadmapMerge(state, 1);
  expect((await roadmapControl(state, 'stop')).statusCode).toBe(200);
  const trees = () =>
    present(state.context.storage.roadmaps.find(state.workspaceId, roadmapId)).attempts.map((a) =>
      present(state.context.storage.execution.worktrees.find(state.workspaceId, a.worktreeId)),
    );
  const [first, third] = trees();
  if (!first || !third) throw new Error('two attempts');
  const firstTip = git(['rev-parse', first.branchName], root).trim();
  const thirdTip = git(['rev-parse', third.branchName], root).trim();
  // The third item was merged by hand after the stop: its branch is contained in main.
  git(['merge', '--no-ff', '--no-edit', third.branchName], root);
  // The operator's own checks branch, which no cleanup touches.
  git(['branch', 'craftingtable/checks', 'main'], root);
  // A second roadmap runs in the workspace on an independent item.
  const otherTree = withOther ? await startOther(state) : undefined;
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]);
  const service = state.context.services.repositoryCleanupService;
  const refs = () =>
    git(['for-each-ref', '--format=%(refname) %(objectname)'], root).trim().split('\n').sort();
  return {
    ...fixture,
    first,
    third,
    firstTip,
    thirdTip,
    otherTree,
    auth,
    service,
    refs,
    release: () => releaseOther(),
  };
}

export function cleanupAudit(state: Ready) {
  return [
    ...state.context.storage.audit.listWorkspace({ workspaceId: state.workspaceId, limit: 2000 }),
  ]
    .reverse()
    .filter((e) => e.action === 'repository-cleanup.action');
}

/** A second roadmap, running in the workspace on an independent fourth item of version 1. */
export async function startOther(state: Ready) {
  state.context.storage.planning.workItems.insertMany([
    {
      id: FOURTH,
      workspaceId: state.workspaceId,
      projectId: asProjectId('project-1'),
      planVersionId: asPlanVersionId('version-1'),
      sourceId: 'AQ-04',
      ordinal: 3,
      title: 'Another roadmap',
      risk: 'low',
      primaryAreas: [],
      exitGate: 'Done',
      sourceFields: { id: 'AQ-04' },
    },
  ]);
  const other = {
    expectedVersion: 0,
    name: 'Other roadmap',
    // The stopped roadmap's two worktrees still hold slots: nothing here retired them.
    scheduling: { ...parallelScheduling, maxPerRepository: 4 },
    entries: [
      {
        id: asRoadmapEntryId('00000000-0000-4000-8000-000000000041'),
        workItemId: FOURTH,
        permissions: stepPermissions,
        policy: DEFAULT_COMPLETION_POLICY,
        instructions: '',
      },
    ],
  };
  expect((await saveRoadmapRequest(state, other, OTHER)).statusCode).toBe(200);
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/roadmaps/${OTHER}/control`,
    headers: mutationHeaders(state),
    payload: { action: 'start', expectedVersion: 1 },
  });
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(
    () =>
      present(state.context.storage.roadmaps.find(state.workspaceId, OTHER)).attempts.some(
        (a) =>
          state.context.storage.execution.runs.liveForWorktree(state.workspaceId, a.worktreeId)
            .length > 0,
      ),
    'the other roadmap running',
  );
  return present(
    state.context.storage.execution.worktrees.find(
      state.workspaceId,
      present(present(state.context.storage.roadmaps.find(state.workspaceId, OTHER)).attempts[0])
        .worktreeId,
    ),
  );
}

/** A member of the workspace with `role`, signed in. */
export function addMember(state: Ready, role: WorkspaceRole): AuthContext {
  const userId = asUserId(`user-${role}`);
  const sessionId = asSessionId(`session-${role}`);
  const now = new Date().toISOString();
  state.context.storage.transaction((tx) => {
    tx.users.insert({
      id: userId,
      username: `${role}-user`,
      usernameNormalized: `${role}-user`,
      passwordHash: '$argon2id$test$c2VlZA',
      occurredAt: now,
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId(randomUUID()),
      workspaceId: state.workspaceId as WorkspaceId,
      userId,
      role,
      occurredAt: now,
    });
    tx.sessions.insert({
      id: sessionId,
      userId,
      tokenDigest: createHash('sha256').update(`token-${role}`).digest('hex'),
      csrfToken: `csrf-${role}`.padEnd(32, 'x'),
      createdAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });
  return {
    user: present(state.context.storage.users.findById(userId)),
    session: present(state.context.storage.sessions.findById(sessionId)),
  };
}
