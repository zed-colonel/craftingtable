import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  type WorkItem,
  type WorkItemId,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export interface AdmissionResult {
  readonly workItem: WorkItem;
  /** False when the item was already admitted and this call changed nothing. */
  readonly admitted: boolean;
}

export interface CompletionResult {
  readonly workItem: WorkItem;
  /** False when the item was already completed and this call changed nothing. */
  readonly completed: boolean;
}

/**
 * Work item lifecycle commands: admission, removal from the agenda, and completion.
 *
 * Completion is usually a side effect of merging a worktree (see
 * `ExecutionService.mergeWorktree`), which calls `completeWithin` inside its
 * own transaction; the standalone command exists for work finished by hand.
 */
export class WorkItemService {
  private readonly preparing = new Set<WorkItemId>();

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Admits a proposed work item into the operator's agenda.
   *
   * Admission is explicit, attributable, and idempotent. It does not gate
   * execution: a dependency-blocked item may be admitted and its blockers stay
   * visible; delegation is governed by worktrees and runs, not by this flag.
   */
  admit(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ): AdmissionResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });

    const occurredAt = this.now().toISOString();
    const committed = this.storage.transaction((tx): AdmissionResult => {
      const item = tx.planning.workItems.find(workspaceId, workItemId);
      if (item === undefined) {
        throw new NotFoundError();
      }
      // A repeat writes nothing at all: no audit row, no event.
      if (item.status !== 'proposed') {
        return { workItem: item, admitted: false };
      }
      const admittedItem = tx.planning.workItems.admit({
        workItemId,
        workspaceId,
        admittedAt: occurredAt,
        admittedByUserId: context.user.id,
      });
      if (admittedItem === undefined) {
        return { workItem: item, admitted: false };
      }
      const row = tx.planning.workItems
        .listForVersion(workspaceId, item.planVersionId)
        .find((candidate) => candidate.id === workItemId);
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: context.session === undefined ? 'system' : 'user',
        actorUserId: context.user.id,
        ...(context.session === undefined ? {} : { sessionId: context.session.id }),
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'work-item.admitted',
        targetType: 'work-item',
        targetId: workItemId,
        outcome: 'succeeded',
        priorVersion: item.version,
        resultingVersion: admittedItem.version,
        metadata: {
          sourceWorkItemId: item.sourceId,
          planVersionId: item.planVersionId,
          blockedAtAdmission: (row?.blockerSourceIds.length ?? 0) > 0,
        },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        projectId: item.projectId,
        workItemId,
        kind: 'work-item-admitted',
        payload: {
          projectId: item.projectId,
          planVersionId: item.planVersionId,
          workItemId,
          sourceWorkItemId: item.sourceId,
        },
      });
      return { workItem: admittedItem, admitted: true };
    });

    if (committed.admitted) {
      this.notifier.notify();
    }
    return committed;
  }

  async duringWorktreeCreation<T>(id: WorkItemId, create: () => Promise<T>): Promise<T> {
    if (this.preparing.has(id))
      throw new ExecutionRequestError(
        'conflict',
        'A worktree is already being prepared for this item.',
      );
    this.preparing.add(id);
    try {
      return await create();
    } finally {
      this.preparing.delete(id);
    }
  }

  agendaRemoval(tx: StorageRepositories, item: WorkItem) {
    const workspaceId = item.workspaceId;
    let reason: string | undefined;
    if (item.status !== 'admitted') reason = 'Only items in the agenda can be removed.';
    else if (this.preparing.has(item.id)) reason = 'A worktree is being prepared for this item.';
    else if (
      tx.execution.runs.listForWorkItem(workspaceId, item.id).length ||
      tx.execution.cycles.list(workspaceId).some((c) => c.workItemId === item.id)
    )
      reason = 'This item has run or automation history and has already started.';
    else if (
      tx.execution.worktrees
        .listForWorkItem(workspaceId, item.id)
        .some((w) => w.status === 'active')
    )
      reason = 'Remove the unused worktree before removing this item from the agenda.';
    else if (
      tx.roadmaps
        .list(workspaceId)
        .some(
          (r) =>
            !['draft', 'completed', 'stopped'].includes(r.status) &&
            r.definition.entries.some((e) => e.workItemId === item.id),
        )
    )
      reason = 'Stop the roadmap that owns this item before removing it from the agenda.';
    return {
      allowed: reason === undefined,
      expectedVersion: item.version,
      ...(reason ? { reason } : {}),
    };
  }

  removeFromAgenda(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    expectedVersion: number,
    requestId?: string,
  ) {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId ? { requestId } : {}),
    });
    const result = this.storage.transaction((tx) => {
      const item = tx.planning.workItems.find(workspaceId, workItemId);
      if (!item) throw new NotFoundError();
      if (item.status === 'proposed') return { workItem: item, removed: false };
      if (item.version !== expectedVersion)
        throw new ExecutionRequestError(
          'conflict',
          'This item changed. Refresh before removing it from the agenda.',
        );
      const eligibility = this.agendaRemoval(tx, item);
      if (!eligibility.allowed)
        throw new ExecutionRequestError(
          'conflict',
          eligibility.reason ?? 'This item cannot be removed from the agenda.',
        );
      const updated = tx.planning.workItems.removeFromAgenda(
        workspaceId,
        workItemId,
        expectedVersion,
      );
      if (!updated)
        throw new ExecutionRequestError(
          'conflict',
          'This item changed. Refresh before removing it from the agenda.',
        );
      const occurredAt = this.now().toISOString();
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId ? { requestId } : {}),
        action: 'work-item.removed-from-agenda',
        targetType: 'work-item',
        targetId: workItemId,
        outcome: 'succeeded',
        priorVersion: item.version,
        resultingVersion: updated.version,
        metadata: {
          sourceWorkItemId: item.sourceId,
          planVersionId: item.planVersionId,
          admittedAt: item.admittedAt ?? null,
        },
      });
      tx.workspaceEvents.appendEvent({
        id: asEventId(randomUUID()),
        occurredAt,
        workspaceId,
        actorUserId: context.user.id,
        projectId: item.projectId,
        workItemId,
        kind: 'work-item-removed-from-agenda',
        payload: {
          projectId: item.projectId,
          planVersionId: item.planVersionId,
          workItemId,
          sourceWorkItemId: item.sourceId,
        },
      });
      return { workItem: updated, removed: true };
    });
    if (result.removed) this.notifier.notify();
    return result;
  }

  /** Marks an admitted work item as completed without a merge. */
  complete(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ): CompletionResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) =>
      this.completeWithin(tx, {
        context,
        workspaceId,
        workItemId,
        occurredAt,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
    if (result.completed) {
      this.notifier.notify();
    }
    return result;
  }

  /**
   * Completion inside a caller's transaction, so a merge can record the
   * worktree removal, the merge, and the completion atomically.
   */
  completeWithin(
    tx: StorageRepositories,
    input: {
      readonly context: CommandContext;
      readonly workspaceId: WorkspaceId;
      readonly workItemId: WorkItemId;
      readonly occurredAt: string;
      readonly requestId?: string;
      readonly worktreeId?: WorktreeId;
      readonly mergeSha?: string;
    },
  ): CompletionResult {
    const { context, workspaceId, workItemId, occurredAt } = input;
    const item = tx.planning.workItems.find(workspaceId, workItemId);
    if (item === undefined) {
      throw new NotFoundError();
    }
    if (item.status === 'completed') {
      return { workItem: item, completed: false };
    }
    if (item.status !== 'admitted') {
      throw new ExecutionRequestError(
        'conflict',
        'Only an admitted work item can be completed; admit it into the agenda first',
      );
    }
    const completedItem = tx.planning.workItems.complete({
      workItemId,
      workspaceId,
      projectId: item.projectId,
      completedAt: occurredAt,
      completedByUserId: context.user.id,
      ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
      ...(input.mergeSha === undefined ? {} : { mergeSha: input.mergeSha }),
    });
    if (completedItem === undefined) {
      return { workItem: item, completed: false };
    }
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt,
      actorKind: context.session ? 'user' : 'system',
      actorUserId: context.user.id,
      ...(context.session ? { sessionId: context.session.id } : {}),
      workspaceId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      action: 'work-item.completed',
      targetType: 'work-item',
      targetId: workItemId,
      outcome: 'succeeded',
      metadata: {
        sourceWorkItemId: item.sourceId,
        ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
        ...(input.mergeSha === undefined ? {} : { mergeSha: input.mergeSha }),
      },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt,
      workspaceId,
      actorUserId: context.user.id,
      projectId: item.projectId,
      workItemId,
      kind: 'work-item-completed',
      payload: {
        projectId: item.projectId,
        workItemId,
        sourceWorkItemId: item.sourceId,
        ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
        ...(input.mergeSha === undefined ? {} : { mergeSha: input.mergeSha }),
      },
    });
    return { workItem: completedItem, completed: true };
  }
}
