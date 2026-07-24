import type { UserId } from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type { CreateUserInput, StoredUser, UserRepository } from '../types.js';

interface UserRow {
  id: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
  version: number;
}

function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id as StoredUser['id'],
    username: row.username,
    usernameNormalized: row.username_normalized,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly database: Database.Database) {}

  count(): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM users`).get() as {
      count: number;
    };
    return row.count;
  }

  insert(input: CreateUserInput): StoredUser {
    this.database
      .prepare(
        `INSERT INTO users (
          id, username, username_normalized, password_hash, status,
          created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
      )
      .run(
        input.id,
        input.username,
        input.usernameNormalized,
        input.passwordHash,
        input.occurredAt,
        input.occurredAt,
      );
    return this.findById(input.id) as StoredUser;
  }

  findByNormalizedUsername(username: string): StoredUser | undefined {
    const row = this.database
      .prepare(`SELECT * FROM users WHERE username_normalized = ?`)
      .get(username) as UserRow | undefined;
    return row === undefined ? undefined : mapUser(row);
  }

  findById(id: UserId): StoredUser | undefined {
    const row = this.database.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
      | UserRow
      | undefined;
    return row === undefined ? undefined : mapUser(row);
  }
}
