import { randomUUID } from 'node:crypto';
import { asAuditEventId, normalizeUsername } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { PasswordHasher } from '../security/password-hasher.js';

/** Local administration only: authority is the OS user's access to the database. */
export class PasswordResetService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly hasher: PasswordHasher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reset(
    username: string,
    password: string,
  ): Promise<{ username: string; revokedSessionCount: number }> {
    const user = this.storage.users.findByNormalizedUsername(normalizeUsername(username));
    if (user === undefined || user.status !== 'active')
      throw new Error('No active user with that username');
    const passwordHash = await this.hasher.hash(password);
    const occurredAt = this.now().toISOString();
    return this.storage.transaction((tx) => {
      const current = tx.users.findById(user.id);
      if (current === undefined || current.status !== 'active')
        throw new Error('No active user with that username');
      const updated = tx.users.updatePassword({ userId: user.id, passwordHash, occurredAt });
      if (updated === undefined) throw new Error('Password reset failed');
      let revokedSessionCount = 0;
      for (const session of tx.sessions.listForUser(user.id)) {
        if (
          session.status === 'active' &&
          tx.sessions.revoke({ sessionId: session.id, occurredAt, reason: 'password-reset' }) !==
            undefined
        )
          revokedSessionCount += 1;
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'system',
        action: 'user.password-changed',
        targetType: 'user',
        targetId: user.id,
        outcome: 'succeeded',
        priorVersion: current.version,
        resultingVersion: updated.version,
        metadata: { method: 'local-admin-reset', revokedSessionCount },
      });
      return { username: updated.username, revokedSessionCount };
    });
  }
}
