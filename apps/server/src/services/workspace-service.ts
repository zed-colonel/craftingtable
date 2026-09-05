import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  type WorkspaceId,
  type WorkspaceRole,
} from '@craftingtable/domain';
import type {
  AuthorizedWorkspace,
  CraftingTableStorage,
  StorageRepositories,
} from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, ForbiddenError, NotFoundError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';

function slugify(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
    .replace(/-+$/g, '');
  return cleaned.length === 0 ? 'workspace' : cleaned;
}

export class WorkspaceService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly now: () => Date = () => new Date(),
    private readonly notifier: WorkspaceEventNotifier | undefined = undefined,
  ) {}

  /** Every authorized workspace with the counts its home-page card shows. */
  list(context: AuthContext) {
    return this.storage.readTransaction((tx) =>
      tx.workspaces.listAuthorized(context.user.id).map(({ workspace, membership }) => {
        const summary = tx.planning.queries.workspaceSummary(workspace.id);
        return {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          status: workspace.status,
          role: membership.role,
          projectCount: summary.projectCount,
          admittedCount: summary.admittedCount,
          completedCount: summary.completedCount,
          liveRunCount: tx.execution.runs.countLive(workspace.id),
          projects: tx.planning.queries.projectSummaries(workspace.id, 50).map((project) => ({
            id: project.id,
            name: project.name,
            admittedCount: project.admittedCount,
            completedCount: project.completedCount,
            proposedCount: project.proposedCount,
          })),
        };
      }),
    );
  }

  /** Creates a workspace owned by the caller. */
  create(context: AuthContext, name: string, requestId?: string) {
    const occurredAt = this.now().toISOString();
    const workspaceId = asWorkspaceId(randomUUID());
    const trimmed = name.trim();
    const workspace = this.storage.transaction((tx) => {
      const base = slugify(trimmed);
      let slug = base;
      for (let attempt = 2; tx.workspaces.slugExists(slug); attempt += 1) {
        slug = `${base}-${attempt}`;
      }
      const created = tx.workspaces.insert({
        id: workspaceId,
        name: trimmed,
        slug,
        createdByUserId: context.user.id,
        occurredAt,
      });
      const membership = tx.workspaces.insertMembership({
        id: asWorkspaceMembershipId(randomUUID()),
        workspaceId,
        userId: context.user.id,
        role: 'owner',
        occurredAt,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'workspace.created',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        resultingVersion: created.version,
        metadata: { name: created.name, slug: created.slug },
      });
      tx.workspaceEvents.appendWorkspaceCreated({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        name: created.name,
        slug: created.slug,
      });
      return {
        id: created.id,
        name: created.name,
        slug: created.slug,
        status: created.status,
        role: membership.role,
      };
    });
    this.notifier?.notify();
    return workspace;
  }

  /** Renames a workspace; owners only. */
  rename(context: AuthContext, workspaceId: WorkspaceId, name: string, requestId?: string) {
    const authorized = this.requireRole(context, workspaceId, ['owner'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ExecutionRequestError('invalid-request', 'Workspace name must not be empty');
    }
    const summary = (workspace: AuthorizedWorkspace['workspace']) => ({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      status: workspace.status,
      role: authorized.membership.role,
    });
    if (authorized.workspace.name === trimmed) {
      return { workspace: summary(authorized.workspace), changed: false };
    }
    const occurredAt = this.now().toISOString();
    const renamed = this.storage.transaction((tx) => {
      const updated = tx.workspaces.rename({ workspaceId, name: trimmed, occurredAt });
      if (updated === undefined) {
        throw new NotFoundError();
      }
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'workspace.updated',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        priorVersion: authorized.workspace.version,
        resultingVersion: updated.version,
        metadata: { name: updated.name, previousName: authorized.workspace.name },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        kind: 'workspace-updated',
        payload: {
          name: updated.name,
          priorVersion: authorized.workspace.version,
          resultingVersion: updated.version,
        },
      });
      return updated;
    });
    this.notifier?.notify();
    return { workspace: summary(renamed), changed: true };
  }

  /**
   * Snapshot plus planning summaries.
   *
   * Every count and `asOfSequence` are read inside the *same* deferred
   * transaction, so the browser can never see counts from one instant paired
   * with a cursor from another (CT03-A48).
   */
  snapshot(context: AuthContext, workspaceId: WorkspaceId, requestId?: string) {
    const snapshot = this.storage.readTransaction((tx) => {
      const authorized = tx.workspaces.findAuthorized(context.user.id, workspaceId);
      if (authorized === undefined) {
        return undefined;
      }
      const asOfSequence = tx.workspaceEvents.maxSequence();
      const planning = tx.planning.queries.workspaceSummary(workspaceId);
      return {
        workspace: {
          id: authorized.workspace.id,
          name: authorized.workspace.name,
          slug: authorized.workspace.slug,
          status: authorized.workspace.status,
          role: authorized.membership.role,
        },
        asOfSequence,
        statusSummary: {
          needsAttention: planning.importAttentionCount,
          active: planning.admittedCount,
          planningReady: planning.planningReadyCount,
          dependencyBlocked: planning.dependencyBlockedCount,
          completed: planning.completedCount,
          liveRuns: tx.execution.runs.countLive(workspaceId),
        },
        planningSummary: planning,
        projects: tx.planning.queries.projectSummaries(workspaceId, 50),
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

  /**
   * Requires membership *and* one of the given roles.
   *
   * A non-member gets the same 404 a missing workspace does, preserving CT-02's
   * non-disclosure posture. A member with an insufficient role gets 403: they
   * already know the workspace exists, so there is nothing to conceal.
   */
  requireRole(
    context: AuthContext,
    workspaceId: WorkspaceId,
    roles: readonly WorkspaceRole[],
    options: { readonly requestId?: string } = {},
  ): AuthorizedWorkspace {
    const authorized = this.storage.workspaces.findAuthorized(context.user.id, workspaceId);
    if (authorized === undefined) {
      this.recordDenied(context, workspaceId, options.requestId);
      throw new NotFoundError();
    }
    if (!roles.includes(authorized.membership.role)) {
      throw new ForbiddenError();
    }
    return authorized;
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
