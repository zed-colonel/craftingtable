import { randomUUID } from 'node:crypto';
import { asAuditEventId, type WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { NotFoundError } from './errors.js';

export class WorkspaceService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(context: AuthContext) {
    return this.storage.workspaces
      .listAuthorized(context.user.id)
      .map(({ workspace, membership }) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        status: workspace.status,
        role: membership.role,
      }));
  }

  snapshot(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    const snapshot = this.storage.readTransaction((tx) => {
      const authorized = tx.workspaces.findAuthorized(context.user.id, workspaceId);
      if (authorized === undefined) {
        return undefined;
      }
      const asOfSequence = tx.workspaceEvents.maxSequence();
      return {
        workspace: {
          id: authorized.workspace.id,
          name: authorized.workspace.name,
          slug: authorized.workspace.slug,
          status: authorized.workspace.status,
          role: authorized.membership.role,
        },
        asOfSequence,
        statusSummary: { needsAttention: 0, active: 0, ready: 0, blocked: 0 },
        recentActivity: tx.workspaceEvents.listRecentAtOrBefore({
          workspaceId,
          asOfSequence,
          limit: 50,
        }),
      };
    });
    if (snapshot === undefined) {
      this.recordDenied(context, workspaceId, requestId);
      throw new NotFoundError();
    }
    return snapshot;
  }

  auditPage(
    context: AuthContext,
    workspaceId: WorkspaceId,
    options: { readonly limit: number; readonly before?: number; readonly requestId?: string },
  ) {
    const page = this.storage.readTransaction((tx) => {
      const authorized = tx.workspaces.findAuthorized(context.user.id, workspaceId);
      if (authorized === undefined || authorized.membership.role !== 'owner') {
        return undefined;
      }
      const records = tx.audit.listWorkspace({
        workspaceId,
        limit: options.limit + 1,
        ...(options.before === undefined ? {} : { before: options.before }),
      });
      const hasMore = records.length > options.limit;
      const visible = hasMore ? records.slice(0, options.limit) : records;
      const lastVisible = visible.at(-1);
      return {
        records: visible,
        ...(hasMore && lastVisible !== undefined ? { nextBefore: lastVisible.sequence } : {}),
      };
    });
    if (page === undefined) {
      this.recordDenied(context, workspaceId, options.requestId);
      throw new NotFoundError();
    }
    return page;
  }

  isAuthorized(context: AuthContext, workspaceId: WorkspaceId): boolean {
    return this.storage.workspaces.findAuthorized(context.user.id, workspaceId) !== undefined;
  }

  requireAuthorized(context: AuthContext, workspaceId: WorkspaceId, requestId?: string): void {
    if (!this.isAuthorized(context, workspaceId)) {
      this.recordDenied(context, workspaceId, requestId);
      throw new NotFoundError();
    }
  }

  private recordDenied(context: AuthContext, workspaceId: WorkspaceId, requestId?: string): void {
    const exists = this.storage.workspaces.exists(workspaceId);
    this.storage.transaction((tx: StorageRepositories) => {
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: this.now().toISOString(),
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        ...(exists ? { workspaceId } : {}),
        ...(requestId === undefined ? {} : { requestId }),
        action: 'workspace.access.denied',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'denied',
        metadata: {},
      });
    });
  }
}
