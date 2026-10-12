import {
  authenticatedSessionResponseSchema,
  sessionListResponseSchema,
} from '@craftingtable/contracts';
import { asSessionId, asUserId, normalizeUsername } from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  FastTestPasswordHasher,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

function auditActions(context: TestContext): readonly string[] {
  const database = openDatabase(context.config.databasePath);
  try {
    return (
      database.prepare(`SELECT action FROM audit_events ORDER BY sequence`).all() as {
        action: string;
      }[]
    ).map((row) => row.action);
  } finally {
    database.close();
  }
}

describe('authentication HTTP surface', () => {
  it('logs in generically, stores only a digest, and returns the required cookie', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();

    const invalid = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: context.config.publicOrigin, 'content-type': 'application/json' },
      payload: { username: 'missing', password: TEST_PASSWORD },
    });
    const wrong = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: context.config.publicOrigin, 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: 'wrong password value' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(invalid.body).toBe(wrong.body);

    const login = await context.login();
    const rawToken = login.cookie.split('=')[1] as string;
    const session = context.storage.sessions.findById(asSessionId(login.sessionId));
    expect(session?.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(session?.tokenDigest).not.toBe(rawToken);
    expect(JSON.stringify(session)).not.toContain(rawToken);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: login.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(authenticatedSessionResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(auditActions(context)).toEqual([
      'admin.bootstrap',
      'workspace.created',
      'auth.login.failed',
      'auth.login.failed',
      'auth.login',
    ]);
  });

  it('sets HTTP and HTTPS cookie attributes correctly', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'https://127.0.0.1:5173']) {
      const context = await createTestContext({ publicOrigin: origin });
      contexts.push(context);
      await context.bootstrap();
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin, 'content-type': 'application/json' },
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      const cookies = [response.headers['set-cookie'] ?? []].flat();
      const https = origin.startsWith('https:');
      // On HTTPS the session cookie carries the `__Host-` prefix (SEC-04, operator decision
      // 2026-10-12): Secure, Path=/ and no Domain, or a browser refuses it. HTTP keeps the plain
      // name, which a browser would refuse with the prefix.
      const name = https ? '__Host-craftingtable_session' : 'craftingtable_session';
      const cookie = cookies.find((value) => value.startsWith(`${name}=`)) ?? '';
      expect(cookie.split(';')[0]?.length).toBeGreaterThan(name.length + 1);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('Expires=');
      expect(cookie).not.toContain('Domain=');
      expect(cookie.includes('Secure')).toBe(https);
      // An HTTPS sign-in clears a cookie left under the plain name; HTTP sets only its own.
      if (https) {
        const cleared = cookies.filter((value) => value.startsWith('craftingtable_session='));
        expect(cleared).toHaveLength(1);
        expect(cleared[0]).toMatch(/^craftingtable_session=;.*Expires=Thu, 01 Jan 1970/);
      } else expect(cookies).toHaveLength(1);
      // The daemon reads the cookie only under its own name.
      const token = cookie.split(';')[0]?.slice(name.length + 1);
      const session = (cookieName: string) =>
        context.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: `${cookieName}=${token}` },
        });
      expect((await session(name)).statusCode).toBe(200);
      const other = https ? 'craftingtable_session' : '__Host-craftingtable_session';
      expect((await session(other)).statusCode).toBe(401);
    }
  });

  it('requires JSON and rejects cross-site login metadata', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();
    for (const request of [
      {
        headers: {
          origin: context.config.publicOrigin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: `username=${TEST_USERNAME}&password=${TEST_PASSWORD}`,
      },
      {
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      },
    ]) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        ...request,
      });
      expect(response.statusCode).toBe(
        request.headers.origin === context.config.publicOrigin ? 400 : 403,
      );
    }
  });

  it('rejects missing/invalid CSRF and accepts the session-bound token for logout', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();
    const login = await context.login();

    for (const csrf of [undefined, 'invalid']) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: login.cookie,
          origin: context.config.publicOrigin,
          ...(csrf === undefined ? {} : { 'x-craftingtable-csrf': csrf }),
        },
      });
      expect(response.statusCode).toBe(403);
    }

    const invalidBody = await context.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: login.cookie,
        origin: context.config.publicOrigin,
        'x-craftingtable-csrf': login.csrfToken,
      },
      payload: { unexpected: true },
    });
    expect(invalidBody.statusCode).toBe(400);

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: login.cookie,
        origin: context.config.publicOrigin,
        'x-craftingtable-csrf': login.csrfToken,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    expect(
      (
        await context.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: login.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(auditActions(context).at(-1)).toBe('auth.logout');
  });

  it('changes the password after verifying the current one and revokes other sessions', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();
    const first = await context.login();
    const second = await context.login();
    const mutation = (login: { cookie: string; csrfToken: string }) => ({
      cookie: login.cookie,
      origin: context.config.publicOrigin,
      'x-craftingtable-csrf': login.csrfToken,
      'content-type': 'application/json',
    });

    const wrongCurrent = await context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: mutation(first),
      payload: { currentPassword: 'not the password', newPassword: 'a brand new passphrase' },
    });
    expect(wrongCurrent.statusCode).toBe(401);

    const tooShort = await context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: mutation(first),
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'short' },
    });
    expect(tooShort.statusCode).toBe(400);

    const changed = await context.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: mutation(first),
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a brand new passphrase' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ success: true, revokedSessionCount: 1 });

    // The changing session survives; the other one is gone.
    expect(
      (
        await context.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: first.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await context.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: second.cookie },
        })
      ).statusCode,
    ).toBe(401);

    const oldPassword = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { username: TEST_USERNAME, password: 'a brand new passphrase' },
    });
    expect(newPassword.statusCode).toBe(200);
    expect(auditActions(context)).toContain('user.password-changed');
  });

  it('lists and revokes another own session but not another user session', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();
    const first = await context.login();
    const second = await context.login();

    const list = await context.app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: first.cookie },
    });
    expect(sessionListResponseSchema.parse(list.json()).sessions).toHaveLength(2);

    const revoke = await context.app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${second.sessionId}/revoke`,
      headers: {
        cookie: first.cookie,
        origin: context.config.publicOrigin,
        'x-craftingtable-csrf': first.csrfToken,
      },
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    expect(
      (
        await context.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: second.cookie },
        })
      ).statusCode,
    ).toBe(401);

    const otherUserId = asUserId('other-user');
    const otherPasswordHash = await new FastTestPasswordHasher().hash(TEST_PASSWORD);
    context.storage.users.insert({
      id: otherUserId,
      username: 'other',
      usernameNormalized: normalizeUsername('other'),
      passwordHash: otherPasswordHash,
      occurredAt: new Date().toISOString(),
    });
    const otherLoginResponse = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: context.config.publicOrigin, 'content-type': 'application/json' },
      payload: { username: 'other', password: TEST_PASSWORD },
    });
    const otherSessionId = authenticatedSessionResponseSchema.parse(otherLoginResponse.json())
      .session.id;
    const ownership = await context.app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${otherSessionId}/revoke`,
      headers: {
        cookie: first.cookie,
        origin: context.config.publicOrigin,
        'x-craftingtable-csrf': first.csrfToken,
      },
      payload: {},
    });
    expect(ownership.statusCode).toBe(404);
    expect(auditActions(context)).toContain('auth.session.revoked');
  });

  it('rejects an expired session', async () => {
    let now = new Date('2026-07-24T00:00:00.000Z');
    const context = await createTestContext({ now: () => now });
    contexts.push(context);
    await context.bootstrap();
    const login = await context.login();
    now = new Date('2026-09-01T00:00:00.000Z');
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: login.cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not write credentials or session secrets to request logs', async () => {
    let logs = '';
    const context = await createTestContext({
      loggerStream: {
        write(message) {
          logs += message;
        },
      },
    });
    contexts.push(context);
    await context.bootstrap();
    const login = await context.login();
    const rawToken = login.cookie.split('=')[1] as string;
    await context.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: login.cookie },
    });
    expect(logs).not.toContain(TEST_PASSWORD);
    expect(logs).not.toContain(rawToken);
    expect(logs).not.toContain(login.csrfToken);
  });
});

it('explains a localhost origin mismatch before checking credentials and still accepts the configured HTTPS origin', async () => {
  const origin = 'https://workstation.example.test';
  const context = await createTestContext({ publicOrigin: origin });
  contexts.push(context);
  await context.bootstrap();
  const before = context.storage.audit.count();
  const rejected = await context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      origin: 'http://localhost:4600',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  expect(rejected.statusCode).toBe(403);
  expect(rejected.json().error).toEqual({
    code: 'forbidden',
    message: `Sign-in is only allowed from ${origin}. Open that address and try again.`,
  });
  expect(rejected.headers['set-cookie']).toBeUndefined();
  expect(context.storage.audit.count()).toBe(before);
  const accepted = await context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  expect(accepted.statusCode).toBe(200);
  const session = [accepted.headers['set-cookie'] ?? []]
    .flat()
    .find((value) => value.startsWith('__Host-craftingtable_session='));
  expect(session).toContain('Secure');
});
