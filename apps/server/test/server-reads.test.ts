import { randomUUID } from 'node:crypto';
import {
  daemonDiagnosticsResponseSchema,
  runEventPageResponseSchema,
  workCyclesResponseSchema,
  workspaceRunsResponseSchema,
} from '@craftingtable/contracts';
import {
  type AgentRunId,
  asAgentRunEventId,
  asAgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asSourceRepositoryId,
  asUserId,
  asWorkItemId,
  asWorkspaceMembershipId,
  asWorktreeId,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/config.js';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * Read-path payloads (R-D1) and read-cost instrumentation (R-D3).
 *
 * The browser used to download every historical cycle, every run's outcome
 * text and every retained vendor line on each refresh. These tests pin the
 * slimmer shapes at the HTTP seam.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

const at = '2026-09-20T10:00:00.000Z';
const profile = { backend: 'claude-code' as const, permissionMode: 'auto' as const };

async function fixture() {
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  const user = context.storage.users.findByNormalizedUsername('test-user');
  if (!user) throw new Error('Missing user');
  const workspaceId = context.storage.workspaces.listAuthorized(user.id)[0]?.workspace.id;
  if (!workspaceId) throw new Error('Missing workspace');
  const projectId = asProjectId('project-1');
  const planVersionId = asPlanVersionId('plan-1');
  const repositoryId = asSourceRepositoryId('repo-1');
  const items = [asWorkItemId('item-1'), asWorkItemId('item-2')] as const;
  const trees = [asWorktreeId('tree-1'), asWorktreeId('tree-2')] as const;
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId,
      name: 'ActionQueue',
      slug: 'aq',
      createdAt: at,
      createdByUserId: user.id,
    });
    tx.planning.bundles.insert({
      id: asPlanBundleId('bundle-1'),
      workspaceId,
      projectId,
      logicalName: 'aq',
      createdAt: at,
    });
    tx.planning.versions.insert({
      id: planVersionId,
      workspaceId,
      projectId,
      bundleId: asPlanBundleId('bundle-1'),
      versionNumber: 1,
      contentDigest: 'e'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: {},
      itemCount: 2,
      requiredDependencyCount: 0,
      createdAt: at,
      createdByUserId: user.id,
    });
    tx.planning.workItems.insertMany(
      items.map((id, ordinal) => ({
        id,
        workspaceId,
        projectId,
        planVersionId,
        sourceId: `AQ-0${ordinal + 1}`,
        ordinal,
        title: `Item ${ordinal + 1}`,
        risk: 'low' as const,
        primaryAreas: [],
        exitGate: 'Checks pass',
        sourceFields: {},
      })),
    );
    tx.execution.sourceRepositories.insert({
      id: repositoryId,
      workspaceId,
      displayName: 'AQ',
      rootPath: '/tmp/aq-reads-fixture',
      defaultBranch: 'main',
      registeredHeadSha: 'a'.repeat(40),
      registeredAt: at,
      registeredByUserId: user.id,
    });
    for (const [index, id] of trees.entries()) {
      tx.execution.worktrees.insert({
        id,
        workspaceId,
        repositoryId,
        projectId,
        workItemId: items[index as 0 | 1],
        branchName: `ct/aq-0${index + 1}`,
        baseSha: 'a'.repeat(40),
        baseBranch: 'main',
        integrationBranch: 'main',
        path: `/tmp/aq-reads-tree-${index}`,
        createdAt: at,
        createdByUserId: user.id,
      });
    }
  });

  const run = (
    id: string,
    tree: 0 | 1,
    status: 'running' | 'finished',
    outcomeSummary?: string,
  ): AgentRunId => {
    const runId = asAgentRunId(id);
    context.storage.execution.runs.insert({
      id: runId,
      workspaceId,
      worktreeId: trees[tree],
      repositoryId,
      projectId,
      workItemId: items[tree],
      backend: 'claude-code',
      role: 'implement',
      permissionMode: 'auto',
      brief: 'Fixture brief',
      createdAt: at,
      createdByUserId: user.id,
    });
    context.storage.execution.runs.transition({
      workspaceId,
      runId,
      expectedStatuses: ['starting'],
      toStatus: status,
      occurredAt: at,
      ...(outcomeSummary === undefined ? {} : { outcomeSummary }),
    });
    return runId;
  };
  const finishedRun = run('run-finished', 0, 'finished', 'A long outcome the list never shows.');
  const liveRun = run('run-live', 1, 'running');

  const cycle = (
    tree: 0 | 1,
    status: WorkCycle['status'],
    currentRunId: AgentRunId,
    extra: Partial<WorkCycle> = {},
  ): WorkCycle => {
    const value: WorkCycle = {
      id: randomUUID(),
      workspaceId,
      projectId,
      workItemId: items[tree],
      worktreeId: trees[tree],
      workItemSourceId: `AQ-0${tree + 1}`,
      workItemTitle: `Item ${tree + 1}`,
      createdByUserId: user.id,
      createdAt: at,
      updatedAt: at,
      version: 1,
      status,
      step: 'design',
      policy: DEFAULT_COMPLETION_POLICY,
      profiles: { design: profile, implement: profile, review: profile, remediate: profile },
      instructions: '',
      currentRunId,
      runDeadlineAt: at,
      remediationRounds: 0,
      stalledReviews: 0,
      reason: `Cycle ${status}`,
      ...extra,
    };
    context.storage.execution.cycles.insert(value);
    return value;
  };
  const designRecovery = {
    runId: finishedRun,
    sourceRunId: finishedRun,
    mode: 'investigate' as const,
    profile: { backend: 'claude-code' as const },
    instructions: 'Investigate the design question.',
    snapshotDigest: 'f'.repeat(64),
    facts: 'x'.repeat(4000),
    sources: [],
    attachments: [],
  };
  const history = cycle(0, 'completed', finishedRun, { designRecovery });
  const paused = cycle(0, 'paused', finishedRun, { designRecovery });
  const live = cycle(1, 'running', liveRun);

  return {
    context,
    session,
    workspaceId,
    user,
    items,
    trees,
    repositoryId,
    projectId,
    finishedRun,
    liveRun,
    cycles: { history, paused, live },
    get: (url: string, cookie = session.cookie) =>
      context.app.inject({ method: 'GET', url, headers: { cookie } }),
  };
}

/** Signs in a second user who is a member of the workspace with `role`. */
async function memberSession(
  f: Awaited<ReturnType<typeof fixture>>,
  role: 'editor' | 'viewer',
): Promise<string> {
  const username = `${role}-user`;
  const password = 'another correct horse battery';
  const userId = asUserId(`${role}-id`);
  f.context.storage.users.insert({
    id: userId,
    username,
    usernameNormalized: username,
    passwordHash: `$argon2id$test$${Buffer.from(password).toString('base64url')}`,
    occurredAt: at,
  });
  f.context.storage.workspaces.insertMembership({
    id: asWorkspaceMembershipId(`${role}-membership`),
    workspaceId: f.workspaceId,
    userId,
    role,
    occurredAt: at,
  });
  const response = await f.context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: f.context.config.publicOrigin, 'content-type': 'application/json' },
    payload: { username, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
  if (!cookie?.startsWith(`${SESSION_COOKIE_NAME}=`)) throw new Error('No session cookie');
  return cookie;
}

describe('cycle reads (PERF-05)', () => {
  it('lists only cycles that have not ended, without design-recovery detail, by default', async () => {
    const f = await fixture();
    const response = await f.get(`/api/workspaces/${f.workspaceId}/cycles`);
    expect(response.statusCode, response.body).toBe(200);
    const { cycles } = workCyclesResponseSchema.parse(response.json());
    expect(cycles.map((c) => c.id).toSorted()).toEqual(
      [f.cycles.paused.id, f.cycles.live.id].toSorted(),
    );
    expect(cycles.every((c) => c.designRecovery === undefined)).toBe(true);
    expect(response.body).not.toContain('Investigate the design question.');
  });

  it('returns one work item’s full cycles, history and design recovery included', async () => {
    const f = await fixture();
    const response = await f.get(
      `/api/workspaces/${f.workspaceId}/cycles?workItemId=${encodeURIComponent(f.items[0])}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const { cycles } = workCyclesResponseSchema.parse(response.json());
    expect(cycles.map((c) => c.id).toSorted()).toEqual(
      [f.cycles.history.id, f.cycles.paused.id].toSorted(),
    );
    expect(cycles.every((c) => c.designRecovery?.instructions)).toBe(true);
    // The completed cycle is history: it still says which agents would run next.
    expect(cycles.find((c) => c.id === f.cycles.history.id)?.nextAgentSelections).toBeDefined();
  });

  it('rejects a malformed work item filter', async () => {
    const f = await fixture();
    const response = await f.get(`/api/workspaces/${f.workspaceId}/cycles?workItemId=%20x`);
    expect(response.statusCode).toBe(400);
  });
});

describe('worktree lineage reads (R-C16)', () => {
  it("leaves a question stop's investigation out of the worktree's lineage, but not its live runs", async () => {
    const f = await fixture();
    const runs = f.context.storage.execution.runs;
    const investigation = asAgentRunId('run-investigation');
    runs.insert({
      id: investigation,
      workspaceId: f.workspaceId,
      worktreeId: f.trees[0],
      repositoryId: f.repositoryId,
      projectId: f.projectId,
      workItemId: f.items[0],
      backend: 'claude-code',
      role: 'design',
      permissionMode: 'auto',
      profileSelection: { purpose: 'investigation', investigationId: randomUUID() },
      brief: 'Investigate the stop',
      createdAt: '2026-09-20T11:00:00.000Z',
      createdByUserId: f.user.id,
    });
    runs.transition({
      workspaceId: f.workspaceId,
      runId: investigation,
      expectedStatuses: ['starting'],
      toStatus: 'running',
      occurredAt: '2026-09-20T11:00:00.000Z',
    });
    const ids = (list: readonly { id: string }[]) => list.map((r) => r.id);
    // The newest run on the worktree is the investigation; the lineage reads skip it.
    expect(ids(runs.listForWorktree(f.workspaceId, f.trees[0]))).toEqual([f.finishedRun]);
    expect(runs.latestIdForWorktree(f.workspaceId, f.trees[0])).toBe(f.finishedRun);
    expect(ids(runs.listForWorktree(f.workspaceId, f.trees[0], { investigations: true }))).toEqual([
      investigation,
      f.finishedRun,
    ]);
    // It still holds the worktree while it is live.
    expect(ids(runs.liveForWorktree(f.workspaceId, f.trees[0]))).toEqual([investigation]);
    runs.transition({
      workspaceId: f.workspaceId,
      runId: investigation,
      expectedStatuses: ['running'],
      toStatus: 'finished',
      occurredAt: '2026-09-20T11:05:00.000Z',
    });
    expect(runs.liveForWorktree(f.workspaceId, f.trees[0])).toEqual([]);
    // The cycle's own investigation-purpose runs (a design recovery's, a reassessment) carry
    // no investigation id and stay in the lineage.
    const recovery = asAgentRunId('run-design-recovery');
    runs.insert({
      id: recovery,
      workspaceId: f.workspaceId,
      worktreeId: f.trees[1],
      repositoryId: f.repositoryId,
      projectId: f.projectId,
      workItemId: f.items[1],
      backend: 'claude-code',
      role: 'design',
      permissionMode: 'auto',
      profileSelection: { purpose: 'investigation' },
      brief: 'Investigate the design questions',
      createdAt: '2026-09-20T11:00:00.000Z',
      createdByUserId: f.user.id,
    });
    expect(runs.latestIdForWorktree(f.workspaceId, f.trees[1])).toBe(recovery);
    expect(ids(runs.listForWorktree(f.workspaceId, f.trees[1]))).toEqual([recovery, f.liveRun]);
  });
});

describe('run list reads (PERF-12)', () => {
  it('omits the outcome summary from list rows and keeps it on the run detail', async () => {
    const f = await fixture();
    const list = await f.get(`/api/workspaces/${f.workspaceId}/runs`);
    expect(list.statusCode, list.body).toBe(200);
    const { runs } = workspaceRunsResponseSchema.parse(list.json());
    expect(runs.map((run) => run.id).toSorted()).toEqual([f.finishedRun, f.liveRun].toSorted());
    expect(runs.every((run) => run.outcomeSummary === undefined)).toBe(true);
    const detail = await f.get(`/api/workspaces/${f.workspaceId}/runs/${f.finishedRun}`);
    expect(detail.json().run.outcomeSummary).toBe('A long outcome the list never shows.');
  });

  it('filters to live runs for the dashboard and rejects unknown filters', async () => {
    const f = await fixture();
    const live = await f.get(`/api/workspaces/${f.workspaceId}/runs?status=live`);
    const parsed = workspaceRunsResponseSchema.parse(live.json());
    expect(parsed.runs.map((run) => run.id)).toEqual([f.liveRun]);
    expect(parsed.liveCount).toBe(1);
    expect((await f.get(`/api/workspaces/${f.workspaceId}/runs?status=failed`)).statusCode).toBe(
      400,
    );
  });
});

describe('run event reads (PERF-11, AGT-03, DATA-01)', () => {
  it('omits the retained vendor line unless diagnostics explicitly ask for it', async () => {
    const f = await fixture();
    f.context.storage.execution.runEvents.append({
      id: asAgentRunEventId(randomUUID()),
      workspaceId: f.workspaceId,
      runId: f.finishedRun,
      occurredAt: at,
      kind: 'assistant-message',
      payload: { text: 'Visible text' },
      raw: '{"vendor":"raw line"}',
    });
    const base = `/api/workspaces/${f.workspaceId}/runs/${f.finishedRun}/event-page`;
    const page = runEventPageResponseSchema.parse((await f.get(base)).json());
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).not.toHaveProperty('raw');
    const diagnostic = runEventPageResponseSchema.parse(
      (await f.get(`${base}?includeRaw=true`)).json(),
    );
    expect(diagnostic.events[0]?.raw).toBe('{"vendor":"raw line"}');
    expect((await f.get(`${base}?includeRaw=yes`)).statusCode).toBe(400);
  });
});

describe('daemon diagnostics (R-D3)', () => {
  it('reports route timings and event-loop delay to the workspace owner only', async () => {
    const f = await fixture();
    await f.get(`/api/workspaces/${f.workspaceId}/cycles`);
    await f.get(`/api/workspaces/${f.workspaceId}/cycles?workItemId=${f.items[0]}`);
    const response = await f.get(`/api/workspaces/${f.workspaceId}/diagnostics`);
    expect(response.statusCode, response.body).toBe(200);
    const diagnostics = daemonDiagnosticsResponseSchema.parse(response.json());
    const cycles = diagnostics.routes.find(
      (route) => route.method === 'GET' && route.route === '/api/workspaces/:workspaceId/cycles',
    );
    // Both requests share the route pattern, not their concrete URLs.
    expect(cycles?.count).toBe(2);
    expect(cycles?.maxBytes).toBeGreaterThan(0);
    expect(diagnostics.eventLoopDelay.sinceStart.windowMs).toBeGreaterThan(0);

    const editor = await memberSession(f, 'editor');
    expect((await f.get(`/api/workspaces/${f.workspaceId}/diagnostics`, editor)).statusCode).toBe(
      403,
    );
    expect(
      (
        await f.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${f.workspaceId}/diagnostics`,
        })
      ).statusCode,
    ).toBe(401);
  });

  it('logs one completion line per request with route, status, duration and bytes', async () => {
    const lines: string[] = [];
    const context = await createTestContext({
      loggerStream: { write: (line) => lines.push(line) },
      env: { CRAFTINGTABLE_LOG_LEVEL: 'info' },
    });
    contexts.push(context);
    await context.app.inject({ method: 'GET', url: '/api/health' });
    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'request completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      route: '/api/health',
      res: { statusCode: 200 },
      bytes: expect.any(Number),
      responseTime: expect.any(Number),
    });
  });
});

describe('non-owner members (PERF-15)', () => {
  it('can read every workspace-level query the pages load, but not the owner-only audit', async () => {
    const f = await fixture();
    const editor = await memberSession(f, 'editor');
    for (const path of ['snapshot', 'cycles', 'runs', 'runs?status=live', 'work-items']) {
      const response = await f.get(`/api/workspaces/${f.workspaceId}/${path}`, editor);
      expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
    }
    expect((await f.get('/api/workspaces', editor)).statusCode).toBe(200);
    expect((await f.get(`/api/workspaces/${f.workspaceId}/audit`, editor)).statusCode).toBe(403);
  });
});
