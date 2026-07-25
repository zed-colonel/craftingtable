import { readFileSync } from 'node:fs';
import {
  admitWorkItemResponseSchema,
  planImportResponseSchema,
  planVersionDetailResponseSchema,
  projectDetailResponseSchema,
  workItemDetailResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import {
  asSessionId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  type WorkspaceId,
  type WorkspaceRole,
} from '@craftingtable/domain';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { buildMultipartBody, type MultipartFilePart } from './multipart-test-support.js';
import { createTestContext, type TestContext } from './test-support.js';

/** CT03-A32, A35 to A40, A48, A51 to A55, A59. */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

const FIXTURE_DIR = new URL('../../../fixtures/plan-bundles/aq-cont-1/', import.meta.url);

function aqFiles(): readonly MultipartFilePart[] {
  const read = (filename: string, fieldName: string, contentType: string) => ({
    fieldName,
    filename,
    contentType,
    bytes: new Uint8Array(readFileSync(new URL(filename, FIXTURE_DIR))),
  });
  return [
    read('aq-cont-1-implementation-plan.md', 'implementation-plan', 'text/markdown'),
    read('aq-cont-1-work-breakdown.yaml', 'work-breakdown', 'application/yaml'),
    read('aq-cont-1-planning-package-README.md', 'supporting', 'text/markdown'),
  ];
}

async function importedWorkspace() {
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  const workspaceId = context.storage.workspaces
    .listAuthorized(
      context.storage.users.findByNormalizedUsername('test-user')?.id ?? ('' as never),
    )
    .at(0)?.workspace.id as WorkspaceId;

  const body = buildMultipartBody({
    fields: { projectName: 'ActionQueue — AQ-CONT-1' },
    files: aqFiles(),
  });
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${workspaceId}/plan-imports`,
    headers: {
      cookie: session.cookie,
      origin: context.config.publicOrigin,
      [CSRF_HEADER_NAME]: session.csrfToken,
      'content-type': body.contentType,
    },
    payload: body.payload,
  });
  const imported = planImportResponseSchema.parse(response.json());
  if (imported.outcome !== 'succeeded') {
    throw new Error(`Import failed: ${JSON.stringify(imported)}`);
  }
  return { context, session, workspaceId, imported };
}

/**
 * Adds a second user with the given role, plus a real session.
 *
 * The session must be a real row: audit records carry a session foreign key, so
 * a fabricated identity is rejected by the database rather than silently
 * attributed.
 */
function addMember(context: TestContext, workspaceId: WorkspaceId, role: WorkspaceRole) {
  const userId = asUserId(`user-${role}`);
  const sessionId = asSessionId(`session-${role}`);
  const now = new Date().toISOString();
  context.storage.transaction((tx) => {
    tx.users.insert({
      id: userId,
      username: `${role}-user`,
      usernameNormalized: `${role}-user`,
      passwordHash: '$argon2id$test$c2VlZA',
      occurredAt: now,
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId(randomUUID()),
      workspaceId,
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
  const user = context.storage.users.findById(userId);
  const session = context.storage.sessions.findById(sessionId);
  if (user === undefined || session === undefined) {
    throw new Error('Failed to seed the member');
  }
  return { userId, context: { user, session } as never };
}

/** Creates an isolated second workspace owned by a different user. */
function foreignWorkspace(context: TestContext) {
  const userId = asUserId('outsider');
  const workspaceId = asWorkspaceId('workspace-outsider');
  context.storage.transaction((tx) => {
    tx.users.insert({
      id: userId,
      username: 'outsider',
      usernameNormalized: 'outsider',
      passwordHash: '$argon2id$test$c2VlZA',
      occurredAt: new Date().toISOString(),
    });
    tx.workspaces.insert({
      id: workspaceId,
      name: 'Outsider workspace',
      slug: 'outsider',
      createdByUserId: userId,
      occurredAt: new Date().toISOString(),
    });
    tx.workspaces.insertMembership({
      id: asWorkspaceMembershipId(randomUUID()),
      workspaceId,
      userId,
      role: 'owner',
      occurredAt: new Date().toISOString(),
    });
  });
  return { userId, workspaceId };
}

describe('planning queries over HTTP', () => {
  it('reports the AQ risk, readiness, and blocker summary (CT03-A51, A52)', async () => {
    const ready = await importedWorkspace();
    const response = await ready.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}`,
      headers: { cookie: ready.session.cookie },
    });
    const detail = projectDetailResponseSchema.parse(response.json());

    expect(detail.project.riskCounts).toEqual({
      low: 0,
      medium: 1,
      high: 7,
      critical: 6,
      unspecified: 0,
    });
    expect(detail.project.planningReadyCount).toBe(1);
    expect(detail.project.dependencyBlockedCount).toBe(13);
    expect(detail.project.proposedCount).toBe(14);
    expect(detail.project.admittedCount).toBe(0);
    expect(detail.versions).toHaveLength(1);

    const active = detail.activeVersion;
    if (active === null) {
      throw new Error('Expected an active version');
    }
    expect(active.workItems).toHaveLength(14);
    const ready_ = active.workItems.filter((item) => item.readiness === 'planning-ready');
    expect(ready_.map((item) => item.sourceId)).toEqual(['AQ-01']);
    const blocked = active.workItems.filter((item) => item.readiness === 'dependency-blocked');
    expect(blocked).toHaveLength(13);
    for (const item of blocked) {
      expect(item.blockerSourceIds.length).toBeGreaterThan(0);
    }
    expect(
      active.workItems.find((item) => item.sourceId === 'AQ-12')?.requiredPredecessorCount,
    ).toBe(8);
    expect(active.artifacts).toHaveLength(3);
  });

  it('exposes the same summary through the workspace snapshot (CT03-A48)', async () => {
    const ready = await importedWorkspace();
    const response = await ready.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ready.workspaceId}/snapshot`,
      headers: { cookie: ready.session.cookie },
    });
    const snapshot = workspaceSnapshotResponseSchema.parse(response.json());
    expect(snapshot.statusSummary).toEqual({
      needsAttention: 0,
      active: 0,
      planningReady: 1,
      dependencyBlocked: 13,
    });
    expect(snapshot.planningSummary.riskCounts).toEqual({
      low: 0,
      medium: 1,
      high: 7,
      critical: 6,
      unspecified: 0,
    });
    expect(snapshot.projects).toHaveLength(1);
    // Counts and the cursor come from one read transaction.
    expect(snapshot.asOfSequence).toBe(ready.context.storage.workspaceEvents.maxSequence());
  });

  it('serves a work item with its dependencies and blockers (CT03-A62)', async () => {
    const ready = await importedWorkspace();
    const project = projectDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const aq08 = project.activeVersion?.workItems.find((item) => item.sourceId === 'AQ-08');
    if (aq08 === undefined) {
      throw new Error('AQ-08 missing');
    }
    const detail = workItemDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/work-items/${aq08.id}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    expect(detail.workItem.sourceId).toBe('AQ-08');
    expect(detail.workItem.risk).toBe('critical');
    expect(detail.workItem.readiness).toBe('dependency-blocked');
    expect(detail.requiredPredecessors.map((entry) => entry.sourceId).toSorted()).toEqual([
      'AQ-04',
      'AQ-06',
      'AQ-07',
    ]);
    expect(detail.recommendedPredecessors).toEqual([]);
    expect(detail.dependents.map((entry) => entry.sourceId).toSorted()).toEqual([
      'AQ-09',
      'AQ-10',
      'AQ-11',
      'AQ-12',
    ]);
    expect(detail.draft).toBeNull();
    expect(detail.projectName).toBe('ActionQueue — AQ-CONT-1');
  });

  it('serves the plan version detail for the active version (CT03-A32)', async () => {
    const ready = await importedWorkspace();
    const detail = planVersionDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}/plan-versions/${ready.imported.planVersionId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    expect(detail.version.versionNumber).toBe(1);
    expect(detail.version.isActive).toBe(true);
    expect(detail.version.itemCount).toBe(14);
    expect(detail.version.requiredDependencyCount).toBe(24);
    expect(detail.version.sourceProfile).toBe('exo-work-breakdown-v1');
    expect(detail.version.digestFormatVersion).toBe(1);
    expect(detail.workItems).toHaveLength(14);
  });

  it('serves raw source bytes with safe headers (CT03-A40)', async () => {
    const ready = await importedWorkspace();
    const detail = planVersionDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}/plan-versions/${ready.imported.planVersionId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const yaml = detail.artifacts.find((artifact) => artifact.role === 'work-breakdown');
    if (yaml === undefined) {
      throw new Error('work-breakdown artifact missing');
    }
    const response = await ready.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ready.workspaceId}/plan-artifacts/${yaml.id}`,
      headers: { cookie: ready.session.cookie },
    });
    expect(response.statusCode).toBe(200);
    // Never the stored media type, and never renderable as HTML.
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="aq-cont-1-work-breakdown.yaml"',
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe(
      readFileSync(new URL('aq-cont-1-work-breakdown.yaml', FIXTURE_DIR), 'utf8'),
    );
  });

  it('hides every planning resource from another workspace (CT03-A35, A39)', async () => {
    const ready = await importedWorkspace();
    const outsider = foreignWorkspace(ready.context);
    const detail = planVersionDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}/plan-versions/${ready.imported.planVersionId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const artifactId = detail.artifacts[0]?.id;
    const workItemId = detail.workItems[0]?.id;

    // Same authenticated user, other workspace: membership is missing, so every
    // route answers with the same 404 a missing resource would.
    for (const url of [
      `/api/workspaces/${outsider.workspaceId}/projects`,
      `/api/workspaces/${outsider.workspaceId}/projects/${ready.imported.projectId}`,
      `/api/workspaces/${outsider.workspaceId}/work-items/${workItemId}`,
      `/api/workspaces/${outsider.workspaceId}/plan-artifacts/${artifactId}`,
      `/api/workspaces/${outsider.workspaceId}/plan-imports`,
    ]) {
      const response = await ready.context.app.inject({
        method: 'GET',
        url,
        headers: { cookie: ready.session.cookie },
      });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'not-found', message: 'Resource not found' },
      });
    }
  });

  it('returns 404 for unknown ids inside an authorized workspace', async () => {
    const ready = await importedWorkspace();
    for (const url of [
      `/api/workspaces/${ready.workspaceId}/projects/project-does-not-exist`,
      `/api/workspaces/${ready.workspaceId}/work-items/item-does-not-exist`,
      `/api/workspaces/${ready.workspaceId}/plan-artifacts/artifact-does-not-exist`,
      `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}/plan-versions/version-does-not-exist`,
    ]) {
      const response = await ready.context.app.inject({
        method: 'GET',
        url,
        headers: { cookie: ready.session.cookie },
      });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('lets a Viewer read but not import or admit (CT03-A36)', async () => {
    const ready = await importedWorkspace();
    const viewer = addMember(ready.context, ready.workspaceId, 'viewer');
    const viewerService = ready.context.services.planningQueryService;
    const viewerContext = viewer.context;

    // Reads succeed for a Viewer.
    expect(viewerService.listProjects(viewerContext, ready.workspaceId).projects).toHaveLength(1);

    // Mutations are refused at the service layer, before any write.
    expect(() =>
      ready.context.services.workItemService.admit(
        viewerContext,
        ready.workspaceId,
        'anything' as never,
      ),
    ).toThrow(/forbidden/i);
    expect(() =>
      ready.context.services.planImportService.import(viewerContext, {
        workspaceId: ready.workspaceId,
        projectName: 'Viewer attempt',
        bundle: { artifacts: [] },
      }),
    ).toThrow(/forbidden/i);
    expect(ready.context.storage.planning.importAttempts.count()).toBe(1);
  });

  it('lets an Editor import and admit (CT03-A37)', async () => {
    const ready = await importedWorkspace();
    const editorContext = addMember(ready.context, ready.workspaceId, 'editor').context;

    const project = projectDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const aq01 = project.activeVersion?.workItems.find((item) => item.sourceId === 'AQ-01');
    if (aq01 === undefined) {
      throw new Error('AQ-01 missing');
    }
    const result = ready.context.services.workItemService.admit(
      editorContext,
      ready.workspaceId,
      aq01.id,
    );
    expect(result.admitted).toBe(true);
    expect(result.workItem.status).toBe('admitted');
  });
});

describe('work-item admission over HTTP', () => {
  async function admitAq01(ready: Awaited<ReturnType<typeof importedWorkspace>>) {
    const project = projectDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const aq01 = project.activeVersion?.workItems.find((item) => item.sourceId === 'AQ-01');
    if (aq01 === undefined) {
      throw new Error('AQ-01 missing');
    }
    const response = await ready.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ready.workspaceId}/work-items/${aq01.id}/admit`,
      headers: {
        cookie: ready.session.cookie,
        origin: ready.context.config.publicOrigin,
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });
    return { response, workItemId: aq01.id };
  }

  it('admits exactly one item and creates one incomplete draft (CT03-A53, A56, A58)', async () => {
    const ready = await importedWorkspace();
    const { response, workItemId } = await admitAq01(ready);
    expect(response.statusCode).toBe(200);

    const parsed = admitWorkItemResponseSchema.parse(response.json());
    expect(parsed.admitted).toBe(true);
    expect(parsed.status).toBe('admitted');
    expect(parsed.draft.status).toBe('draft');
    expect(parsed.draft.completeness).toBe('incomplete');
    expect(parsed.draft.schemaVersion).toBe(1);

    const document = parsed.draft.document as Record<string, unknown>;
    expect(document.missing).toEqual([
      'registered-repository',
      'exact-base-revision',
      'path-scope',
      'verification-policy',
      'protected-acceptance-criteria',
      'agent-backend',
      'execution-environment',
    ]);
    expect(document.merge).toEqual({ humanAuthorizationRequired: true });
    expect((document.objective as { title: string }).title).toBe(
      'Freeze evidence and establish the development contract',
    );
    // Nothing in the draft may read as authorization (CT03-I11).
    expect(Object.keys(document)).not.toContain('approved');
    expect(Object.keys(document)).not.toContain('executable');

    const storage = ready.context.storage;
    expect(storage.planning.drafts.count()).toBe(1);
    expect(
      storage.planning.workItems.find(ready.workspaceId, workItemId)?.admittedByUserId,
    ).toBeDefined();
    expect(
      storage.planning.workItems
        .listForVersion(ready.workspaceId, ready.imported.planVersionId)
        .filter((item) => item.status === 'admitted'),
    ).toHaveLength(1);

    const audit = storage.audit.listWorkspace({ workspaceId: ready.workspaceId, limit: 50 });
    expect(audit.filter((row) => row.action === 'work-item.admitted')).toHaveLength(1);
    expect(audit.filter((row) => row.action === 'work-contract-draft.created')).toHaveLength(1);
  });

  it('is idempotent and duplicates no audit, event, or draft row (CT03-A54)', async () => {
    const ready = await importedWorkspace();
    await admitAq01(ready);
    const storage = ready.context.storage;
    const afterFirst = {
      drafts: storage.planning.drafts.count(),
      audit: storage.audit.count(),
      events: storage.workspaceEvents.count(),
    };

    const { response } = await admitAq01(ready);
    const repeat = admitWorkItemResponseSchema.parse(response.json());
    expect(repeat.admitted).toBe(false);
    expect(repeat.status).toBe('admitted');
    expect(storage.planning.drafts.count()).toBe(afterFirst.drafts);
    expect(storage.audit.count()).toBe(afterFirst.audit);
    expect(storage.workspaceEvents.count()).toBe(afterFirst.events);
  });

  it('admits a dependency-blocked item and keeps its blockers visible (CT03-A55)', async () => {
    const ready = await importedWorkspace();
    const project = projectDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const aq14 = project.activeVersion?.workItems.find((item) => item.sourceId === 'AQ-14');
    if (aq14 === undefined) {
      throw new Error('AQ-14 missing');
    }
    expect(aq14.readiness).toBe('dependency-blocked');

    const response = await ready.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ready.workspaceId}/work-items/${aq14.id}/admit`,
      headers: {
        cookie: ready.session.cookie,
        origin: ready.context.config.publicOrigin,
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    const detail = workItemDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/work-items/${aq14.id}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    // Admission accepts into the agenda; it does not satisfy a dependency.
    expect(detail.workItem.status).toBe('admitted');
    expect(detail.workItem.readiness).toBe('active');
    expect(detail.workItem.blockerSourceIds).toEqual(['AQ-13']);
    const draftDocument = detail.draft?.document as Record<string, unknown>;
    expect(
      (draftDocument.dependencies as { required: { sourceId: string }[] }).required.map(
        (entry) => entry.sourceId,
      ),
    ).toEqual(['AQ-13']);
  });

  it('rejects admission without CSRF, origin, or authentication (CT03-A38)', async () => {
    const ready = await importedWorkspace();
    const project = projectDetailResponseSchema.parse(
      (
        await ready.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${ready.workspaceId}/projects/${ready.imported.projectId}`,
          headers: { cookie: ready.session.cookie },
        })
      ).json(),
    );
    const aq01 = project.activeVersion?.workItems.find((item) => item.sourceId === 'AQ-01');
    const url = `/api/workspaces/${ready.workspaceId}/work-items/${aq01?.id}/admit`;

    const noCsrf = await ready.context.app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: ready.session.cookie,
        origin: ready.context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);

    const crossSite = await ready.context.app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: ready.session.cookie,
        origin: 'http://evil.example',
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(crossSite.statusCode).toBe(403);

    const anonymous = await ready.context.app.inject({
      method: 'POST',
      url,
      headers: {
        origin: ready.context.config.publicOrigin,
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);

    expect(ready.context.storage.planning.drafts.count()).toBe(0);
  });
});
