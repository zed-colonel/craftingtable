import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * Large API reads go gzipped, and every successful read carries a weak validator that answers
 * an unchanged repeat with 304 (R-D5, PERF-16). Responses stay `no-store`: the browser app
 * revalidates in memory, so no authenticated answer is kept in the browser's disk cache.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

async function fixture(workspaces: number) {
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  for (let index = 0; index < workspaces; index++) {
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: {
        cookie: session.cookie,
        'x-craftingtable-csrf': session.csrfToken,
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { name: `Workspace ${index} ${'x'.repeat(60)}` },
    });
    expect(created.statusCode, created.body).toBe(200);
  }
  const get = (url: string, headers: Record<string, string> = {}) =>
    context.app.inject({ method: 'GET', url, headers: { cookie: session.cookie, ...headers } });
  return { context, session, get };
}

describe('response encoding (R-D5, PERF-16)', () => {
  it('gzips a JSON read over 8 KB for a client that accepts it, and only then', async () => {
    const { get } = await fixture(40);
    const plain = await get('/api/workspaces');
    expect(plain.statusCode).toBe(200);
    expect(Buffer.byteLength(plain.body)).toBeGreaterThan(8 * 1024);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers.vary).toContain('accept-encoding');

    const zipped = await get('/api/workspaces', { 'accept-encoding': 'br, gzip;q=0.8' });
    expect(zipped.statusCode).toBe(200);
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers.vary).toContain('accept-encoding');
    expect(Number(zipped.headers['content-length'])).toBe(zipped.rawPayload.length);
    expect(zipped.rawPayload.length).toBeLessThan(Buffer.byteLength(plain.body) / 4);
    expect(gunzipSync(zipped.rawPayload).toString('utf8')).toBe(plain.body);
    expect(zipped.headers['cache-control']).toBe('no-store');

    // A client that refuses gzip gets the body as it is.
    const refused = await get('/api/workspaces', { 'accept-encoding': 'gzip;q=0' });
    expect(refused.headers['content-encoding']).toBeUndefined();
  });

  it('leaves a small read uncompressed', async () => {
    const { get } = await fixture(0);
    const small = await get('/api/workspaces', { 'accept-encoding': 'gzip' });
    expect(small.statusCode).toBe(200);
    expect(Buffer.byteLength(small.body)).toBeLessThan(8 * 1024);
    expect(small.headers['content-encoding']).toBeUndefined();
  });

  it('answers an unchanged read with 304 and a changed one in full', async () => {
    const { context, session, get } = await fixture(2);
    const first = await get('/api/workspaces', { 'accept-encoding': 'gzip' });
    const tag = first.headers.etag;
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    const again = await get('/api/workspaces', { 'if-none-match': String(tag) });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect(again.headers.etag).toBe(tag);
    // A list of validators, one of them current, matches too.
    const listed = await get('/api/workspaces', { 'if-none-match': `W/"other", ${tag}` });
    expect(listed.statusCode).toBe(304);
    // The validator does not depend on the encoding: a gzipped answer matches a plain one.
    const plain = await get('/api/workspaces');
    expect(plain.headers.etag).toBe(tag);

    await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: {
        cookie: session.cookie,
        'x-craftingtable-csrf': session.csrfToken,
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { name: 'Another workspace' },
    });
    const changed = await get('/api/workspaces', { 'if-none-match': String(tag) });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(tag);
    expect(changed.body).toContain('Another workspace');
  });

  it('gives no validator to errors or commands', async () => {
    const { context, session, get } = await fixture(0);
    const missing = await get('/api/workspaces/00000000-0000-4000-8000-000000000000/snapshot');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.etag).toBeUndefined();
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: {
        cookie: session.cookie,
        'x-craftingtable-csrf': session.csrfToken,
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
        'accept-encoding': 'gzip',
      },
      payload: { name: `Big ${'y'.repeat(70)}` },
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers.etag).toBeUndefined();
  });

  it('never compresses a sign-in answer, which carries the CSRF token, however large', async () => {
    const { context, session, get } = await fixture(0);
    // Enough sessions that the session list is well over the threshold.
    for (let count = 0; count < 40; count++) await context.login();
    const sessions = await get('/api/auth/sessions', { 'accept-encoding': 'gzip' });
    expect(sessions.statusCode).toBe(200);
    expect(Buffer.byteLength(sessions.body)).toBeGreaterThan(8 * 1024);
    expect(sessions.headers['content-encoding']).toBeUndefined();
    const signedIn = await get('/api/auth/session', { 'accept-encoding': 'gzip' });
    expect(signedIn.headers['content-encoding']).toBeUndefined();
    expect(session.csrfToken).toBeTruthy();
  });
});
