import { randomUUID } from 'node:crypto';
import { asAuditEventId, asSessionId, normalizeUsername } from '@craftingtable/domain';
import type { CraftingTableStorage, StoredSession, StoredUser } from '@craftingtable/storage';
import {
  ConcurrencyLimit,
  type LoginAttempt,
  LoginThrottle,
  QueueFullError,
} from '../security/login-throttle.js';
import type { PasswordHasher } from '../security/password-hasher.js';
import type { SessionTokenService } from '../security/session-tokens.js';
import {
  AuthenticationError,
  ExecutionRequestError,
  LoginRateLimitedError,
  NotFoundError,
  StepUpFailedError,
  UnauthenticatedError,
} from './errors.js';

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 1024;

export interface CommandContext {
  readonly user: StoredUser;
  readonly session?: StoredSession;
}

export interface AuthContext extends CommandContext {
  readonly user: StoredUser;
  readonly session: StoredSession;
}

export interface LoginResult extends AuthContext {
  readonly rawSessionToken: string;
}

/** How long a step-up lasts (R-G9; operator decision 2026-10-05). */
export const STEP_UP_MS = 10 * 60_000;

export class AuthService {
  /** Failed sign-ins per username and client address (R-G9, operator decision 2026-10-05). */
  private readonly throttle: LoginThrottle;
  /** About 64 MiB per verification: at most 2 at once (R-G9, SEC-04). */
  private readonly verifications = new ConcurrencyLimit(2);
  /**
   * Sessions that gave their password again, and until when (R-G9; operator decision
   * 2026-10-05: 10 minutes, in memory, so a restart or sign-out clears it).
   */
  private readonly steppedUp = new Map<string, number>();

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: SessionTokenService,
    private readonly dummyPasswordHash: string,
    private readonly sessionLifetimeSeconds: number,
    private readonly now: () => Date = () => new Date(),
    /** A session with no request for this long ends (R-G9: 24 h). */
    private readonly sessionIdleSeconds = 86_400,
  ) {
    this.throttle = new LoginThrottle(now);
  }

  /** Checks a password with the bounded verifier; a full queue refuses for a second. */
  private async verify(encodedHash: string, password: string): Promise<boolean> {
    try {
      return await this.verifications.run(() => this.passwordHasher.verify(encodedHash, password));
    } catch (error) {
      if (error instanceof QueueFullError)
        throw new LoginRateLimitedError(new Date(this.now().getTime() + 1000), this.now());
      throw error;
    }
  }

  /**
   * Counts an attempt on these keys before its password is verified (R-G9 review: attempts made
   * at once cannot pass the limit), or refuses it while a key is locked.
   */
  private begin(keys: readonly string[]): LoginAttempt {
    const outcome = this.throttle.begin(keys);
    if ('refusedUntil' in outcome)
      throw new LoginRateLimitedError(new Date(outcome.refusedUntil), this.now());
    return outcome.attempt;
  }

  /** Verifies a counted attempt's password; one refused for load is taken back. */
  private async verifyAttempt(
    attempt: LoginAttempt,
    encodedHash: string,
    password: string,
  ): Promise<boolean> {
    try {
      return await this.verify(encodedHash, password);
    } catch (error) {
      attempt.withdrawn();
      throw error;
    }
  }

  async login(input: {
    readonly username: string;
    readonly password: string;
    readonly userAgent?: string;
    readonly requestId?: string;
    /** The client's address, as the route reads it; failures are also counted per address. */
    readonly address?: string;
  }): Promise<LoginResult> {
    const usernameNormalized = normalizeUsername(input.username);
    const keys = [
      `user:${usernameNormalized}`,
      ...(input.address === undefined ? [] : [`address:${input.address}`]),
    ];
    const attempt = this.begin(keys);
    const user = this.storage.users.findByNormalizedUsername(usernameNormalized);
    const valid = await this.verifyAttempt(
      attempt,
      user?.passwordHash ?? this.dummyPasswordHash,
      input.password,
    );
    if (!valid || user === undefined || user.status !== 'active') {
      // One row stands for a username's window of failures, and one for a lock (SEC-04).
      const { first, locked } = attempt;
      const actions = [
        ...(first ? ['auth.login.failed' as const] : []),
        ...(locked ? ['auth.login.rate-limited' as const] : []),
      ];
      if (actions.length)
        this.storage.transaction((tx) => {
          for (const action of actions)
            tx.audit.append({
              id: asAuditEventId(randomUUID()),
              occurredAt: this.now().toISOString(),
              actorKind: 'system',
              ...(user === undefined ? {} : { actorUserId: user.id }),
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              action,
              targetType: 'user',
              targetId: usernameNormalized,
              outcome: 'failed',
              metadata: { usernameNormalized },
            });
        });
      throw new AuthenticationError();
    }
    attempt.succeeded();

    const token = this.tokenService.generate();
    const csrfToken = this.tokenService.generateCsrfToken();
    const createdAt = this.now();
    const expiresAt = new Date(
      createdAt.getTime() + this.sessionLifetimeSeconds * 1000,
    ).toISOString();
    const session = this.storage.transaction((tx) => {
      // Password verification yields; local recovery may have changed credentials meanwhile.
      const current = tx.users.findById(user.id);
      if (current?.status !== 'active' || current.passwordHash !== user.passwordHash) {
        throw new AuthenticationError();
      }
      const inserted = tx.sessions.insert({
        id: asSessionId(randomUUID()),
        userId: user.id,
        tokenDigest: token.digest,
        csrfToken,
        createdAt: createdAt.toISOString(),
        expiresAt,
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent.slice(0, 256) }),
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: createdAt.toISOString(),
        actorKind: 'user',
        actorUserId: user.id,
        sessionId: inserted.id,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        action: 'auth.login',
        targetType: 'session',
        targetId: inserted.id,
        outcome: 'succeeded',
        resultingVersion: inserted.version,
      });
      return inserted;
    });
    return { user, session, rawSessionToken: token.raw };
  }

  /**
   * Whether a session can still be used: active, within its lifetime, and not idle (R-G9): no
   * request for the idle span ends it. The last request is recorded at most every
   * LAST_SEEN_WRITE_INTERVAL_MS, so a session may end up to that much sooner than the span.
   */
  private usable(session: StoredSession, now: Date): boolean {
    return (
      session.status === 'active' &&
      Date.parse(session.expiresAt) > now.getTime() &&
      now.getTime() - Date.parse(session.lastSeenAt) < this.sessionIdleSeconds * 1000
    );
  }

  authenticate(rawToken: string | undefined, touch = true): AuthContext {
    if (rawToken === undefined || rawToken.length === 0) {
      throw new UnauthenticatedError();
    }
    const session = this.storage.sessions.findByTokenDigest(this.tokenService.digest(rawToken));
    const now = this.now();
    if (session === undefined || !this.usable(session, now)) {
      throw new UnauthenticatedError();
    }
    const user = this.storage.users.findById(session.userId);
    if (user === undefined || user.status !== 'active') {
      throw new UnauthenticatedError();
    }
    if (touch && now.getTime() - Date.parse(session.lastSeenAt) >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.storage.sessions.touch(session.id, now.toISOString());
      return {
        user,
        session: this.storage.sessions.findById(session.id) as StoredSession,
      };
    }
    return { user, session };
  }

  /** The user's sessions, revoked ones included, but none that ended unrevoked (R-G9 review). */
  listSessions(context: AuthContext): readonly StoredSession[] {
    const now = this.now();
    return this.storage.sessions
      .listForUser(context.user.id)
      .filter((session) => session.status !== 'active' || this.usable(session, now));
  }

  /**
   * Changes the caller's password after re-verifying the current one, and
   * revokes every other session so a stolen cookie does not outlive the change.
   */
  async changePassword(
    context: AuthContext,
    input: { readonly currentPassword: string; readonly newPassword: string },
    requestId?: string,
  ): Promise<{ readonly revokedSessionCount: number }> {
    const valid = await this.verify(context.user.passwordHash, input.currentPassword);
    if (!valid) {
      throw new AuthenticationError();
    }
    const newBytes = Buffer.byteLength(input.newPassword, 'utf8');
    if (newBytes < MIN_PASSWORD_BYTES || newBytes > MAX_PASSWORD_BYTES) {
      throw new ExecutionRequestError(
        'invalid-request',
        `Password must be between ${MIN_PASSWORD_BYTES} and ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
      );
    }
    const passwordHash = await this.passwordHasher.hash(input.newPassword);
    const occurredAt = this.now().toISOString();
    return this.storage.transaction((tx) => {
      const current = tx.users.findById(context.user.id);
      const session = tx.sessions.findById(context.session.id);
      if (
        current?.status !== 'active' ||
        current.passwordHash !== context.user.passwordHash ||
        session?.status !== 'active'
      ) {
        throw new UnauthenticatedError();
      }
      const updated = tx.users.updatePassword({
        userId: context.user.id,
        passwordHash,
        occurredAt,
      });
      if (updated === undefined) {
        throw new UnauthenticatedError();
      }
      let revokedSessionCount = 0;
      for (const session of tx.sessions.listForUser(context.user.id)) {
        if (session.id === context.session.id || session.status !== 'active') {
          continue;
        }
        if (
          tx.sessions.revoke({ sessionId: session.id, occurredAt, reason: 'user-revoked' }) !==
          undefined
        ) {
          revokedSessionCount += 1;
        }
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'user.password-changed',
        targetType: 'user',
        targetId: context.user.id,
        outcome: 'succeeded',
        priorVersion: context.user.version,
        resultingVersion: updated.version,
        metadata: { revokedSessionCount },
      });
      return { revokedSessionCount };
    });
  }

  /**
   * The signed-in user's password again: on a match the session may run commands that need
   * step-up for `STEP_UP_MS`. A mismatch counts toward the username's sign-in lock (R-G9).
   */
  async stepUp(context: AuthContext, password: string, requestId?: string): Promise<Date> {
    const attempt = this.begin([`user:${context.user.usernameNormalized}`]);
    const valid = await this.verifyAttempt(attempt, context.user.passwordHash, password);
    const now = this.now();
    const locked = !valid && attempt.locked;
    const until = new Date(now.getTime() + STEP_UP_MS);
    if (valid) {
      attempt.succeeded();
      this.forgetSteppedUp(now.getTime());
      this.steppedUp.set(context.session.id, until.getTime());
    }
    this.storage.transaction((tx) => {
      for (const action of [
        valid ? ('auth.step-up' as const) : ('auth.step-up.failed' as const),
        ...(locked ? ['auth.login.rate-limited' as const] : []),
      ])
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt: now.toISOString(),
          actorKind: 'user',
          actorUserId: context.user.id,
          sessionId: context.session.id,
          ...(requestId === undefined ? {} : { requestId }),
          action,
          targetType: 'session',
          targetId: context.session.id,
          outcome: action === 'auth.step-up' ? 'succeeded' : 'failed',
          metadata: {},
        });
    });
    if (!valid) throw new StepUpFailedError();
    return until;
  }

  /** Whether this session gave its password again within `STEP_UP_MS`. */
  isSteppedUp(context: AuthContext): boolean {
    return (this.steppedUp.get(context.session.id) ?? 0) > this.now().getTime();
  }

  private forgetSteppedUp(at: number): void {
    for (const [session, until] of this.steppedUp) if (until <= at) this.steppedUp.delete(session);
  }

  logout(context: AuthContext, requestId?: string): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      const revoked = tx.sessions.revoke({
        sessionId: context.session.id,
        occurredAt,
        reason: 'logout',
      });
      if (revoked !== undefined) {
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt,
          actorKind: 'user',
          actorUserId: context.user.id,
          sessionId: context.session.id,
          ...(requestId === undefined ? {} : { requestId }),
          action: 'auth.logout',
          targetType: 'session',
          targetId: context.session.id,
          outcome: 'succeeded',
          priorVersion: context.session.version,
          resultingVersion: revoked.version,
        });
      }
    });
  }

  revokeSession(context: AuthContext, targetSessionId: StoredSession['id'], requestId?: string) {
    const target = this.storage.sessions.findById(targetSessionId);
    if (target === undefined || target.userId !== context.user.id) {
      throw new NotFoundError();
    }
    const occurredAt = this.now().toISOString();
    const revoked = this.storage.transaction((tx) => {
      const result = tx.sessions.revoke({
        sessionId: target.id,
        occurredAt,
        reason: 'user-revoked',
      });
      if (result !== undefined) {
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt,
          actorKind: 'user',
          actorUserId: context.user.id,
          sessionId: context.session.id,
          ...(requestId === undefined ? {} : { requestId }),
          action: 'auth.session.revoked',
          targetType: 'session',
          targetId: target.id,
          outcome: 'succeeded',
          priorVersion: target.version,
          resultingVersion: result.version,
        });
      }
      return result;
    });
    return {
      revokedSessionId: target.id,
      currentSessionRevoked: target.id === context.session.id,
      session: revoked ?? target,
    };
  }
}
