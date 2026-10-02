import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  asSourceRepositoryId,
  asWorkspaceId,
  asWorkspaceMembershipId,
} from '@craftingtable/domain';
import {
  analyzeConcurrencyArchive,
  inspectPlanArchive,
  readArchive,
} from '@craftingtable/planning';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipFixture } from '../../../packages/planning/src/archive-test-support.js';
import { buildMultipartBody } from './multipart-test-support.js';
import { openDaemonStorage } from './persisted-records.js';
import { createTestContext, type TestContext } from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.cleanup()));
});
const mapName = 'cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip';
const planNames = [
  'wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip',
  'exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip',
];
const fixture = (name: string) =>
  readFileSync(new URL(`../../../fixtures/concurrency/${name}`, import.meta.url));
async function setup() {
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  const workspaceId = context.storage.workspaces.listAuthorized(
    context.storage.users.findByNormalizedUsername('test-user')!.id,
  )[0]!.workspace.id;
  return { context, session, workspaceId };
}
async function upload(
  r: Awaited<ReturnType<typeof setup>>,
  path: string,
  name: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
  bytes: Uint8Array = fixture(name),
) {
  const b = buildMultipartBody({
    fields,
    files: [
      {
        fieldName: 'archive',
        filename: name,
        contentType: 'application/zip',
        bytes,
      },
    ],
  });
  return r.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${r.workspaceId}/${path}`,
    headers: {
      cookie: r.session.cookie,
      origin: r.context.config.publicOrigin,
      'x-craftingtable-csrf': r.session.csrfToken,
      'content-type': b.contentType,
      ...headers,
    },
    payload: b.payload,
  });
}
async function importPlan(
  r: Awaited<ReturnType<typeof setup>>,
  name: string,
  extra: Record<string, string> = {},
) {
  const preview = inspectPlanArchive(fixture(name));
  return upload(r, 'plan-archives/import', name, {
    projectName: name,
    archiveDigest: preview.archiveDigest,
    implementationPlan: preview.implementationPlans[0]!,
    workBreakdown: preview.workBreakdowns[0]!,
    activate: 'false',
    ...extra,
  });
}
describe('package import HTTP flow', () => {
  it('imports full plans and an inactive map, binds exact versions, and never launches work', async () => {
    const r = await setup();
    const repositoryId = asSourceRepositoryId(randomUUID());
    r.context.storage.execution.sourceRepositories.insert({
      id: repositoryId,
      workspaceId: r.workspaceId,
      displayName: 'AQ upstream',
      rootPath: r.context.directory,
      defaultBranch: 'main',
      registeredHeadSha: 'a'.repeat(40),
      registeredAt: new Date().toISOString(),
      registeredByUserId: r.context.storage.users.findByNormalizedUsername('test-user')!.id,
    });
    const versions = [];
    for (const name of planNames) {
      const response = await importPlan(r, name);
      expect(response.statusCode, response.body).toBe(200);
      const data = response.json();
      expect(data.plan.outcome).toBe('succeeded');
      versions.push(data.plan.planVersionId);
      const version = await r.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${r.workspaceId}/projects/${data.plan.projectId}/plan-versions/${data.plan.planVersionId}`,
        headers: { cookie: r.session.cookie },
      });
      expect(version.statusCode, version.body).toBe(200);
      expect(version.json().artifacts.length).toBeGreaterThan(12);
      expect(version.json().archives).toHaveLength(1);
    }
    const imported = await upload(r, 'concurrency-imports', mapName);
    expect(imported.statusCode, imported.body).toBe(200);
    const id = imported.json().attempt.definitionId;
    expect(id).toBeTruthy();
    const detail = await r.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${r.workspaceId}/concurrency-definitions/${id}`,
      headers: { cookie: r.session.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().summary).toMatchObject({
      parentCount: 33,
      sliceCount: 69,
      checkpointCount: 95,
      executable: false,
    });
    expect(
      detail.json().repositories.find((p: { alias: string }) => p.alias === 'aq').issues,
    ).toContainEqual(expect.objectContaining({ code: 'binding-missing', severity: 'error' }));
    for (const alias of ['wi', 'exo'])
      expect(
        detail
          .json()
          .repositories.find((p: { alias: string }) => p.alias === alias)
          .options.some(
            (o: { exactSources: boolean; archiveMatched: boolean }) =>
              o.exactSources && o.archiveMatched,
          ),
      ).toBe(true);
    const saved = await r.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${r.workspaceId}/concurrency-definitions/${id}/bindings`,
      headers: {
        cookie: r.session.cookie,
        origin: r.context.config.publicOrigin,
        'x-craftingtable-csrf': r.session.csrfToken,
      },
      payload: {
        expectedRevision: 0,
        bindings: [
          { alias: 'aq', repositoryId },
          { alias: 'wi', planVersionId: versions[0] },
          { alias: 'exo', planVersionId: versions[1] },
        ],
      },
    });
    const bindingRequest = (expectedRevision: number, planVersionId: string) =>
      r.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${r.workspaceId}/concurrency-definitions/${id}/bindings`,
        headers: {
          cookie: r.session.cookie,
          origin: r.context.config.publicOrigin,
          'x-craftingtable-csrf': r.session.csrfToken,
        },
        payload: { expectedRevision, bindings: [{ alias: 'wi', planVersionId }] },
      });
    expect((await bindingRequest(0, versions[0])).statusCode).toBe(409);
    expect((await bindingRequest(1, versions[1])).statusCode).toBe(409);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().summary.bindingRevision).toBe(1);
    const upstream = saved.json().repositories.find((p: { alias: string }) => p.alias === 'aq');
    expect(upstream.selectedRepositoryId).toBe(repositoryId);
    expect(upstream.issues).toEqual([
      expect.objectContaining({ code: 'baseline-unbound', severity: 'info' }),
    ]);
    expect(saved.json().summary.executable).toBe(false);
    const item = saved.json().repositories.find((p: { alias: string }) => p.alias === 'wi')
      .boundWorkItems[0].workItemId;
    const scopes = await r.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${r.workspaceId}/work-items/${item}/execution-scopes`,
      headers: { cookie: r.session.cookie },
    });
    expect(scopes.statusCode, scopes.body).toBe(200);
    expect(
      scopes
        .json()
        .choices.some((c: { scope: { kind: string } }) => c.scope.kind === 'parent-acceptance'),
    ).toBe(true);
    expect(
      scopes
        .json()
        .choices.every((c: { blockers: string[] }) =>
          c.blockers.some((b) => b.includes('Configure exact upstream pins')),
        ),
    ).toBe(true);
    // PERF-04: one read decodes the definition once, not once per slice × phase.
    const definitionReads = vi.spyOn(r.context.storage.imports, 'definition');
    try {
      const again = await r.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${r.workspaceId}/work-items/${item}/execution-scopes`,
        headers: { cookie: r.session.cookie },
      });
      expect(again.json()).toEqual(scopes.json());
      const perArguments = new Map<string, number>();
      for (const call of definitionReads.mock.calls) {
        const key = JSON.stringify(call);
        perArguments.set(key, (perArguments.get(key) ?? 0) + 1);
      }
      expect(perArguments.size).toBeGreaterThan(0);
      expect(Math.max(...perArguments.values())).toBe(1);
    } finally {
      definitionReads.mockRestore();
    }
    const blocked = await r.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${r.workspaceId}/work-items/${item}/worktrees`,
      headers: {
        cookie: r.session.cookie,
        origin: r.context.config.publicOrigin,
        'x-craftingtable-csrf': r.session.csrfToken,
      },
      payload: { repositoryId, executionScope: scopes.json().choices[0].scope },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.body).toContain('Configure exact upstream pins');
    expect(
      saved.json().repositories.find((p: { alias: string }) => p.alias === 'wi').boundWorkItems,
    ).toHaveLength(14);
    expect(r.context.storage.execution.runs.count()).toBe(0);
    expect(r.context.storage.execution.worktrees.count()).toBe(0);
    expect(r.context.storage.roadmaps.list(r.workspaceId)).toHaveLength(0);
    expect(r.context.storage.planning.workItems.count()).toBe(33);
    const duplicate = await upload(r, 'concurrency-imports', mapName);
    expect(duplicate.json().attempt.outcome).toBe('duplicate');
    expect(r.context.storage.imports.definitions(r.workspaceId)).toHaveLength(1);
    const foreign = await r.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${asWorkspaceId('00000000-0000-4000-8000-000000000001')}/concurrency-definitions/${id}`,
      headers: { cookie: r.session.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    const reopened = openDaemonStorage(r.context.config.databasePath);
    try {
      expect(reopened.imports.bindings(r.workspaceId, id)[0]?.revision).toBe(1);
      expect(reopened.imports.definition(r.workspaceId, id)?.source.slices).toHaveLength(69);
      expect(reopened.imports.attempts(r.workspaceId, 'concurrency')).toHaveLength(2);
    } finally {
      reopened.close();
    }
    r.context.storage.execution.sourceRepositories.retire({
      workspaceId: r.workspaceId,
      repositoryId,
      occurredAt: new Date().toISOString(),
    });
    const retired = await r.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${r.workspaceId}/concurrency-definitions/${id}`,
      headers: { cookie: r.session.cookie },
    });
    expect(
      retired.json().repositories.find((p: { alias: string }) => p.alias === 'aq').issues,
    ).toContainEqual(
      expect.objectContaining({ code: 'repository-unavailable', severity: 'error' }),
    );
    const downloaded = await r.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${r.workspaceId}/import-archives/${imported.json().attempt.archiveId}`,
      headers: { cookie: r.session.cookie },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-disposition']).toContain('attachment');
    expect(downloaded.rawPayload).toEqual(fixture(mapName));
  });
  it('preserves existing project versions and requires explicit active-plan selection', async () => {
    const r = await setup();
    const first = (await importPlan(r, planNames[0]!)).json().plan;
    const second = await importPlan(r, planNames[1]!, {
      projectId: first.projectId,
      activate: 'true',
      expectedActivePlanVersionId: first.planVersionId,
    });
    expect(second.statusCode, second.body).toBe(200);
    const next = second.json().plan;
    expect(next.projectId).toBe(first.projectId);
    expect(next.versionNumber).toBe(2);
    expect(next.isActiveVersion).toBe(true);
    expect(
      r.context.storage.planning.versions.listForProject(r.workspaceId, first.projectId),
    ).toHaveLength(2);
    expect(
      r.context.storage.planning.projects.find(r.workspaceId, first.projectId)?.activePlanVersionId,
    ).toBe(next.planVersionId);
    // A duplicate through Create new project does not authorize changing an existing project.
    const oldDuplicate = await importPlan(r, planNames[0]!, { activate: 'true' });
    expect(oldDuplicate.statusCode, oldDuplicate.body).toBe(200);
    expect(oldDuplicate.json().plan.outcome).toBe('duplicate');
    expect(oldDuplicate.json().plan.isActiveVersion).toBe(false);
    expect(
      r.context.storage.planning.projects.find(r.workspaceId, first.projectId)?.activePlanVersionId,
    ).toBe(next.planVersionId);
  });
  it('keeps a revised import inactive while existing work is admitted', async () => {
    const r = await setup();
    const first = (await importPlan(r, planNames[0]!)).json().plan;
    const item = r.context.storage.planning.workItems.listForVersion(
      r.workspaceId,
      first.planVersionId,
    )[0]!;
    const user = r.context.storage.users.findByNormalizedUsername('test-user')!;
    r.context.storage.planning.workItems.admit({
      workspaceId: r.workspaceId,
      workItemId: item.id,
      admittedAt: new Date().toISOString(),
      admittedByUserId: user.id,
    });
    const unchanged = await importPlan(r, planNames[0]!, {
      projectId: first.projectId,
      activate: 'true',
      expectedActivePlanVersionId: first.planVersionId,
    });
    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().plan.outcome).toBe('duplicate');
    const blocked = await importPlan(r, planNames[1]!, {
      projectId: first.projectId,
      activate: 'true',
      expectedActivePlanVersionId: first.planVersionId,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(
      r.context.storage.planning.versions.listForProject(r.workspaceId, first.projectId),
    ).toHaveLength(1);
    const stored = await importPlan(r, planNames[1]!, {
      projectId: first.projectId,
      activate: 'false',
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json().plan.isActiveVersion).toBe(false);
    expect(
      r.context.storage.planning.projects.find(r.workspaceId, first.projectId)?.activePlanVersionId,
    ).toBe(first.planVersionId);
  });
  it('records rejected archives and rejects different content under the same map revision', async () => {
    const r = await setup();
    const bad = await upload(r, 'concurrency-imports', mapName, {}, {}, Buffer.from('not a zip'));
    expect(bad.statusCode).toBe(200);
    expect(bad.json().attempt.outcome).toBe('failed-validation');
    const first = await upload(r, 'concurrency-imports', mapName);
    const entries = readArchive(fixture(mapName));
    const changed = zipFixture(
      entries.map((entry) => {
        if (!entry.path.endsWith('/cross-stack-concurrency-map.yaml')) return entry;
        const source = analyzeConcurrencyArchive(fixture(mapName)).source;
        const map = { ...source, document: 'Changed title' };
        return { ...entry, bytes: Buffer.from(JSON.stringify(map)) };
      }),
    );
    const conflicting = await upload(r, 'concurrency-imports', mapName, {}, {}, changed);
    expect(conflicting.statusCode, conflicting.body).toBe(200);
    expect(conflicting.json().attempt.outcome).toBe('conflict');
    expect(r.context.storage.imports.definitions(r.workspaceId)).toHaveLength(1);
    expect(r.context.storage.imports.attempts(r.workspaceId, 'concurrency')).toHaveLength(3);
    expect(
      r.context.storage.imports.definition(r.workspaceId, first.json().attempt.definitionId)?.source
        .document,
    ).not.toBe('Changed title');
  });
  it('pins configured branches and reports later changes without rebinding', async () => {
    const r = await setup();
    const plan = (await importPlan(r, planNames[0]!)).json().plan;
    const imported = (await upload(r, 'concurrency-imports', mapName)).json();
    const context = r.context.services.authService.authenticate(r.session.cookie.split('=')[1]);
    const repositoryId = asSourceRepositoryId(randomUUID());
    const now = new Date().toISOString();
    r.context.storage.execution.sourceRepositories.insert({
      id: repositoryId,
      workspaceId: r.workspaceId,
      displayName: 'WI fixture',
      rootPath: r.context.directory,
      defaultBranch: 'main',
      registeredHeadSha: 'a'.repeat(40),
      registeredAt: now,
      registeredByUserId: context.user.id,
    });
    const branch = {
      workspaceId: r.workspaceId,
      planVersionId: plan.planVersionId,
      repositoryId,
      integrationBranch: 'wi-fabric-2',
      updatedAt: now,
      updatedByUserId: context.user.id,
      version: 1,
    };
    r.context.storage.execution.branchSettings.save(branch, 0);
    const definitionId = imported.attempt.definitionId;
    const input = {
      expectedRevision: 0,
      bindings: [{ alias: 'wi', planVersionId: plan.planVersionId }],
    };
    r.context.services.packageImportService.saveBindings(
      context,
      r.workspaceId,
      definitionId,
      input,
    );
    r.context.storage.execution.branchSettings.save(
      { ...branch, integrationBranch: 'revised', version: 2 },
      1,
    );
    const detail = r.context.services.packageImportService.detail(
      context,
      r.workspaceId,
      definitionId,
    );
    expect(
      detail.repositories
        .find((p) => p.alias === 'wi')
        ?.issues.some((i) => i.code === 'branch-binding-stale'),
    ).toBe(true);
    expect(
      r.context.storage.imports.bindings(r.workspaceId, definitionId)[0]?.bindings[0]
        ?.integrationBranch,
    ).toBe('wi-fabric-2');
    r.context.services.packageImportService.saveBindings(context, r.workspaceId, definitionId, {
      ...input,
      expectedRevision: 1,
    });
    expect(
      r.context.storage.imports.bindings(r.workspaceId, definitionId)[0]?.bindings[0]
        ?.integrationBranch,
    ).toBe('revised');
  });
  it('rejects archive mutations for a viewer in an authorized workspace', async () => {
    const r = await setup();
    const context = r.context.services.authService.authenticate(r.session.cookie.split('=')[1]);
    const workspaceId = asWorkspaceId(randomUUID());
    const now = new Date().toISOString();
    r.context.storage.workspaces.insert({
      id: workspaceId,
      name: 'Read only',
      slug: 'read-only',
      createdByUserId: context.user.id,
      occurredAt: now,
    });
    r.context.storage.workspaces.insertMembership({
      id: asWorkspaceMembershipId(randomUUID()),
      workspaceId,
      userId: context.user.id,
      role: 'viewer',
      occurredAt: now,
    });
    const response = await upload({ ...r, workspaceId }, 'concurrency-imports', mapName);
    expect(response.statusCode).toBe(403);
    expect(r.context.storage.imports.attempts(workspaceId, 'concurrency')).toHaveLength(0);
  });
  it('rejects missing CSRF before accepting an archive', async () => {
    const r = await setup();
    expect(
      (await upload(r, 'concurrency-imports', mapName, {}, { 'x-craftingtable-csrf': '' }))
        .statusCode,
    ).toBe(403);
    expect(r.context.storage.imports.attempts(r.workspaceId, 'concurrency')).toHaveLength(0);
  });
});
