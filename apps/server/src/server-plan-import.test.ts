import { readFileSync } from 'node:fs';
import { planImportResponseSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { buildMultipartBody, type MultipartFilePart } from './multipart-test-support.js';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * CT03-A28 to A30, A38, A41, A42: the import vertical over real HTTP.
 *
 * Bodies are hand-built multipart bytes so the tests exercise the same
 * transport a browser uses.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

const FIXTURE_DIR = new URL('../../../fixtures/plan-bundles/', import.meta.url);

function aqFile(filename: string, fieldName: string, contentType: string): MultipartFilePart {
  return {
    fieldName,
    filename,
    contentType,
    bytes: new Uint8Array(readFileSync(new URL(`aq-cont-1/${filename}`, FIXTURE_DIR))),
  };
}

function aqFiles(): readonly MultipartFilePart[] {
  return [
    aqFile('aq-cont-1-implementation-plan.md', 'implementation-plan', 'text/markdown'),
    aqFile('aq-cont-1-work-breakdown.yaml', 'work-breakdown', 'application/yaml'),
    aqFile(
      'aq-cont-1-implementation-plan.sha256',
      'validation-manifest',
      'application/octet-stream',
    ),
    aqFile('aq-cont-1-planning-package-README.md', 'supporting', 'text/markdown'),
    aqFile('constitutional-stack-implementation-contracts.yaml', 'supporting', 'application/yaml'),
  ];
}

function invalidFile(filename: string, fieldName = 'work-breakdown'): MultipartFilePart {
  return {
    fieldName,
    filename: filename.replace(/[^A-Za-z0-9._-]/g, '-'),
    contentType: 'application/yaml',
    bytes: new Uint8Array(readFileSync(new URL(`invalid/${filename}`, FIXTURE_DIR))),
  };
}

const MINIMAL_PLAN: MultipartFilePart = {
  fieldName: 'implementation-plan',
  filename: 'plan.md',
  contentType: 'text/markdown',
  bytes: new TextEncoder().encode('# Plan\n'),
};

async function signedIn(options: Parameters<typeof createTestContext>[0] = {}) {
  const context = await createTestContext(options);
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  const workspaceId = context.storage.workspaces
    .listAuthorized(
      context.storage.users.findByNormalizedUsername('test-user')?.id ?? ('' as never),
    )
    .at(0)?.workspace.id as WorkspaceId;
  return { context, session, workspaceId };
}

async function postImport(
  ready: Awaited<ReturnType<typeof signedIn>>,
  options: {
    readonly files?: readonly MultipartFilePart[];
    readonly fields?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly workspaceId?: string;
  } = {},
) {
  const body = buildMultipartBody({
    fields: options.fields ?? { projectName: 'ActionQueue — AQ-CONT-1' },
    files: options.files ?? aqFiles(),
  });
  return ready.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${options.workspaceId ?? ready.workspaceId}/plan-imports`,
    headers: {
      cookie: ready.session.cookie,
      origin: ready.context.config.publicOrigin,
      [CSRF_HEADER_NAME]: ready.session.csrfToken,
      'content-type': body.contentType,
      ...options.headers,
    },
    payload: body.payload,
  });
}

describe('plan import over HTTP', () => {
  it('imports the exact AQ-CONT-1 fixture into one atomic plan version', async () => {
    const ready = await signedIn();
    const response = await postImport(ready);
    expect(response.statusCode).toBe(200);

    const parsed = planImportResponseSchema.parse(response.json());
    if (parsed.outcome !== 'succeeded') {
      throw new Error(`Expected success, got ${parsed.outcome}: ${JSON.stringify(parsed)}`);
    }
    expect(parsed.itemCount).toBe(14);
    expect(parsed.requiredDependencyCount).toBe(24);
    expect(parsed.versionNumber).toBe(1);
    expect(parsed.isActiveVersion).toBe(true);
    expect(parsed.diagnostics).toEqual([]);

    const storage = ready.context.storage;
    expect(storage.planning.projects.count()).toBe(1);
    expect(storage.planning.versions.count()).toBe(1);
    expect(storage.planning.workItems.count()).toBe(14);
    expect(storage.planning.dependencies.count()).toBe(24);
    expect(storage.planning.artifacts.count()).toBe(5);

    const items = storage.planning.workItems.listForVersion(
      ready.workspaceId,
      parsed.planVersionId,
    );
    expect(items.map((item) => item.sourceId)).toEqual(
      Array.from({ length: 14 }, (_, index) => `AQ-${String(index + 1).padStart(2, '0')}`),
    );
    expect(items.filter((item) => item.blockerSourceIds.length === 0)).toHaveLength(1);
    expect(items[0]?.sourceId).toBe('AQ-01');
  });

  it('appends project-created and plan-version-imported after commit (CT03-A43)', async () => {
    const ready = await signedIn();
    const before = ready.context.storage.workspaceEvents.count();
    await postImport(ready);
    const events = ready.context.storage.workspaceEvents.listAfter({
      workspaceId: ready.workspaceId,
      after: 0,
      limit: 100,
    });
    expect(events).toHaveLength(before + 2);
    expect(events.map((event) => event.kind)).toEqual([
      'workspace-created',
      'project-created',
      'plan-version-imported',
    ]);
    // A 14-item plan appends one summary event, not fourteen (CT-03 §5.9).
    expect(events.filter((event) => event.kind === 'plan-version-imported')).toHaveLength(1);
  });

  it('treats a byte-identical re-import as an idempotent duplicate (CT03-A29)', async () => {
    const ready = await signedIn();
    const first = planImportResponseSchema.parse((await postImport(ready)).json());
    const beforeEvents = ready.context.storage.workspaceEvents.count();

    // Reversed part order must still resolve to the same bundle identity.
    const second = planImportResponseSchema.parse(
      (await postImport(ready, { files: [...aqFiles()].reverse() })).json(),
    );
    if (first.outcome !== 'succeeded' || second.outcome !== 'duplicate') {
      throw new Error(`Unexpected outcomes: ${first.outcome}/${second.outcome}`);
    }
    expect(second.planVersionId).toBe(first.planVersionId);
    expect(second.projectId).toBe(first.projectId);

    const storage = ready.context.storage;
    expect(storage.planning.versions.count()).toBe(1);
    expect(storage.planning.projects.count()).toBe(1);
    expect(storage.planning.workItems.count()).toBe(14);
    expect(storage.planning.dependencies.count()).toBe(24);
    expect(storage.planning.artifacts.count()).toBe(5);
    // A duplicate records an attempt and audit row but no workspace event.
    expect(storage.planning.importAttempts.count()).toBe(2);
    expect(storage.workspaceEvents.count()).toBe(beforeEvents);
  });

  it('creates a distinct immutable version without changing the active one (CT03-A30, A31)', async () => {
    const ready = await signedIn();
    const first = planImportResponseSchema.parse((await postImport(ready)).json());
    if (first.outcome !== 'succeeded') {
      throw new Error('Expected the first import to succeed');
    }

    // The shipped manifest covers both required artifacts, so revising either
    // is correctly a checksum mismatch. A realistic revision adds material.
    const changed = [
      ...aqFiles(),
      {
        fieldName: 'decision-log',
        filename: 'aq-cont-1-decisions.md',
        contentType: 'text/markdown',
        bytes: new TextEncoder().encode('# Decisions\n\nRevised after review.\n'),
      },
    ];
    const second = planImportResponseSchema.parse(
      (
        await postImport(ready, {
          files: changed,
          fields: { projectId: first.projectId, projectName: 'ActionQueue — AQ-CONT-1' },
        })
      ).json(),
    );
    if (second.outcome !== 'succeeded') {
      throw new Error(`Expected a new version, got ${second.outcome}`);
    }
    expect(second.planVersionId).not.toBe(first.planVersionId);
    expect(second.versionNumber).toBe(2);
    expect(second.isActiveVersion).toBe(false);
    expect(second.projectId).toBe(first.projectId);

    const project = ready.context.storage.planning.projects.find(
      ready.workspaceId,
      first.projectId,
    );
    expect(project?.activePlanVersionId).toBe(first.planVersionId);
    expect(ready.context.storage.planning.projects.count()).toBe(1);
    expect(ready.context.storage.planning.versions.count()).toBe(2);
  });

  it('records a failed validation without any accepted planning state (CT03-A28)', async () => {
    const ready = await signedIn();
    const before = ready.context.storage.workspaceEvents.count();

    const response = await postImport(ready, {
      files: [MINIMAL_PLAN, invalidFile('two-node-cycle.yaml')],
    });
    expect(response.statusCode).toBe(200);
    const parsed = planImportResponseSchema.parse(response.json());
    if (parsed.outcome !== 'failed-validation') {
      throw new Error(`Expected a validation failure, got ${parsed.outcome}`);
    }
    expect(parsed.diagnostics.map((d) => d.code)).toContain('required-dependency-cycle');

    const storage = ready.context.storage;
    expect(storage.planning.importAttempts.count()).toBe(1);
    expect(storage.planning.diagnostics.count()).toBeGreaterThan(0);
    // Bounded source bytes persist so the failure stays diagnosable.
    expect(storage.planning.artifacts.count()).toBe(2);
    expect(storage.planning.projects.count()).toBe(0);
    expect(storage.planning.versions.count()).toBe(0);
    expect(storage.planning.workItems.count()).toBe(0);
    expect(storage.planning.dependencies.count()).toBe(0);
    expect(storage.planning.drafts.count()).toBe(0);
    expect(storage.workspaceEvents.count()).toBe(before);
  });

  it.each([
    ['duplicate-ids.yaml', 'duplicate-work-item-id'],
    ['self-dependency.yaml', 'self-dependency'],
    ['missing-dependency.yaml', 'missing-required-dependency'],
    ['long-cycle.yaml', 'required-dependency-cycle'],
    ['invalid-ids.yaml', 'invalid-work-item-id'],
    ['malformed.yaml', 'invalid-yaml'],
    ['unknown-tag.yaml', 'invalid-yaml'],
    ['alias-bomb.yaml', 'yaml-too-complex'],
    ['unsafe-key.yaml', 'unsafe-yaml-key'],
    ['no-work-items.yaml', 'missing-work-items'],
  ])('fails %s with the %s diagnostic', async (fixture, code) => {
    const ready = await signedIn();
    const parsed = planImportResponseSchema.parse(
      (await postImport(ready, { files: [MINIMAL_PLAN, invalidFile(fixture)] })).json(),
    );
    if (parsed.outcome !== 'failed-validation') {
      throw new Error(`Expected ${fixture} to fail, got ${parsed.outcome}`);
    }
    expect(parsed.diagnostics.map((d) => d.code)).toContain(code);
    expect(ready.context.storage.planning.versions.count()).toBe(0);
  });

  it('rejects a missing required artifact role (CT03-A13)', async () => {
    const ready = await signedIn();
    const parsed = planImportResponseSchema.parse(
      (await postImport(ready, { files: [MINIMAL_PLAN] })).json(),
    );
    if (parsed.outcome !== 'failed-validation') {
      throw new Error('Expected a validation failure');
    }
    expect(parsed.diagnostics.map((d) => d.code)).toContain('required-artifact-missing');
  });

  it('rejects unsupported archive and executable uploads (CT03-A41)', async () => {
    const ready = await signedIn();
    for (const [filename, contentType] of [
      ['bundle.zip', 'application/zip'],
      ['payload.exe', 'application/octet-stream'],
      ['page.html', 'text/html'],
    ] as const) {
      const parsed = planImportResponseSchema.parse(
        (
          await postImport(ready, {
            files: [
              MINIMAL_PLAN,
              {
                fieldName: 'work-breakdown',
                filename,
                contentType,
                bytes: new TextEncoder().encode('document: X\npull_requests: []\n'),
              },
            ],
          })
        ).json(),
      );
      expect(parsed.outcome).toBe('failed-validation');
    }
    expect(ready.context.storage.planning.versions.count()).toBe(0);
  });

  it('rejects a path-shaped or duplicated logical filename (CT03-A23)', async () => {
    const ready = await signedIn();

    // The multipart layer reduces an upload name to its base name, so a
    // traversal attempt cannot reach the validator as a path at all.
    const traversal = planImportResponseSchema.parse(
      (
        await postImport(ready, {
          files: [
            MINIMAL_PLAN,
            {
              fieldName: 'work-breakdown',
              filename: '../../etc/passwd.yaml',
              contentType: 'application/yaml',
              bytes: new TextEncoder().encode('document: X\npull_requests: []\n'),
            },
          ],
        })
      ).json(),
    );
    expect(traversal.outcome).toBe('failed-validation');
    expect(ready.context.storage.planning.artifacts.count()).toBeGreaterThan(0);
    expect(
      ready.context.storage.planning.artifacts
        .listForAttempt(
          ready.workspaceId,
          traversal.outcome === 'failed-validation' ? traversal.importAttemptId : ('' as never),
        )
        .map((artifact) => artifact.logicalFilename),
    ).not.toContain('../../etc/passwd.yaml');

    // A name that does survive the transport is still rejected by the validator.
    const hostile = planImportResponseSchema.parse(
      (
        await postImport(ready, {
          files: [
            MINIMAL_PLAN,
            {
              fieldName: 'work-breakdown',
              filename: 'work breakdown.yaml',
              contentType: 'application/yaml',
              bytes: new TextEncoder().encode('document: X\npull_requests: []\n'),
            },
          ],
        })
      ).json(),
    );
    if (hostile.outcome !== 'failed-validation') {
      throw new Error('Expected the hostile filename to be rejected');
    }
    expect(hostile.diagnostics.map((d) => d.code)).toContain('invalid-logical-filename');

    const duplicate = planImportResponseSchema.parse(
      (
        await postImport(ready, {
          files: [
            ...aqFiles(),
            { ...aqFile('aq-cont-1-work-breakdown.yaml', 'supporting', 'application/yaml') },
          ],
        })
      ).json(),
    );
    if (duplicate.outcome !== 'failed-validation') {
      throw new Error('Expected the duplicate filename to be rejected');
    }
    expect(duplicate.diagnostics.map((d) => d.code)).toContain('duplicate-logical-filename');
  });

  it('rejects an oversized artifact without accepting it (CT03-A23)', async () => {
    const ready = await signedIn();
    const parsed = planImportResponseSchema.parse(
      (
        await postImport(ready, {
          files: [
            MINIMAL_PLAN,
            {
              fieldName: 'work-breakdown',
              filename: 'huge.yaml',
              contentType: 'application/yaml',
              bytes: new Uint8Array(2 * 1024 * 1024 + 512),
            },
          ],
        })
      ).json(),
    );
    if (parsed.outcome !== 'failed-validation') {
      throw new Error('Expected the oversized artifact to be rejected');
    }
    expect(parsed.diagnostics.map((d) => d.code)).toContain('artifact-too-large');
    expect(ready.context.storage.planning.artifacts.count()).toBe(1);
  });

  it('rejects missing CSRF, wrong CSRF, and cross-site origins (CT03-A38)', async () => {
    const ready = await signedIn();
    const body = buildMultipartBody({ fields: { projectName: 'AQ' }, files: aqFiles() });
    const base = {
      method: 'POST' as const,
      url: `/api/workspaces/${ready.workspaceId}/plan-imports`,
      payload: body.payload,
    };

    const noCsrf = await ready.context.app.inject({
      ...base,
      headers: {
        cookie: ready.session.cookie,
        origin: ready.context.config.publicOrigin,
        'content-type': body.contentType,
      },
    });
    expect(noCsrf.statusCode).toBe(403);

    const wrongCsrf = await postImport(ready, { headers: { [CSRF_HEADER_NAME]: 'wrong' } });
    expect(wrongCsrf.statusCode).toBe(403);

    const crossOrigin = await postImport(ready, { headers: { origin: 'http://evil.example' } });
    expect(crossOrigin.statusCode).toBe(403);

    const crossSite = await postImport(ready, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.statusCode).toBe(403);

    const unauthenticated = await ready.context.app.inject({
      ...base,
      headers: {
        origin: ready.context.config.publicOrigin,
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': body.contentType,
      },
    });
    expect(unauthenticated.statusCode).toBe(401);

    expect(ready.context.storage.planning.importAttempts.count()).toBe(0);
  });

  it('rejects a revoked session (CT03-A38)', async () => {
    const ready = await signedIn();
    await ready.context.app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${ready.session.sessionId}/revoke`,
      headers: {
        cookie: ready.session.cookie,
        origin: ready.context.config.publicOrigin,
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect((await postImport(ready)).statusCode).toBe(401);
    expect(ready.context.storage.planning.importAttempts.count()).toBe(0);
  });

  it('returns the same 404 for an unknown workspace as for an unauthorized one', async () => {
    const ready = await signedIn();
    const response = await postImport(ready, { workspaceId: 'workspace-that-does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not-found', message: 'Resource not found' },
    });
  });

  it('rejects a non-multipart body', async () => {
    const ready = await signedIn();
    const response = await ready.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${ready.workspaceId}/plan-imports`,
      headers: {
        cookie: ready.session.cookie,
        origin: ready.context.config.publicOrigin,
        [CSRF_HEADER_NAME]: ready.session.csrfToken,
        'content-type': 'application/json',
      },
      payload: { projectName: 'AQ' },
    });
    expect(response.statusCode).toBe(400);
    expect(ready.context.storage.planning.importAttempts.count()).toBe(0);
  });

  it('requires a project name when no project is selected', async () => {
    const ready = await signedIn();
    const response = await postImport(ready, { fields: {} });
    expect(response.statusCode).toBe(400);
  });

  it('keeps audit metadata bounded and free of secrets (CT03-A42)', async () => {
    const lines: string[] = [];
    const ready = await signedIn({ loggerStream: { write: (message) => lines.push(message) } });
    const parsed = planImportResponseSchema.parse((await postImport(ready)).json());
    if (parsed.outcome !== 'succeeded') {
      throw new Error('Expected success');
    }

    const audit = ready.context.storage.audit.listWorkspace({
      workspaceId: ready.workspaceId,
      limit: 50,
    });
    const importRow = audit.find((row) => row.action === 'plan.import.succeeded');
    expect(importRow).toBeDefined();
    const serialized = JSON.stringify(importRow?.metadata ?? {});
    expect(serialized).not.toContain(ready.session.csrfToken);
    expect(serialized).not.toContain(ready.session.cookie);
    expect(serialized).not.toContain('pull_requests');
    expect(serialized).not.toContain('AQ-01');
    expect(serialized.length).toBeLessThan(500);
    expect(Object.keys(importRow?.metadata ?? {}).toSorted()).toEqual([
      'artifactCount',
      'bundleDigest',
      'errorCount',
      'itemCount',
      'projectId',
      'requiredDependencyCount',
      'totalByteLength',
      'versionNumber',
      'warningCount',
    ]);

    const logs = lines.join('\n');
    expect(logs).not.toContain(ready.session.csrfToken);
    expect(logs).not.toContain('pull_requests');
  });

  it('preserves exact source bytes for later retrieval (CT03-A12, CT03-I03)', async () => {
    const ready = await signedIn();
    const parsed = planImportResponseSchema.parse((await postImport(ready)).json());
    if (parsed.outcome !== 'succeeded') {
      throw new Error('Expected success');
    }
    const artifacts = ready.context.storage.planning.artifacts.listForVersion(
      ready.workspaceId,
      parsed.planVersionId,
    );
    const workBreakdown = artifacts.find((artifact) => artifact.role === 'work-breakdown');
    expect(workBreakdown?.logicalFilename).toBe('aq-cont-1-work-breakdown.yaml');

    const stored = ready.context.storage.planning.artifacts.findWithContent(
      ready.workspaceId,
      workBreakdown?.id ?? ('' as never),
    );
    const original = readFileSync(new URL('aq-cont-1/aq-cont-1-work-breakdown.yaml', FIXTURE_DIR));
    expect(Buffer.from(stored?.content ?? new Uint8Array()).equals(original)).toBe(true);
  });
});
