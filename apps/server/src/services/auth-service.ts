import { randomUUID } from 'node:crypto';
import { asAuditEventId, asSessionId, normalizeUsername } from '@craftingtable/domain';
import type { CraftingTableStorage, StoredSession, StoredUser } from '@craftingtable/storage';
import type { PasswordHasher } from '../security/password-hasher.js';
import type { SessionTokenService } from '../security/session-tokens.js';
import { AuthenticationError, NotFoundError, UnauthenticatedError } from './errors.js';

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface AuthContext {
  readonly user: StoredUser;
  readonly session: StoredSession;
}

export interface LoginResult extends AuthContext {
  readonly rawSessionToken: string;
}

export class AuthService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: SessionTokenService,
    private readonly dummyPasswordHash: string,
    private readonly sessionLifetimeSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async login(input: {
    readonly username: string;
    readonly password: string;
    readonly userAgent?: string;
    readonly requestId?: string;
  }): Promise<LoginResult> {
    const usernameNormalized = normalizeUsername(input.username);
    const user = this.storage.users.findByNormalizedUsername(usernameNormalized);
    const valid = await this.passwordHasher.verify(
      user?.passwordHash ?? this.dummyPasswordHash,
      input.password,
    );
    if (!valid || user === undefined || user.status !== 'active') {
      this.storage.transaction((tx) => {
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt: this.now().toISOString(),
          actorKind: 'system',
          ...(user === undefined ? {} : { actorUserId: user.id }),
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          action: 'auth.login.failed',
          targetType: 'user',
          targetId: usernameNormalized,
          outcome: 'failed',
          metadata: { usernameNormalized },
        });
      });
      throw new AuthenticationError();
    }

    const token = this.tokenService.generate();
    const csrfToken = this.tokenService.generateCsrfToken();
    const createdAt = this.now();
    const expiresAt = new Date(
      createdAt.getTime() + this.sessionLifetimeSeconds * 1000,
    ).toISOString();
    const session = this.storage.transaction((tx) => {
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

  authenticate(rawToken: string | undefined, touch = true): AuthContext {
    if (rawToken === undefined || rawToken.length === 0) {
      throw new UnauthenticatedError();
    }
    const session = this.storage.sessions.findByTokenDigest(this.tokenService.digest(rawToken));
    const now = this.now();
    if (
      session === undefined ||
      session.status !== 'active' ||
      Date.parse(session.expiresAt) <= now.getTime()
    ) {
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

  listSessions(context: AuthContext): readonly StoredSession[] {
    return this.storage.sessions.listForUser(context.user.id);
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
