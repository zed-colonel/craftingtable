import type { SessionId, UserId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type { CreateSessionInput, SessionRepository, StoredSession } from '../types.js';

interface SessionRow {
  id: string;
  user_id: string;
  token_digest: string;
  csrf_token: string;
  status: 'active' | 'revoked';
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  version: number;
}

function mapSession(row: SessionRow): StoredSession {
  return {
    id: row.id as StoredSession['id'],
    userId: row.user_id as StoredSession['userId'],
    tokenDigest: row.token_digest,
    csrfToken: row.csrf_token,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.user_agent === null ? {} : { userAgent: row.user_agent }),
    version: row.version,
  };
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: CreateSessionInput): StoredSession {
    this.database
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token_digest, csrf_token, status, created_at, expires_at,
          last_seen_at, user_agent, version
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 1)`,
      )
      .run(
        input.id,
        input.userId,
        input.tokenDigest,
        input.csrfToken,
        input.createdAt,
        input.expiresAt,
        input.createdAt,
        input.userAgent ?? null,
      );
    return this.findById(input.id) as StoredSession;
  }

  findByTokenDigest(digest: string): StoredSession | undefined {
    const row = this.database
      .prepare(`SELECT * FROM sessions WHERE token_digest = ?`)
      .get(digest) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  findById(id: SessionId): StoredSession | undefined {
    const row = this.database.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  listForUser(userId: UserId): readonly StoredSession[] {
    return (
      this.database
        .prepare(`SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC`)
        .all(userId) as SessionRow[]
    ).map(mapSession);
  }

  revoke(input: {
    readonly sessionId: SessionId;
    readonly occurredAt: string;
    readonly reason: string;
  }): StoredSession | undefined {
    const result = this.database
      .prepare(
        `UPDATE sessions
         SET status = 'revoked', revoked_at = ?, revocation_reason = ?, version = version + 1
         WHERE id = ? AND status = 'active'`,
      )
      .run(input.occurredAt, input.reason, input.sessionId);
    return result.changes === 0 ? undefined : this.findById(input.sessionId);
  }

  touch(id: SessionId, occurredAt: string): void {
    this.database
      .prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ? AND status = 'active'`)
      .run(occurredAt, id);
  }
}
