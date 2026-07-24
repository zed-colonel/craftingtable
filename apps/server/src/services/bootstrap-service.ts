import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  normalizeUsername,
  type User,
  type Workspace,
  type WorkspaceEvent,
  type WorkspaceMembership,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { PasswordHasher } from '../security/password-hasher.js';
import { BootstrapRefusedError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';

export interface BootstrapResult {
  readonly user: User;
  readonly workspace: Workspace;
  readonly membership: WorkspaceMembership;
  readonly event: WorkspaceEvent;
}

export class BootstrapService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly passwordHasher: PasswordHasher,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async bootstrap(usernameInput: string, password: string): Promise<BootstrapResult> {
    const username = usernameInput.trim().normalize('NFKC');
    const usernameNormalized = normalizeUsername(username);
    if (username.length === 0 || username.length > 64) {
      throw new Error('Username must be between 1 and 64 characters');
    }

    if (this.storage.users.count() > 0) {
      this.appendRefusal();
      throw new BootstrapRefusedError();
    }

    const passwordHash = await this.passwordHasher.hash(password);
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      if (tx.users.count() > 0) {
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt,
          actorKind: 'system',
          action: 'admin.bootstrap.denied',
          targetType: 'installation',
          targetId: 'local',
          outcome: 'denied',
          metadata: { reason: 'user-already-exists' },
        });
        return undefined;
      }

      const userId = asUserId(randomUUID());
      const workspaceId = asWorkspaceId(randomUUID());
      const user = tx.users.insert({
        id: userId,
        username,
        usernameNormalized,
        passwordHash,
        occurredAt,
      });
      const workspace = tx.workspaces.insert({
        id: workspaceId,
        name: 'Default workspace',
        slug: 'default',
        createdByUserId: userId,
        occurredAt,
      });
      const membership = tx.workspaces.insertMembership({
        id: asWorkspaceMembershipId(randomUUID()),
        workspaceId,
        userId,
        role: 'owner',
        occurredAt,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'system',
        actorUserId: userId,
        workspaceId,
        action: 'admin.bootstrap',
        targetType: 'user',
        targetId: userId,
        outcome: 'succeeded',
        resultingVersion: user.version,
        metadata: { username },
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'system',
        actorUserId: userId,
        workspaceId,
        action: 'workspace.created',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        resultingVersion: workspace.version,
        metadata: { name: workspace.name, slug: workspace.slug },
      });
      const event = tx.workspaceEvents.appendWorkspaceCreated({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: userId,
        name: workspace.name,
        slug: workspace.slug,
      });
      return { user, workspace, membership, event };
    });

    if (result === undefined) {
      throw new BootstrapRefusedError();
    }
    this.notifier.notify();
    return result;
  }

  private appendRefusal(): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'system',
        action: 'admin.bootstrap.denied',
        targetType: 'installation',
        targetId: 'local',
        outcome: 'denied',
        metadata: { reason: 'user-already-exists' },
      });
    });
  }
}
