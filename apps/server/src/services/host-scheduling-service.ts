import { randomUUID } from 'node:crypto';
import type { HostSchedulingStatus, SaveHostScheduling } from '@craftingtable/contracts';
import {
  asAgentRunId,
  asWorkspaceId,
  phaseBlockerResourceKey,
  type WorkspaceId,
} from '@craftingtable/domain';
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
    const development = this.storage.phaseScheduling.setting('local-development');
    const cycles = this.storage.execution.cycles.list();
    const reservations = this.storage.phaseScheduling
      .active()
      .filter((r) => ['local-development', 'local-verification'].includes(r.resourceKey));
    const roadmaps = this.storage.roadmaps
      .list()
      .filter((r) => !['stopped', 'completed'].includes(r.status));
    return {
      version: setting.version,
      verificationCapacity: setting.capacity,
      developmentCapacity: development.capacity,
      developmentVersion: development.version,
      developmentSource: development.updatedAt ? 'saved-setting' : 'daemon-environment',
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
            'Workstation operation',
          phase: r.phase,
          resourceKey: r.resourceKey as 'local-development' | 'local-verification',
          acquiredAt: r.acquiredAt,
        };
      }),
      // Durable waits only: avoid recomputing the entire dependency graph on a settings read.
      waiting: cycles.flatMap((c) =>
        (['local-development', 'local-verification'] as const).flatMap((resourceKey) => {
          if (!c.phaseWait?.blockers.some((b) => phaseBlockerResourceKey(b) === resourceKey))
            return [];
          const used = reservations.filter((r) => r.resourceKey === resourceKey).length;
          const capacity =
            resourceKey === 'local-development' ? development.capacity : setting.capacity;
          return [
            {
              id: `${c.id}:${resourceKey}`,
              workspaceId: c.workspaceId,
              workItemId: c.workItemId ?? null,
              runId: null,
              label: c.workItemSourceId,
              phase: c.executionScope?.kind ?? c.step,
              resourceKey,
              reason:
                used < capacity
                  ? 'Capacity is available; automation will recheck remaining requirements before starting.'
                  : `Waiting for a slot (${used}/${capacity} occupied).`,
              paused: c.status !== 'running',
            },
          ];
        }),
      ),
      roadmaps: roadmaps.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.definition.name,
        status: r.status,
        crossProject: !!r.definition.crossProject,
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
      const changes = [
        {
          key: 'local-development',
          capacity: input.developmentCapacity,
          version: input.expectedDevelopmentVersion,
        },
        {
          key: 'local-verification',
          capacity: input.verificationCapacity,
          version: input.expectedVersion,
        },
      ];
      if (changes.some((c) => tx.phaseScheduling.setting(c.key).version !== c.version))
        throw new ExecutionRequestError(
          'conflict',
          'Host settings changed. Reload settings before saving.',
        );
      if (tx.roadmaps.list().some((r) => r.status === 'running'))
        throw new ExecutionRequestError(
          'conflict',
          'Pause roadmap scheduling in every workspace before changing host capacity.',
        );
      const at = this.now().toISOString();
      for (const change of changes) {
        if (tx.phaseScheduling.capacity(change.key) === change.capacity) continue;
        if (
          !tx.phaseScheduling.saveCapacity(
            change.key,
            change.capacity,
            change.version,
            context.user.id,
            at,
          )
        )
          throw new ExecutionRequestError(
            'conflict',
            'Host settings changed. Reload settings before saving.',
          );
        tx.audit.append({
          id: randomUUID(),
          occurredAt: at,
          actorKind: 'user',
          actorUserId: context.user.id,
          sessionId: context.session.id,
          workspaceId,
          action: 'host-scheduling.updated',
          outcome: 'succeeded',
          priorVersion: change.version,
          resultingVersion: change.version + 1,
          metadata: { resourceKey: change.key, capacity: change.capacity },
        });
      }
    });
    this.notifier.notify();
    return this.get(context, workspaceId);
  }
}
