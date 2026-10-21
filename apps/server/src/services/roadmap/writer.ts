/**
 * The roadmap's write path (R-B7): a write as one compare-and-set with its audit row and
 * workspace event, the reason a pass keeps, a recovery round's update, and the delegating user's
 * authority, which every write of a scheduled step asks first.
 */
import { randomUUID } from 'node:crypto';
import { activeEditor, activeUser } from '../authority-policy.js';
import {
  type JsonValue,
  asAuditEventId,
  asEventId,
  type Roadmap,
  type RoadmapAttempt,
  type RoadmapId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from '../auth-service.js';
import { ConcurrentModificationError, NotFoundError } from '../errors.js';
import { roadmapWaitAudit } from '../operator-wait-service.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { RoadmapState } from './state.js';
import { conflict, type RoadmapChanges } from './shared.js';

export class RoadmapWriter {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly state: RoadmapState,
  ) {}

  find(workspaceId: WorkspaceId, id: RoadmapId): Roadmap {
    const roadmap = this.storage.roadmaps.find(workspaceId, id);
    if (!roadmap) throw new NotFoundError();
    return roadmap;
  }

  change(
    roadmap: Roadmap,
    changes: RoadmapChanges,
    action = 'advance',
    context?: AuthContext,
    /** What a release cleared, recorded in its audit row (R-C10's follow-up, decision 2). */
    release?: Readonly<Record<string, JsonValue>>,
  ): Roadmap {
    const merged: Roadmap = {
      ...roadmap,
      ...changes,
      reason: (changes.reason ?? roadmap.reason).slice(0, 4000),
      version: roadmap.version + 1,
      updatedAt: this.state.now().toISOString(),
    };
    // Attention describes a needs-attention roadmap only; any other status clears it (R-A3).
    const { attention: _cleared, ...unattended } = merged;
    const updated: Roadmap = merged.status === 'needs-attention' ? merged : unattended;
    this.storage.transaction((tx) =>
      this.persist(tx, updated, roadmap.version, action, context, release),
    );
    this.notifier.notify();
    return updated;
  }

  persist(
    tx: StorageRepositories,
    roadmap: Roadmap,
    expectedVersion: number,
    action: string,
    context?: AuthContext,
    release?: Readonly<Record<string, JsonValue>>,
  ): void {
    if (!tx.roadmaps.save(roadmap, expectedVersion))
      throw new ConcurrentModificationError('Roadmap changed during this operation.');
    const actorUserId = context?.user.id ?? roadmap.delegatedByUserId ?? roadmap.createdByUserId;
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: roadmap.updatedAt,
      workspaceId: roadmap.workspaceId,
      actorKind: context ? 'user' : 'system',
      actorUserId,
      ...(context ? { sessionId: context.session.id } : {}),
      action: 'roadmap.updated',
      targetType: 'roadmap',
      targetId: roadmap.id,
      outcome: 'succeeded',
      resultingVersion: roadmap.version,
      metadata: {
        action,
        status: roadmap.status,
        revision: roadmap.definition.revision,
        reason: roadmap.reason,
        ...roadmapWaitAudit(roadmap),
        ...(release ? { release } : {}),
        ...(action === 'prepare-decision'
          ? {
              preparationId: roadmap.decisionPreparations?.at(-1)?.id,
              checkpointId: roadmap.decisionPreparations?.at(-1)?.checkpointId,
              runId: roadmap.decisionPreparations?.at(-1)?.runId,
              // A standing preparation is the controller's, acting as the grantor (R-C3b).
              preparedByUserId: roadmap.decisionPreparations?.at(-1)?.createdByUserId,
            }
          : {}),
        ...(action === 'apply-delegation'
          ? {
              delegationId: roadmap.delegationAssignments?.at(-1)?.id,
              entryCount: roadmap.delegationAssignments?.at(-1)?.entryIds.length,
              rationale: roadmap.delegationAssignments?.at(-1)?.rationale,
            }
          : {}),
        ...(action === 'apply-agent-profiles'
          ? {
              assignmentId: roadmap.agentAssignments?.at(-1)?.id,
              entryCount: roadmap.agentAssignments?.at(-1)?.entryIds.length,
            }
          : {}),
        ...(action === 'configure-decision-preparation' && roadmap.decisionPreparationGrant
          ? {
              preparationEnabled: roadmap.decisionPreparationGrant.enabled,
              preparationMinutes: roadmap.decisionPreparationGrant.minutes,
              preparationConcurrency: roadmap.decisionPreparationGrant.maxConcurrent,
            }
          : {}),
        ...(action === 'configure-reverification' && roadmap.reverificationGrant
          ? { reverificationEnabled: roadmap.reverificationGrant.enabled }
          : {}),
        ...(action === 'configure-scope-recovery' && roadmap.scopeRecovery
          ? {
              recoveryEnabled: roadmap.scopeRecovery.enabled,
              maxRecoveryRoundsPerParent: roadmap.scopeRecovery.maxRoundsPerParent,
            }
          : {}),
      },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: roadmap.updatedAt,
      workspaceId: roadmap.workspaceId,
      actorUserId,
      kind: 'roadmap-changed',
      payload: { roadmapId: roadmap.id, status: roadmap.status, reason: roadmap.reason },
    });
  }

  reason(roadmap: Roadmap, reason: string): void {
    const bounded = reason.slice(0, 4000);
    if (roadmap.reason !== bounded) this.change(roadmap, { reason: bounded });
  }

  updateRecovery(roadmap: Roadmap, attempt: RoadmapAttempt, changes: Partial<RoadmapAttempt>) {
    return this.change(roadmap, {
      attempts: roadmap.attempts.map((a) => (a.id === attempt.id ? { ...a, ...changes } : a)),
    });
  }

  /** The delegating user, while active and an owner or editor (R-B7: the one authority rule). */
  authority(roadmap: Roadmap): CommandContext {
    const user = activeUser(this.storage, roadmap.delegatedByUserId);
    if (!user) conflict('The initiating user is no longer active.');
    if (!activeEditor(this.storage, user.id, roadmap.workspaceId))
      conflict('The initiating user no longer has permission to run this roadmap.');
    return { user };
  }
}
