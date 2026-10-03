import { openDatabase } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { Argon2PasswordHasher } from '../../src/security/password-hasher.js';
import {
  createTestContext,
  FastTestPasswordHasher,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../test-support.js';
import { PasswordResetService } from '../../src/services/password-reset-service.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});
const newPassword = 'new café password 🔐';

it('resets without the old password, revokes all sessions, preserves the workspace and audits no secrets', async () => {
  const hasher = new Argon2PasswordHasher();
  const context = await createTestContext({ passwordHasher: hasher });
  contexts.push(context);
  await context.bootstrap();
  const first = await context.services.authService.login({
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
  });
  await context.services.authService.login({ username: TEST_USERNAME, password: TEST_PASSWORD });
  const workspaces = context.storage.workspaces.listAuthorized(first.user.id);
  const events = context.storage.workspaceEvents.count();
  const result = await new PasswordResetService(context.storage, hasher).reset(
    ` ${TEST_USERNAME.toUpperCase()} `,
    newPassword,
  );
  expect(result).toEqual({ username: TEST_USERNAME, revokedSessionCount: 2 });
  expect(
    context.storage.sessions
      .listForUser(first.user.id)
      .every((session) => session.status === 'revoked'),
  ).toBe(true);
  expect(() => context.services.authService.authenticate(first.rawSessionToken)).toThrow();
  await expect(
    context.services.authService.login({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  ).rejects.toThrow();
  await expect(
    context.services.authService.login({ username: TEST_USERNAME, password: newPassword }),
  ).resolves.toMatchObject({ user: { id: first.user.id } });
  expect(context.storage.workspaces.listAuthorized(first.user.id)).toEqual(workspaces);
  expect(context.storage.workspaceEvents.count()).toBe(events);
  const db = openDatabase(context.config.databasePath);
  try {
    const audit = db
      .prepare(
        "SELECT actor_kind, metadata_json FROM audit_events WHERE action = 'user.password-changed'",
      )
      .all();
    expect(audit).toEqual([
      {
        actor_kind: 'system',
        metadata_json: JSON.stringify({ method: 'local-admin-reset', revokedSessionCount: 2 }),
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(newPassword);
    expect(JSON.stringify(audit)).not.toContain('$argon2id$');
  } finally {
    db.close();
  }
});

it('refuses missing/disabled accounts and invalid passwords without changing credentials or sessions', async () => {
  const hasher = new Argon2PasswordHasher();
  const context = await createTestContext({ passwordHasher: hasher });
  contexts.push(context);
  await context.bootstrap();
  await context.login();
  const reset = new PasswordResetService(context.storage, hasher);
  const original = context.storage.users.findByNormalizedUsername(TEST_USERNAME);
  const audits = context.storage.audit.count();
  await expect(reset.reset('missing', newPassword)).rejects.toThrow(/No active user/);
  await expect(reset.reset(TEST_USERNAME, 'short')).rejects.toThrow(/between/);
  expect(context.storage.users.findByNormalizedUsername(TEST_USERNAME)).toEqual(original);
  expect(context.storage.audit.count()).toBe(audits);
  const db = openDatabase(context.config.databasePath);
  try {
    db.prepare("UPDATE users SET status = 'disabled'").run();
  } finally {
    db.close();
  }
  await expect(reset.reset(TEST_USERNAME, newPassword)).rejects.toThrow(/No active user/);
  expect(context.storage.users.findByNormalizedUsername(TEST_USERNAME)?.passwordHash).toBe(
    original?.passwordHash,
  );
});

it('rolls back the password and session revocations if auditing fails', async () => {
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  await context.login();
  const user = context.storage.users.findByNormalizedUsername(TEST_USERNAME);
  if (!user) throw new Error('Missing fixture');
  const sessions = context.storage.sessions.listForUser(user.id);
  const db = openDatabase(context.config.databasePath);
  try {
    db.exec(
      "CREATE TRIGGER reject_reset BEFORE INSERT ON audit_events WHEN NEW.action = 'user.password-changed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
  } finally {
    db.close();
  }
  await expect(
    new PasswordResetService(context.storage, new FastTestPasswordHasher()).reset(
      TEST_USERNAME,
      newPassword,
    ),
  ).rejects.toThrow(/audit unavailable/);
  expect(context.storage.users.findById(user.id)).toEqual(user);
  expect(context.storage.sessions.listForUser(user.id)).toEqual(sessions);
});

it('does not let an in-flight login using the old password outlive a reset', async () => {
  const fast = new FastTestPasswordHasher();
  let duringVerification: (() => Promise<void>) | undefined;
  const context = await createTestContext({
    passwordHasher: {
      hash: (password) => fast.hash(password),
      async verify(hash, password) {
        const valid = await fast.verify(hash, password);
        await duringVerification?.();
        return valid;
      },
    },
  });
  contexts.push(context);
  await context.bootstrap();
  duringVerification = async () => {
    await new PasswordResetService(context.storage, fast).reset(TEST_USERNAME, newPassword);
  };
  await expect(
    context.services.authService.login({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  ).rejects.toThrow();
  const user = context.storage.users.findByNormalizedUsername(TEST_USERNAME);
  if (!user) throw new Error('Missing fixture');
  expect(context.storage.sessions.listForUser(user.id)).toEqual([]);
});

it('does not let an in-flight password change overwrite local recovery', async () => {
  const fast = new FastTestPasswordHasher();
  let duringHash: (() => Promise<void>) | undefined;
  const context = await createTestContext({
    passwordHasher: {
      async hash(password) {
        await duringHash?.();
        return fast.hash(password);
      },
      verify: (hash, password) => fast.verify(hash, password),
    },
  });
  contexts.push(context);
  await context.bootstrap();
  const auth = await context.services.authService.login({
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
  });
  duringHash = async () => {
    await new PasswordResetService(context.storage, fast).reset(TEST_USERNAME, newPassword);
  };
  await expect(
    context.services.authService.changePassword(auth, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'concurrent change attempt',
    }),
  ).rejects.toThrow();
  expect(context.storage.users.findById(auth.user.id)?.passwordHash).toBe(
    await fast.hash(newPassword),
  );
});
