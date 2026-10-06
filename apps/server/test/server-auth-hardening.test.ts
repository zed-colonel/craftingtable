import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

it('lists only sessions that can still be used: an idle-ended one is gone (R-G9 review)', async () => {
  const { context, advance } = await clock();
  const idle = await context.login();
  advance(25 * HOUR);
  const fresh = await context.login();
  const listed = await context.app.inject({
    method: 'GET',
    url: '/api/auth/sessions',
    headers: { cookie: fresh.cookie },
  });
  expect(listed.statusCode).toBe(200);
  const sessions = listed.json().sessions as { current: boolean }[];
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.current).toBe(true);
  expect(idle.cookie).not.toBe(fresh.cookie);
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
    // A proxy on IPv6 loopback, or IPv4 loopback written as IPv6, names its client too.
    for (const proxy of ['::1', '::ffff:127.0.0.1'])
      expect(
        (
          await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
            remoteAddress: proxy,
            forwardedFor: '100.64.0.5',
          })
        ).statusCode,
      ).toBe(429);
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
      [1, 2, 3, 4, 5].map((n) =>
        signIn(context, TEST_USERNAME, n % 2 ? TEST_PASSWORD : 'wrong password value', {
          remoteAddress: `10.0.1.${n}`,
        }),
      ),
    );
    expect(answers.map((a) => a.statusCode).toSorted()).toEqual([200, 200, 200, 401, 401]);
    expect(most).toBe(2);
  });

  it('counts sign-ins made at once before any is verified, so a burst gets at most 5 guesses (R-G9 review)', async () => {
    let verified = 0;
    const fast = new FastTestPasswordHasher();
    const slow: PasswordHasher = {
      hash: (password) => fast.hash(password),
      verify: async (hash, password) => {
        verified += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return fast.verify(hash, password);
      },
    };
    const context = await createTestContext({ passwordHasher: slow });
    contexts.push(context);
    await context.bootstrap();
    verified = 0;
    // 39 wrong guesses and the right one last, all at once, from one address.
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, n) =>
        signIn(context, TEST_USERNAME, n === 39 ? TEST_PASSWORD : `wrong password ${n}`, {
          remoteAddress: '10.9.9.9',
        }),
      ),
    );
    const codes = answers.map((answer) => answer.statusCode);
    expect(codes.filter((code) => code === 401)).toHaveLength(5);
    expect(codes.filter((code) => code === 429)).toHaveLength(35);
    expect(verified).toBe(5);
    // The username stays locked from any address, the right password included.
    expect(
      (await signIn(context, TEST_USERNAME, TEST_PASSWORD, { remoteAddress: '10.9.9.8' }))
        .statusCode,
    ).toBe(429);
  });

  it('refuses a sign-in beyond the waiting queue for a second, without counting it (R-G9 review)', async () => {
    let hold = false;
    let verifying = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const fast = new FastTestPasswordHasher();
    const held: PasswordHasher = {
      hash: (password) => fast.hash(password),
      verify: async (hash, password) => {
        if (hold) {
          verifying += 1;
          await opened;
        }
        return fast.verify(hash, password);
      },
    };
    const state = { now: new Date('2026-10-06T08:00:00.000Z') };
    const context = await createTestContext({ passwordHasher: held, now: () => state.now });
    contexts.push(context);
    await context.bootstrap();
    // Four failures for the operator's username, each from its own address.
    for (let n = 0; n < 4; n++)
      await signIn(context, TEST_USERNAME, 'wrong password value', {
        remoteAddress: `10.3.0.${n}`,
      });
    hold = true;
    // 2 verifications run and 32 wait, each sign-in under its own username and address.
    const queued = Array.from({ length: 34 }, (_, n) =>
      signIn(context, `someone-${n}`, 'wrong password value', { remoteAddress: `10.4.0.${n}` }),
    );
    while (verifying < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The operator's fifth guess finds the queue full: refused for a second, and taken back.
    const refused = await signIn(context, TEST_USERNAME, 'wrong password value', {
      remoteAddress: '10.3.1.1',
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    hold = false;
    open();
    expect((await Promise.all(queued)).map((answer) => answer.statusCode)).toEqual(
      Array(34).fill(401),
    );
    // Had it counted, it would have been the fifth failure and locked the username.
    const signedIn = await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
      remoteAddress: '10.3.1.2',
    });
    expect(signedIn.statusCode).toBe(200);
  });

  it('says when to try again', async () => {
    const { context } = await clock();
    for (let attempt = 0; attempt < 5; attempt++)
      await signIn(context, TEST_USERNAME, 'wrong password value', { remoteAddress: '10.2.0.1' });
    const locked = await signIn(context, TEST_USERNAME, TEST_PASSWORD, {
      remoteAddress: '10.2.0.2',
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe(String(15 * 60));
  });
});

describe('step-up (R-G9)', () => {
  async function signedIn() {
    const { context, advance } = await clock();
    const session = await context.login();
    const workspaceId = context.storage.workspaces.listAuthorized(
      context.storage.users.findByNormalizedUsername(TEST_USERNAME)!.id,
    )[0]?.workspace.id;
    const command = (url: string, payload: unknown, caller = session) =>
      context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}${url}`,
        headers: {
          cookie: caller.cookie,
          'x-craftingtable-csrf': caller.csrfToken,
          origin: context.config.publicOrigin,
          'content-type': 'application/json',
        },
        payload: payload as Record<string, unknown>,
      });
    const stepUp = (password: string) =>
      context.app.inject({
        method: 'POST',
        url: '/api/auth/step-up',
        headers: {
          cookie: session.cookie,
          'x-craftingtable-csrf': session.csrfToken,
          origin: context.config.publicOrigin,
          'content-type': 'application/json',
        },
        payload: { password },
      });
    return { context, advance, session, command, stepUp };
  }
  const refusedForStepUp = (response: { statusCode: number; json: () => unknown }) =>
    response.statusCode === 403 &&
    (response.json() as { error?: { reason?: string } }).error?.reason === 'step-up-required';
  const finalization = '/finalizations/00000000-0000-4000-8000-000000000000/control';

  it('asks for the password again before a command that sets an unrestricted permission mode, anywhere in its body', async () => {
    const { command } = await signedIn();
    expect(
      refusedForStepUp(
        await command('/work-items/00000000-0000-4000-8000-000000000000/runs', {
          backend: 'claude-code',
          permissionMode: 'unrestricted',
        }),
      ),
    ).toBe(true);
    // Nested, as in a cycle's profiles or a saved profile set.
    expect(
      refusedForStepUp(
        await command('/run-profiles', {
          profiles: [{ name: 'p', settings: { permissionMode: 'unrestricted' } }],
        }),
      ),
    ).toBe(true);
    // Any other mode is not asked about.
    expect(
      refusedForStepUp(
        await command('/work-items/00000000-0000-4000-8000-000000000000/runs', {
          backend: 'claude-code',
          permissionMode: 'auto',
        }),
      ),
    ).toBe(false);
  });

  it('asks before final promotion, and only before that control', async () => {
    const { command } = await signedIn();
    expect(refusedForStepUp(await command(finalization, { action: 'merge' }))).toBe(true);
    expect(refusedForStepUp(await command(finalization, { action: 'pause' }))).toBe(false);
  });

  it('lets the session through for 10 minutes once the password is given again', async () => {
    const { context, advance, command, stepUp } = await signedIn();
    const wrong = await stepUp('not the password');
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.reason).toBe('step-up-failed');
    expect(refusedForStepUp(await command(finalization, { action: 'merge' }))).toBe(true);
    const right = await stepUp(TEST_PASSWORD);
    expect(right.statusCode, right.body).toBe(200);
    expect(refusedForStepUp(await command(finalization, { action: 'merge' }))).toBe(false);
    // Another session of the same user is not stepped up.
    const other = await context.login();
    expect(refusedForStepUp(await command(finalization, { action: 'merge' }, other))).toBe(true);
    advance(9 * MINUTE);
    expect(refusedForStepUp(await command(finalization, { action: 'merge' }))).toBe(false);
    advance(MINUTE);
    expect(refusedForStepUp(await command(finalization, { action: 'merge' }))).toBe(true);
    expect(auditActions(context)).toEqual(
      expect.arrayContaining(['auth.step-up.failed', 'auth.step-up']),
    );
  });

  it('asks before work under stored settings granting unrestricted, and before a merge into the default branch (R-G9 review)', async () => {
    const { context, command } = await signedIn();
    const services = context.services;
    const id = '00000000-0000-4000-8000-000000000000';
    const granting = { profiles: { implement: { permissionMode: 'unrestricted' } } };
    const roadmap = vi.spyOn(services.roadmapService, 'storedWork').mockReturnValue(granting);
    const cycle = vi.spyOn(services.workCycleService, 'storedWork').mockReturnValue(granting);
    const finalizationWork = vi
      .spyOn(services.finalizationService, 'storedWork')
      .mockReturnValue({ cycle: granting });
    const target = vi
      .spyOn(services.executionService, 'mergesIntoDefaultBranch')
      .mockReturnValue(true);
    const controls = [`/roadmaps/${id}/control`, `/cycles/${id}/control`, finalization];
    for (const url of controls) {
      expect(refusedForStepUp(await command(url, { action: 'resume' })), url).toBe(true);
      // Stopping work never asks.
      for (const action of ['pause', 'stop', 'abandon'])
        expect(refusedForStepUp(await command(url, { action })), `${url} ${action}`).toBe(false);
    }
    expect(refusedForStepUp(await command(`/worktrees/${id}/merge`, {}))).toBe(true);
    // The routes ask about the record they name.
    expect(roadmap).toHaveBeenCalledWith(expect.any(String), id);
    expect(cycle).toHaveBeenCalledWith(expect.any(String), id);
    expect(finalizationWork).toHaveBeenCalledWith(expect.any(String), id);
    expect(target).toHaveBeenCalledWith(expect.any(String), id);
    // Settings that grant nothing more, and a merge elsewhere, are not asked about.
    for (const spy of [roadmap, cycle]) spy.mockReturnValue({ permissionMode: 'auto' });
    finalizationWork.mockReturnValue({ cycle: { permissionMode: 'auto' } });
    target.mockReturnValue(false);
    for (const url of controls)
      expect(refusedForStepUp(await command(url, { action: 'resume' })), url).toBe(false);
    expect(refusedForStepUp(await command(`/worktrees/${id}/merge`, {}))).toBe(false);
  });

  it('counts failed step-ups toward the username lock', async () => {
    const { context, stepUp } = await signedIn();
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await stepUp('not the password')).statusCode).toBe(403);
    const locked = await stepUp(TEST_PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.reason).toBe('login-rate-limited');
    // The step-up that locked the username is audited as a lock (R-G9 review).
    expect(
      auditActions(context).filter((action) => action === 'auth.login.rate-limited'),
    ).toHaveLength(1);
  });
});
