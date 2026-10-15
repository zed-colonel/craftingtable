import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from '../src/config.js';
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
