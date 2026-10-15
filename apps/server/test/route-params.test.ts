import { DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from '../src/config.js';
import { cycleProfiles } from './execution-test-support.js';
import { createTestContext, TEST_USERNAME, type TestContext } from './test-support.js';

/**
 * Path parameters on the daemon's own routes (R-H7): each is parsed once, before the handler, with
 * the schema its route declares, and one that does not parse is refused as the route's handler
 * refused it before, with the same status and body.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

async function signedIn() {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  const workspaceId = context.storage.workspaces.listAuthorized(
    context.storage.users.findByNormalizedUsername(TEST_USERNAME)!.id,
  )[0]!.workspace.id;
  const headers = (origin = context.config.publicOrigin) => ({
    cookie: session.cookie,
    [CSRF_HEADER_NAME]: session.csrfToken,
    origin,
    'content-type': 'application/json',
  });
  const get = (path: string, origin?: string) =>
    context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/${path}`,
      headers: headers(origin),
    });
  const post = (path: string, payload: Record<string, unknown>) =>
    context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/${path}`,
      headers: headers(),
      payload,
    });
  return { context, session, workspaceId, get, post };
}

const notFound = (message = 'Resource not found') => ({
  error: { code: 'not-found', message },
});

describe('a run event stream', () => {
  it('checks the origin after the access check and before a run id that does not parse', async () => {
    const { context, workspaceId, get } = await signedIn();
    const anonymous = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/runs/%20x/events`,
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(anonymous.statusCode).toBe(401);
    const foreign = await get('runs/%20x/events', 'https://evil.example');
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ error: { code: 'forbidden', message: 'Request forbidden' } });
    const malformed = await get('runs/%20x/events');
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toEqual(notFound());
  });
});

describe('session and workspace routes', () => {
  it('refuse a malformed session or workspace id with 404, and pass a parsed one on', async () => {
    const { context, session, get } = await signedIn();
    const revoke = (sessionId: string) =>
      context.app.inject({
        method: 'POST',
        url: `/api/auth/sessions/${sessionId}/revoke`,
        headers: {
          cookie: session.cookie,
          [CSRF_HEADER_NAME]: session.csrfToken,
          origin: context.config.publicOrigin,
          'content-type': 'application/json',
        },
        payload: {},
      });
    const malformed = await revoke('%20x');
    expect(malformed.statusCode).toBe(404);
    expect(malformed.json()).toEqual(notFound());
    const noWorkspace = await context.app.inject({
      method: 'GET',
      url: '/api/workspaces/%20w/snapshot',
      headers: { cookie: session.cookie },
    });
    expect(noWorkspace.statusCode).toBe(404);
    expect(noWorkspace.json()).toEqual(notFound());
    expect((await get('snapshot')).statusCode).toBe(200);
    const revoked = await revoke(session.sessionId);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toEqual({
      revokedSessionId: session.sessionId,
      currentSessionRevoked: true,
    });
  });
});

describe('planning and work item routes', () => {
  it('refuse a malformed project, plan version, artifact or work item id with 404', async () => {
    const { get, post } = await signedIn();
    const uuid = '00000000-0000-4000-8000-000000000001';
    for (const path of [
      'projects/%20x',
      `projects/${uuid}/plan-versions/%20x`,
      'plan-versions/%20x/graph',
      'plan-artifacts/%20x',
      'work-items/%20x/view',
    ]) {
      const response = await get(path);
      expect(response.statusCode, path).toBe(404);
      expect(response.json(), path).toEqual(notFound());
    }
    const admit = await post('work-items/%20x/control', { action: 'admit' });
    expect(admit.statusCode).toBe(404);
    expect(admit.json()).toEqual(notFound());
    // The body is refused before the id, as the handler refused them.
    const both = await post('work-items/%20x/control', { action: 'admit-all' });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toEqual({
      error: { code: 'invalid-request', message: 'Invalid work item command' },
    });
  });
});

describe('execution routes: repositories, worktrees, runs and checks', () => {
  it('refuse a malformed id with 404 and the message each route gave', async () => {
    const { get, post } = await signedIn();
    const uuid = '00000000-0000-4000-8000-000000000002';
    const reads: readonly (readonly [string, string?])[] = [
      ['worktrees/%20x/diff'],
      ['worktrees/%20x/branch-status'],
      ['worktrees/%20x/check-definitions', 'Worktree not found'],
      ['repositories/%20x/branches'],
      ['repositories/%20x/checks', 'Repository not found'],
      ['repositories/%20x/checks/receipts', 'Repository not found'],
      ['runs/%20x'],
      ['runs/%20x/event-page'],
      ['runs/%20x/view'],
      [`runs/${uuid}/tool-results/not-a-digest`],
      ['work-items/%20x/execution-scopes'],
      ['plan-versions/%20x/repository-policy', 'Plan not found'],
      ['plan-versions/%20x/branch-settings'],
    ];
    for (const [path, message] of reads) {
      const response = await get(path);
      expect(response.statusCode, path).toBe(404);
      expect(response.json(), path).toEqual(notFound(message));
    }
    // A merge asks for no password for a worktree id that does not parse (its rule finds no
    // worktree), and the id is refused.
    const merge = await post('worktrees/%20x/merge', {});
    expect(merge.statusCode).toBe(404);
    expect(merge.json()).toEqual(notFound());
    const control = await post('runs/%20x/control', { action: 'cancel' });
    expect(control.statusCode).toBe(404);
    expect(control.json()).toEqual(notFound());
    const adopt = await post('repositories/%20x/checks/preview', { ref: 'main' });
    expect(adopt.statusCode).toBe(404);
    expect(adopt.json()).toEqual(notFound('Repository not found'));
  });
});

describe('cycle and finalization routes', () => {
  it('refuse a malformed work item or plan version id as before, and pass a cycle id on to its lookup', async () => {
    const { post, get } = await signedIn();
    const uuid = '00000000-0000-4000-8000-000000000003';
    const start = await post('work-items/%20x/cycles', {
      worktreeId: uuid,
      profiles: cycleProfiles,
      policy: DEFAULT_COMPLETION_POLICY,
    });
    expect(start.statusCode).toBe(404);
    expect(start.json()).toEqual(notFound('Work item not found'));
    const finalizations = await get('plan-versions/%20x/finalizations');
    expect(finalizations.statusCode).toBe(404);
    expect(finalizations.json()).toEqual(notFound('Plan not found'));
    const settings = await post('plan-versions/%20x/finalizations', { rounds: 'many' });
    expect(settings.statusCode).toBe(400);
    expect(settings.json()).toEqual({
      error: { code: 'invalid-request', message: 'Invalid finalization settings' },
    });
    // A cycle id was never checked by its handlers: it is only branded, and each service still
    // answers what its lookup finds, padded or not.
    for (const id of [uuid, '%20x']) {
      const evidence = await get(`cycles/${id}/baseline-evidence`);
      expect(evidence.statusCode).toBe(404);
      expect(evidence.json()).toEqual(notFound());
      const control = await post(`cycles/${id}/control`, { action: 'resume', expectedVersion: 1 });
      expect(control.statusCode).toBe(404);
      expect(control.json()).toEqual(notFound());
      const repair = await post(`cycles/${id}/scope-repair`, {
        expectedVersion: 1,
        snapshotDigest: '0'.repeat(64),
        sourceId: 'slice',
        maxRemediationRounds: 1,
      });
      expect(repair.statusCode).toBe(409);
      expect(repair.json()).toEqual({
        error: {
          code: 'conflict',
          message: 'An idle scope review is required for source remediation.',
        },
      });
      const finalization = await post(`finalizations/${id}/control`, {
        action: 'pause',
        expectedVersion: 1,
      });
      expect(finalization.statusCode).toBe(404);
    }
  });
});
