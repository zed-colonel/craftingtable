import { randomUUID } from 'node:crypto';
import type { HostSchedulingStatus, SaveHostScheduling } from '@craftingtable/contracts';
import { asAgentRunId, asWorkspaceId, type WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError, ForbiddenError } from './errors.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export class HostSchedulingService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private authorize(context: AuthContext, workspaceId: WorkspaceId) {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    if (!this.storage.maintenance.ownsInstallation(context.user.id)) throw new ForbiddenError();
  }
  get(context: AuthContext, workspaceId: WorkspaceId): HostSchedulingStatus {
    this.authorize(context, workspaceId);
    const setting = this.storage.phaseScheduling.setting('local-verification');
    const cycles = this.storage.execution.cycles.list();
    const reservations = this.storage.phaseScheduling
      .active()
      .filter((r) => r.resourceKey === 'local-verification');
    const roadmaps = this.storage.roadmaps
      .list()
      .filter((r) => !['stopped', 'completed'].includes(r.status));
    return {
      version: setting.version,
      verificationCapacity: setting.capacity,
      developmentCapacity: this.storage.phaseScheduling.capacity('local-development'),
      source: setting.updatedAt ? 'saved-setting' : 'daemon-environment',
      updatedAt: setting.updatedAt,
      reservations: reservations.map((r) => {
        const cycle = cycles.find(
          (c) => c.workspaceId === r.workspaceId && c.worktreeId === r.worktreeId,
        );
        const tree = this.storage.execution.worktrees.find(
          asWorkspaceId(r.workspaceId),
          r.worktreeId as import('@craftingtable/domain').WorktreeId,
        );
        const run = this.storage.execution.runs.find(
          asWorkspaceId(r.workspaceId),
          asAgentRunId(r.ownerId),
        );
        return {
          id: r.id,
          workspaceId: r.workspaceId,
          workItemId: tree?.workItemId ?? null,
          runId: run?.id ?? null,
          label:
            cycle?.workItemSourceId ??
            tree?.executionScope?.sourceId ??
            tree?.branchName ??
            'Verification operation',
          phase: r.phase,
          acquiredAt: r.acquiredAt,
        };
      }),
      // Durable waits only: avoid recomputing the entire dependency graph on a settings read.
      waiting: cycles
        .filter((c) =>
          c.phaseWait?.blockers.some(
            (b) => b.kind === 'resource' && b.message.includes('local-verification'),
          ),
        )
        .map((c) => ({
          id: c.id,
          workspaceId: c.workspaceId,
          workItemId: c.workItemId ?? null,
          runId: null,
          label: c.workItemSourceId,
          phase: c.executionScope?.kind ?? c.step,
          reason:
            reservations.length < setting.capacity
              ? 'Capacity is available; automation will recheck remaining requirements before starting.'
              : `Waiting for a verification slot (${reservations.length}/${setting.capacity} occupied).`,
          paused: c.status !== 'running',
        })),
      roadmaps: roadmaps.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.definition.name,
        status: r.status,
      })),
    };
  }
  save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    input: SaveHostScheduling,
  ): HostSchedulingStatus {
    this.authorize(context, workspaceId);
    this.storage.transaction((tx) => {
      if (tx.phaseScheduling.setting('local-verification').version !== input.expectedVersion)
        throw new ExecutionRequestError(
          'conflict',
          'Host settings changed. Reload settings before saving.',
        );
      if (tx.roadmaps.list().some((r) => r.status === 'running'))
        throw new ExecutionRequestError(
          'conflict',
          'Pause roadmap scheduling in every workspace before changing host capacity.',
        );
      if (tx.phaseScheduling.capacity('local-verification') === input.verificationCapacity) return;
      if (
        !tx.phaseScheduling.saveCapacity(
          'local-verification',
          input.verificationCapacity,
          input.expectedVersion,
          context.user.id,
          this.now().toISOString(),
        )
      )
        throw new ExecutionRequestError(
          'conflict',
          'Host settings changed. Reload settings before saving.',
        );
      tx.audit.append({
        id: randomUUID(),
        occurredAt: this.now().toISOString(),
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        action: 'host-scheduling.updated',
        outcome: 'succeeded',
        priorVersion: input.expectedVersion,
        resultingVersion: input.expectedVersion + 1,
        metadata: { verificationCapacity: input.verificationCapacity },
      });
    });
    this.notifier.notify();
    return this.get(context, workspaceId);
  }
}
