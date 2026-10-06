import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import type { PasswordHasher } from '../src/security/password-hasher.js';
import {
  createTestContext,
  FastTestPasswordHasher,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from './test-support.js';

/**
 * Authentication hardening (R-G9, SEC-04; operator decisions 2026-10-05): sessions end after 24
 * hours without a request, and 5 failed sign-ins within 15 minutes, per username and per client
 * address, refuse further attempts for 15 minutes, with one audit row per username per window and
 * at most 2 password verifications at once.
 */

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

async function clock(env: Readonly<Record<string, string>> = {}) {
  const state = { now: new Date('2026-10-06T08:00:00.000Z') };
  const context = await createTestContext({ now: () => state.now, env });
  contexts.push(context);
  await context.bootstrap();
  const advance = (ms: number) => {
    state.now = new Date(state.now.getTime() + ms);
  };
  return { context, advance };
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

function signIn(
  context: TestContext,
  username: string,
  password: string,
  options: { remoteAddress?: string; forwardedFor?: string } = {},
) {
  return context.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
    headers: {
      origin: context.config.publicOrigin,
      'content-type': 'application/json',
      ...(options.forwardedFor === undefined ? {} : { 'x-forwarded-for': options.forwardedFor }),
    },
    payload: { username, password },
  });
}

describe('idle sessions end (R-G9)', () => {
  it('ends a session after 24 hours without a request, and keeps one in use', async () => {
    const { context, advance } = await clock();
    const used = await context.login();
    const idle = await context.login();
    const read = (cookie: string) =>
      context.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    // A request every 20 hours keeps a session alive past 24 hours.
    advance(20 * HOUR);
    expect((await read(used.cookie)).statusCode).toBe(200);
    advance(20 * HOUR);
    expect((await read(used.cookie)).statusCode).toBe(200);
    // The other went 40 hours without one.
    const ended = await read(idle.cookie);
    expect(ended.statusCode).toBe(401);
    expect(ended.json().error.code).toBe('unauthenticated');
    // Just inside the window still works.
    const fresh = await context.login();
    advance(24 * HOUR - MINUTE);
    expect((await read(fresh.cookie)).statusCode).toBe(200);
  });
});

it('ends a session after the configured idle span', async () => {
  const { context, advance } = await clock({ CRAFTINGTABLE_SESSION_IDLE_SECONDS: '3600' });
  const session = await context.login();
  const read = () =>
    context.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: session.cookie },
    });
  advance(50 * MINUTE);
  expect((await read()).statusCode).toBe(200);
  advance(61 * MINUTE);
  expect((await read()).statusCode).toBe(401);
});

describe('sign-in rate limit (R-G9)', () => {
  it('locks a username after 5 failures within 15 minutes, from any address, for 15 minutes', async () => {
    const { context, advance } = await clock();
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await signIn(context, TEST_USERNAME, 'wrong password value', {
        remoteAddress: `10.0.0.${attempt + 1}`,
      });
      expect(wrong.statusCode).toBe(401);
      advance(MINUTE);
    }
    // Locked: even the right password, from a fresh address, is refused without verification.
    const locked = await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
      remoteAddress: '10.0.0.9',
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toMatchObject({
      code: 'rate-limited',
      reason: 'login-rate-limited',
    });
    advance(15 * MINUTE);
    const open = await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
      remoteAddress: '10.0.0.9',
    });
    expect(open.statusCode, open.body).toBe(200);
    // One failed-login row stands for the window; the lock is recorded once.
    expect(auditActions(context).filter((action) => action.startsWith('auth.login'))).toEqual([
      'auth.login.failed',
      'auth.login.rate-limited',
      'auth.login',
    ]);
  });

  it("clears a username's failures when it signs in", async () => {
    const { context } = await clock();
    let address = 0;
    const attempt = (password: string) =>
      signIn(context, TEST_USERNAME, password, { remoteAddress: `10.1.0.${++address}` });
    for (let round = 0; round < 2; round++) {
      for (let failure = 0; failure < 4; failure++)
        expect((await attempt('wrong password value')).statusCode).toBe(401);
      expect((await attempt(TEST_PASSWORD)).statusCode).toBe(200);
    }
  });

  it('locks an address after 5 failures within 15 minutes, whatever the usernames', async () => {
    const { context } = await clock();
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      expect(
        (
          await signIn(context, `user-${name}`, 'wrong password value', {
            remoteAddress: '10.0.0.7',
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (await signIn(context, TEST_USERNAME, TEST_PASSWORD, { remoteAddress: '10.0.0.7' }))
        .statusCode,
    ).toBe(429);
    // Another address signs in.
    expect(
      (await signIn(context, TEST_USERNAME, TEST_PASSWORD, { remoteAddress: '10.0.0.8' }))
        .statusCode,
    ).toBe(200);
  });

  it("counts a proxied client by the address the loopback proxy names, never a remote client's own claim", async () => {
    const { context } = await clock();
    // Behind `tailscale serve` every request comes from loopback, naming its client.
    for (let attempt = 0; attempt < 5; attempt++)
      await signIn(context, `user-${attempt}`, 'wrong password value', {
        remoteAddress: '127.0.0.1',
        forwardedFor: '100.64.0.5',
      });
    expect(
      (
        await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
          remoteAddress: '127.0.0.1',
          forwardedFor: '100.64.0.5',
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
          remoteAddress: '127.0.0.1',
          forwardedFor: '100.64.0.6',
        })
      ).statusCode,
    ).toBe(200);
    // The proxy names its client last; a client's own entries before it change nothing.
    expect(
      (
        await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
          remoteAddress: '127.0.0.1',
          forwardedFor: '100.64.9.1, 100.64.0.5',
        })
      ).statusCode,
    ).toBe(429);
    // A client that is not the loopback proxy cannot choose its bucket.
    for (let attempt = 0; attempt < 5; attempt++)
      await signIn(context, `other-${attempt}`, 'wrong password value', {
        remoteAddress: '10.0.0.20',
        forwardedFor: `100.64.1.${attempt}`,
      });
    expect(
      (
        await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
          remoteAddress: '10.0.0.20',
          forwardedFor: '100.64.9.9',
        })
      ).statusCode,
    ).toBe(429);
  });

  it('verifies at most 2 passwords at once', async () => {
    let running = 0;
    let most = 0;
    const fast = new FastTestPasswordHasher();
    const slow: PasswordHasher = {
      hash: (password) => fast.hash(password),
      verify: async (hash, password) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return fast.verify(hash, password);
      },
    };
    const context = await createTestContext({ passwordHasher: slow });
    contexts.push(context);
    await context.bootstrap();
    const answers = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        signIn(context, TEST_USERNAME, n % 2 ? TEST_PASSWORD : 'wrong password value', {
          remoteAddress: `10.0.1.${n}`,
        }),
      ),
    );
    expect(answers.map((a) => a.statusCode).toSorted()).toEqual([200, 200, 200, 401, 401, 401]);
    expect(most).toBe(2);
  });
});
