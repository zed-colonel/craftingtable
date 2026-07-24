import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  asWorkContractDraftId,
  type WorkContractDraft,
  type WorkItem,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { projectWorkContractDraft } from '@craftingtable/planning';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { NotFoundError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export interface AdmissionResult {
  readonly workItem: WorkItem;
  readonly draft: WorkContractDraft;
  /** False when the item was already admitted and this call changed nothing. */
  readonly admitted: boolean;
}

export class WorkItemService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Admits a proposed work item into the operator's agenda.
   *
   * Admission is explicit, attributable, and idempotent. It is *not* execution
   * readiness: a dependency-blocked item may be admitted, its blockers remain
   * visible, and nothing becomes runnable (CT-03 §5.12, CT03-I10).
   */
  admit(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    requestId?: string,
  ): AdmissionResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });

    const existing = this.storage.readTransaction((tx) => {
      const item = tx.planning.workItems.find(workspaceId, workItemId);
      if (item === undefined) {
        return undefined;
      }
      return { item, draft: tx.planning.drafts.findForWorkItem(workspaceId, workItemId) };
    });
    if (existing === undefined) {
      throw new NotFoundError();
    }
    // A repeat writes nothing at all: no audit row, no event, no second draft.
    if (existing.item.status === 'admitted' && existing.draft !== undefined) {
      return { workItem: existing.item, draft: existing.draft, admitted: false };
    }

    const occurredAt = this.now().toISOString();
    const committed = this.storage.transaction((tx): AdmissionResult => {
      const item = tx.planning.workItems.find(workspaceId, workItemId);
      if (item === undefined) {
        throw new NotFoundError();
      }
      // Re-read inside the write lock: a concurrent admission may have landed
      // between the read above and this transaction.
      const already = tx.planning.drafts.findForWorkItem(workspaceId, workItemId);
      if (item.status === 'admitted' && already !== undefined) {
        return { workItem: item, draft: already, admitted: false };
      }

      const admittedItem = tx.planning.workItems.admit({
        workItemId,
        workspaceId,
        admittedAt: occurredAt,
        admittedByUserId: context.user.id,
      });
      if (admittedItem === undefined) {
        throw new NotFoundError();
      }

      const rows = tx.planning.workItems.listForVersion(workspaceId, item.planVersionId);
      const row = rows.find((candidate) => candidate.id === workItemId);
      if (row === undefined) {
        throw new NotFoundError();
      }
      const predecessors = tx.planning.dependencies.listPredecessors(workspaceId, workItemId);

      const document = projectWorkContractDraft({
        projectId: item.projectId,
        planVersionId: item.planVersionId,
        workItemId,
        item: {
          sourceId: row.sourceId,
          ordinal: row.ordinal,
          title: row.title,
          risk: row.risk,
          ...(row.phase === undefined ? {} : { phase: row.phase }),
          primaryAreas: row.primaryAreas,
          exitGate: row.exitGate,
          requiredDependencies: predecessors
            .filter((entry) => entry.kind === 'required')
            .map((entry) => entry.sourceId),
          recommendedDependencies: predecessors
            .filter((entry) => entry.kind === 'recommended')
            .map((entry) => entry.sourceId),
          sourceFields: row.sourceFields,
        },
        requiredDependencies: predecessors
          .filter((entry) => entry.kind === 'required')
          .map((entry) => ({
            sourceId: entry.sourceId,
            title: entry.title,
            status: entry.status,
          })),
        recommendedDependencies: predecessors
          .filter((entry) => entry.kind === 'recommended')
          .map((entry) => ({
            sourceId: entry.sourceId,
            title: entry.title,
            status: entry.status,
          })),
      });

      const draft = tx.planning.drafts.insert({
        id: asWorkContractDraftId(randomUUID()),
        workspaceId,
        projectId: item.projectId,
        planVersionId: item.planVersionId,
        workItemId,
        document: document as never,
        createdAt: occurredAt,
        createdByUserId: context.user.id,
      });

      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'work-item.admitted',
        targetType: 'work-item',
        targetId: workItemId,
        outcome: 'succeeded',
        priorVersion: item.version,
        resultingVersion: admittedItem.version,
        // Bounded, derived metadata only: no source artifacts or tokens.
        metadata: {
          sourceWorkItemId: row.sourceId,
          planVersionId: item.planVersionId,
          blockedAtAdmission: row.blockerSourceIds.length > 0,
        },
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        action: 'work-contract-draft.created',
        targetType: 'work-contract-draft',
        targetId: draft.id,
        outcome: 'succeeded',
        metadata: { workItemId, completeness: 'incomplete' },
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
          sourceWorkItemId: row.sourceId,
          workContractDraftId: draft.id,
        },
      });

      return { workItem: admittedItem, draft, admitted: true };
    });

    if (committed.admitted) {
      // After commit, never inside it (CT03-I12).
      this.notifier.notify();
    }
    return committed;
  }
}
