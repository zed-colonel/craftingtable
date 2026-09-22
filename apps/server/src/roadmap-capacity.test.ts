import { randomUUID } from 'node:crypto';
import { roadmapCapacitiesSchema } from '@craftingtable/contracts';
import {
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_ROADMAP_AUTOMATION,
  asWorkItemId,
  asWorktreeId,
  asProjectId,
  asPlanVersionId,
  asSourceRepositoryId,
  type Roadmap,
} from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './test-support.js';
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.cleanup();
});
async function fixture() {
  const c = await createTestContext();
  contexts.push(c);
  await c.bootstrap();
  const login = await c.login();
  const auth = c.services.authService.authenticate(login.cookie.split('=').slice(1).join('='));
  const workspaceId = c.storage.workspaces.listAuthorized(auth.user.id)[0]!.workspace.id;
  const at = new Date().toISOString(),
    id = randomUUID(),
    entryId = randomUUID();
  const profile = {
    backend: 'codex' as const,
    model: 'test-model',
    permissionMode: 'auto' as const,
  };
  const profiles = { design: profile, implement: profile, review: profile, remediate: profile };
  const roadmap: Roadmap = {
    id,
    workspaceId,
    version: 1,
    status: 'paused',
    reason: 'Paused by operator',
    createdAt: at,
    updatedAt: at,
    createdByUserId: auth.user.id,
    definition: {
      roadmapId: id,
      revision: 1,
      name: 'Cross-project capacity fixture',
      createdAt: at,
      createdByUserId: auth.user.id,
      scheduling: {
        mode: 'parallel',
        maxInFlight: 4,
        maxPerRepository: 2,
        maxIntegrationRefreshes: 7,
      },
      crossProject: {
        definitionId: randomUUID(),
        bindingRevision: 1,
        targetId: 'ALL',
        selection: 'prioritize-full',
        parentAcceptance: 'manual',
        defaults: {
          profiles,
          policy: DEFAULT_COMPLETION_POLICY,
          instructions: 'Retain',
          automation: DEFAULT_ROADMAP_AUTOMATION,
        },
        overrides: [],
      },
      entries: [
        {
          id: entryId,
          workItemId: asWorkItemId(randomUUID()),
          projectId: asProjectId(randomUUID()),
          planVersionId: asPlanVersionId(randomUUID()),
          repositoryId: asSourceRepositoryId(randomUUID()),
          sourceId: 'EXO-02',
          title: 'Core',
          integrationBranch: 'revision',
          profiles,
          policy: DEFAULT_COMPLETION_POLICY,
          instructions: 'Keep this',
          executionScope: {
            definitionId: randomUUID(),
            bindingRevision: 1,
            kind: 'slice',
            sourceId: 'exo/EXO-02/domain',
          },
        },
      ],
    },
    attempts: [
      {
        id: randomUUID(),
        entryId,
        definitionRevision: 1,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: randomUUID(),
        status: 'active',
        createdAt: at,
      },
    ],
  };
  c.storage.roadmaps.save(roadmap, 0);
  c.storage.roadmaps.addDefinition(roadmap.definition);
  const base = `/api/workspaces/${workspaceId}/roadmaps`;
  const headers = {
    cookie: login.cookie,
    origin: c.config.publicOrigin,
    'x-craftingtable-csrf': login.csrfToken,
  };
  const payload = { expectedVersion: 1, maxInFlight: 2, maxPerRepository: 1 };
  const save = (body = payload) =>
    c.app.inject({ method: 'POST', url: `${base}/${id}/capacity`, headers, payload: body });
  return { c, roadmap, base, headers, save, payload, auth };
}
it('changes only admission ceilings in a new immutable definition without graph evaluation or resuming work', async () => {
  const s = await fixture();
  // This fixture intentionally has no registered Git repositories: capacity reads/saves need none.
  const before = await s.c.app.inject({
    method: 'GET',
    url: `${s.base}/capacities`,
    headers: s.headers,
  });
  const projection = roadmapCapacitiesSchema.parse(before.json()).roadmaps[0]!;
  expect(projection).toMatchObject({
    status: 'paused',
    scheduling: { maxInFlight: 4 },
    inFlight: [{ label: 'EXO-02' }],
  });
  expect((await s.save()).statusCode).toBe(200);
  const saved = s.c.storage.roadmaps.find(s.roadmap.workspaceId, s.roadmap.id)!;
  expect(saved).toMatchObject({
    status: 'paused',
    reason: 'Paused by operator',
    version: 2,
    definition: {
      revision: 2,
      scheduling: {
        mode: 'parallel',
        maxInFlight: 2,
        maxPerRepository: 1,
        maxIntegrationRefreshes: 7,
      },
    },
  });
  expect(saved.attempts).toEqual(s.roadmap.attempts);
  expect(saved.definition.entries).toEqual(s.roadmap.definition.entries);
  expect(saved.definition.crossProject).toEqual(s.roadmap.definition.crossProject);
  expect(s.c.storage.roadmaps.history(saved.workspaceId, saved.id)[1]).toEqual(
    s.roadmap.definition,
  );
  expect((await s.save()).statusCode).toBe(409);
  expect((await s.save({ ...s.payload, expectedVersion: 2 })).statusCode).toBe(200);
  expect(s.c.storage.roadmaps.find(saved.workspaceId, saved.id)?.definition.revision).toBe(2);
});
it('rejects unauthenticated, CSRF-less, invalid, running, and ended capacity edits', async () => {
  const s = await fixture();
  const url = `${s.base}/${s.roadmap.id}/capacity`;
  expect((await s.c.app.inject({ method: 'POST', url, payload: s.payload })).statusCode).toBe(401);
  expect(
    (
      await s.c.app.inject({
        method: 'POST',
        url,
        headers: { cookie: s.headers.cookie },
        payload: s.payload,
      })
    ).statusCode,
  ).toBe(403);
  for (const maxInFlight of [0, 17, 1.2])
    expect((await s.save({ ...s.payload, maxInFlight })).statusCode).toBe(400);
  let version = 1;
  for (const status of ['running', 'completed', 'stopped'] as const) {
    s.c.storage.roadmaps.save({ ...s.roadmap, version: version + 1, status }, version);
    version++;
    expect((await s.save({ ...s.payload, expectedVersion: version })).statusCode).toBe(409);
  }
});
