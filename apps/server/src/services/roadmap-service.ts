import { randomUUID } from 'node:crypto';
import type { SaveRoadmapRequest } from '@craftingtable/contracts';
import {
  asAuditEventId,
  asEventId,
  asWorktreeId,
  type Roadmap,
  type RoadmapEntry,
  type RoadmapAttempt,
  type RoadmapView,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from './auth-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import type { ExecutionService } from './execution-service.js';
import type { WorkItemService } from './work-item-service.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';

class SupersededRoadmapOperation extends Error {}

const ended = (roadmap: Roadmap) => ['stopped', 'completed'].includes(roadmap.status);
function conflict(message: string): never {
  throw new ExecutionRequestError('conflict', message);
}

/** One ordered whole-item queue per workspace. The cycle controller owns every agent step. */
export class RoadmapService {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private ticking = false;
  private readonly controlling = new Set<string>();
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly items: WorkItemService,
    private readonly execution: ExecutionService,
    private readonly cycles: WorkCycleService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(context: AuthContext, workspaceId: WorkspaceId): readonly RoadmapView[] {
    this.workspaces.requireAuthorized(context, workspaceId);
    return this.storage.roadmaps.list(workspaceId).map((roadmap) => this.view(roadmap));
  }
  history(context: AuthContext, workspaceId: WorkspaceId, id: string) {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.find(workspaceId, id);
    return this.storage.roadmaps.history(workspaceId, id);
  }
  save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    input: SaveRoadmapRequest,
  ): RoadmapView {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A roadmap command is in progress.');
    const old = this.storage.roadmaps.find(workspaceId, id);
    if ((old?.version ?? 0) !== input.expectedVersion)
      conflict('Roadmap changed; refresh before saving.');
    if (old && !['draft', 'paused', 'needs-attention'].includes(old.status))
      conflict(
        'Pause the roadmap before editing queued entries. Ended roadmaps retain their history.',
      );
    const lastStarted =
      old?.definition.entries.findLastIndex((e) => old.attempts.some((a) => a.entryId === e.id)) ??
      -1;
    const started = old?.definition.entries.slice(0, lastStarted + 1) ?? [];
    const entries: RoadmapEntry[] = input.entries.map((entry, index) => {
      const item = this.storage.planning.workItems.find(workspaceId, entry.workItemId);
      if (!item) throw new NotFoundError();
      const frozen = started.find((e) => e.id === entry.id);
      if (frozen) {
        if (
          JSON.stringify({
            id: frozen.id,
            workItemId: frozen.workItemId,
            profiles: frozen.profiles,
            policy: frozen.policy,
            instructions: frozen.instructions,
          }) !== JSON.stringify(entry)
        )
          conflict('Started entries keep their original work item and settings.');
        return frozen;
      }
      if (index < started.length)
        conflict('Started entries must remain at the front in their original order.');
      const settings = this.storage.execution.branchSettings.find(workspaceId, item.planVersionId);
      if (!settings) conflict(`Configure Repository & branches for ${item.sourceId}'s plan first.`);
      const repo = this.storage.execution.sourceRepositories.find(
        workspaceId,
        settings.repositoryId,
      );
      if (repo?.status !== 'active')
        conflict(`The repository for ${item.sourceId} is unavailable.`);
      return {
        ...entry,
        projectId: item.projectId,
        planVersionId: item.planVersionId,
        sourceId: item.sourceId,
        title: item.title,
        repositoryId: settings.repositoryId,
        integrationBranch: settings.integrationBranch,
      };
    });
    if (started.some((e, index) => entries[index]?.id !== e.id))
      conflict('Started entries cannot be removed or reordered.');
    for (const [index, entry] of entries.entries()) {
      for (const dependency of this.storage.planning.dependencies.listPredecessors(
        workspaceId,
        entry.workItemId,
      )) {
        if (
          dependency.kind === 'required' &&
          dependency.status !== 'completed' &&
          entries.findIndex((e) => e.workItemId === dependency.workItemId) > index
        )
          conflict(
            `${dependency.sourceId} must appear before ${entry.sourceId}. Prerequisites outside the roadmap remain blockers.`,
          );
      }
    }
    const at = this.now().toISOString();
    const definition = {
      roadmapId: id,
      revision: (old?.definition.revision ?? 0) + 1,
      name: input.name,
      entries,
      createdAt: at,
      createdByUserId: context.user.id,
    };
    const roadmap: Roadmap = old
      ? { ...old, definition, version: old.version + 1, updatedAt: at }
      : {
          id,
          workspaceId,
          version: 1,
          definition,
          status: 'draft',
          reason: 'Saved. Start explicitly to delegate this ordered queue.',
          createdAt: at,
          updatedAt: at,
          createdByUserId: context.user.id,
          attempts: [],
        };
    this.storage.transaction((tx) => {
      this.persist(tx, roadmap, input.expectedVersion, 'save', context);
      tx.roadmaps.addDefinition(definition);
    });
    this.notifier.notify();
    return this.view(roadmap);
  }

  async control(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    if (this.controlling.has(id)) conflict('A roadmap command is already in progress.');
    this.controlling.add(id);
    try {
      return await this.controlWithin(context, workspaceId, id, action, expectedVersion);
    } finally {
      this.controlling.delete(id);
    }
  }
  private async controlWithin(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<RoadmapView> {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    let roadmap = this.find(workspaceId, id);
    if (roadmap.version !== expectedVersion)
      conflict('Roadmap changed; refresh before issuing this command.');
    if (ended(roadmap)) conflict('This roadmap has ended.');
    if (action === 'pause' && roadmap.status === 'draft')
      conflict('Start the roadmap before pausing it.');
    if (action === 'start' || action === 'resume') {
      if (
        action === 'start'
          ? roadmap.status !== 'draft'
          : !['paused', 'needs-attention'].includes(roadmap.status)
      )
        conflict('Only a draft can start; only a paused roadmap can resume.');
      if (
        this.storage.roadmaps
          .list(workspaceId)
          .some((r) => r.id !== id && r.status !== 'draft' && !ended(r))
      )
        conflict('This workspace already has a delegated roadmap. Stop or finish it first.');
      // Explicit resume may adopt the owned cycle's manual handoff, using its normal guards.
      const attempt = roadmap.attempts.find((a) => a.status !== 'completed');
      const cycle = attempt && this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
      if (cycle && ['paused', 'needs-attention'].includes(cycle.status)) {
        const worktree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
        if (!worktree?.mergedAt)
          await this.cycles.control(context, workspaceId, cycle.id, 'resume', cycle.version);
      }
      roadmap = this.change(
        roadmap,
        {
          status: 'running',
          delegatedByUserId: context.user.id,
          reason: 'Sequential scheduling enabled. Every merge requires operator approval.',
        },
        action,
        context,
      );
    } else {
      roadmap = this.change(
        roadmap,
        {
          status: action === 'pause' ? 'paused' : 'stopped',
          reason:
            action === 'pause'
              ? 'Roadmap paused. Manual work is available; no next item will start.'
              : 'Roadmap stopped. Existing worktrees remain available for manual work.',
        },
        action,
        context,
      );
      const attempt = roadmap.attempts.find((a) => a.status !== 'completed');
      const cycle = attempt && this.storage.execution.cycles.find(workspaceId, attempt.cycleId);
      if (
        cycle &&
        !['stopped', 'completed'].includes(cycle.status) &&
        (action === 'stop' || cycle.status === 'running')
      )
        await this.cycles.control(context, workspaceId, cycle.id, action, cycle.version);
    }
    return this.view(this.find(workspaceId, id));
  }

  recoverInterrupted(): void {
    for (const roadmap of this.storage.roadmaps.list())
      if (roadmap.status === 'running')
        this.change(roadmap, {
          status: 'needs-attention',
          reason: 'Daemon restarted. Inspect the current item and explicitly resume the roadmap.',
        });
  }
  startWorker(): void {
    this.task ??= this.loop();
  }
  async shutdown(): Promise<void> {
    this.abort.abort();
    await this.task;
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const generation = this.notifier.generation;
      await this.tick();
      await this.notifier.waitForChangeOrTimeout({
        generation,
        timeoutMs: 1000,
        signal: this.abort.signal,
      });
    }
  }
  /** Serialized tick is also the deterministic integration-test seam. */
  async tick(): Promise<void> {
    if (this.ticking || this.abort.signal.aborted) return;
    this.ticking = true;
    try {
      for (const roadmap of this.storage.roadmaps.list()) {
        if (this.abort.signal.aborted) break;
        if (roadmap.status !== 'running' || this.controlling.has(roadmap.id)) continue;
        try {
          await this.advance(roadmap);
        } catch (error) {
          if (error instanceof SupersededRoadmapOperation) continue;
          const current = this.find(roadmap.workspaceId, roadmap.id);
          if (current.status === 'running')
            this.change(current, {
              status: 'needs-attention',
              reason:
                error instanceof ExecutionRequestError
                  ? error.message
                  : 'Scheduler could not advance. Inspect the current item before resuming.',
            });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private authority(roadmap: Roadmap): CommandContext {
    const user =
      roadmap.delegatedByUserId && this.storage.users.findById(roadmap.delegatedByUserId);
    if (user?.status !== 'active') conflict('The initiating user is no longer active.');
    const access = this.storage.workspaces.findAuthorized(user.id, roadmap.workspaceId);
    if (!access || !['owner', 'editor'].includes(access.membership.role))
      conflict('The initiating user no longer has permission to run this roadmap.');
    return { user };
  }
  private async advance(roadmap: Roadmap): Promise<void> {
    const context = this.authority(roadmap);
    const entry = roadmap.definition.entries.find((e) => !this.complete(roadmap, e));
    if (!entry) {
      this.change(roadmap, { status: 'completed', reason: 'All roadmap entries are completed.' });
      return;
    }
    let attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
    if (attempt) {
      const worktree = this.storage.execution.worktrees.find(
        roadmap.workspaceId,
        attempt.worktreeId,
      );
      if (
        worktree &&
        (worktree.integrationBranch !== entry.integrationBranch ||
          worktree.repositoryId !== entry.repositoryId)
      )
        conflict(
          `${entry.sourceId}: The execution branch binding changed. Stop this roadmap and reconcile the remaining queue with the new target.`,
        );
      if (worktree?.mergedAt) {
        this.change(roadmap, {
          attempts: roadmap.attempts.map((a) =>
            a.id === attempt?.id
              ? { ...a, status: 'completed' as const, completedAt: worktree.mergedAt }
              : a,
          ),
          reason: `${entry.sourceId} merged by operator.`,
        });
        return;
      }
      if (
        this.storage.planning.workItems.find(roadmap.workspaceId, entry.workItemId)?.status ===
        'completed'
      )
        conflict(
          `${entry.sourceId}: Marked complete without merging the roadmap worktree. Merge its reviewed branch or stop this roadmap to reconcile the queue.`,
        );
      const cycle = this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
      if (cycle) {
        if (['paused', 'needs-attention', 'stopped', 'completed'].includes(cycle.status))
          this.change(roadmap, {
            status: 'needs-attention',
            reason: `${entry.sourceId}: ${cycle.reason} Inspect its cycle before resuming the roadmap.`,
          });
        else
          this.reason(
            roadmap,
            `${entry.sourceId}: ${cycle.status === 'awaiting-merge' ? 'Awaiting your merge approval.' : cycle.reason}`,
          );
        return;
      }
    }
    const blocker = this.blocker(roadmap, entry, attempt);
    if (blocker) {
      if (blocker.needsAttention)
        this.change(roadmap, { status: 'needs-attention', reason: blocker.reason });
      else this.reason(roadmap, blocker.reason);
      return;
    }
    this.cycles.validateSettings(entry);
    if (!attempt) {
      attempt = {
        id: randomUUID(),
        entryId: entry.id,
        definitionRevision: roadmap.definition.revision,
        worktreeId: asWorktreeId(randomUUID()),
        cycleId: randomUUID(),
        status: 'preparing',
        createdAt: this.now().toISOString(),
      };
      roadmap = this.change(roadmap, {
        attempts: [...roadmap.attempts, attempt],
        reason: `Preparing ${entry.sourceId}.`,
      });
    }
    const reserved = attempt;
    const check = () => {
      if (this.abort.signal.aborted) throw new SupersededRoadmapOperation();
      const current = this.find(roadmap.workspaceId, roadmap.id);
      if (current.version !== roadmap.version || current.status !== 'running')
        throw new SupersededRoadmapOperation();
      this.authority(current);
      const blocked = this.blocker(current, entry, reserved);
      if (blocked) conflict(blocked.reason);
    };
    check();
    this.items.admit(context, roadmap.workspaceId, entry.workItemId);
    let worktree = this.storage.execution.worktrees.find(roadmap.workspaceId, reserved.worktreeId);
    if (!worktree)
      worktree = await this.execution.createWorktree(
        context,
        roadmap.workspaceId,
        entry.workItemId,
        { repositoryId: entry.repositoryId },
        undefined,
        { id: reserved.worktreeId, check },
      );
    check();
    if (worktree.status !== 'active')
      conflict(
        'Reserved worktree was removed. Stop the roadmap and create a new roadmap for the remaining work.',
      );
    if (
      worktree.integrationBranch !== entry.integrationBranch ||
      worktree.repositoryId !== entry.repositoryId
    )
      conflict('Reserved worktree no longer matches this entry’s branch binding.');
    // Cycle creation and attempt attachment commit together, before the cycle worker can launch.
    this.storage.transaction(() => {
      this.cycles.start(
        context,
        roadmap.workspaceId,
        entry.workItemId,
        {
          worktreeId: reserved.worktreeId,
          profiles: entry.profiles,
          policy: entry.policy,
          instructions: entry.instructions,
        },
        reserved.cycleId,
      );
      this.change(roadmap, {
        attempts: roadmap.attempts.map((a) =>
          a.id === reserved.id ? { ...a, status: 'active' } : a,
        ),
        reason: `Running ${entry.sourceId}.`,
      });
    });
  }
  private complete(roadmap: Roadmap, entry: RoadmapEntry): boolean {
    const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
    return attempt
      ? attempt.status === 'completed'
      : this.storage.planning.workItems.find(roadmap.workspaceId, entry.workItemId)?.status ===
          'completed';
  }
  private blocker(
    roadmap: Roadmap,
    entry: RoadmapEntry,
    attempt?: RoadmapAttempt,
  ): { reason: string; needsAttention: boolean } | undefined {
    const blocked = (reason: string, needsAttention = true) => ({ reason, needsAttention });
    const item = this.storage.planning.workItems.find(roadmap.workspaceId, entry.workItemId);
    if (!item || item.planVersionId !== entry.planVersionId)
      return blocked(`${entry.sourceId}: Bound plan item is unavailable.`);
    if (item.status === 'completed' && attempt)
      return blocked(
        `${entry.sourceId}: Marked complete without merging the roadmap worktree. Inspect the item; the queue will not advance.`,
      );
    const required = this.storage.planning.dependencies
      .listPredecessors(roadmap.workspaceId, entry.workItemId)
      .filter((e) => e.kind === 'required' && e.status !== 'completed');
    if (required.length)
      return blocked(
        `${entry.sourceId}: Waiting for required predecessors: ${required.map((e) => `${e.sourceId}${roadmap.definition.entries.some((item) => item.workItemId === e.workItemId) ? '' : ' (outside this roadmap)'}`).join(', ')}.`,
        false,
      );
    const settings = this.storage.execution.branchSettings.find(
      roadmap.workspaceId,
      entry.planVersionId,
    );
    if (
      settings?.repositoryId !== entry.repositoryId ||
      settings.integrationBranch !== entry.integrationBranch
    )
      return blocked(
        `${entry.sourceId}: Plan branch settings changed. Pause and save queued settings to adopt the new target.`,
      );
    const repo = this.storage.execution.sourceRepositories.find(
      roadmap.workspaceId,
      entry.repositoryId,
    );
    if (repo?.status !== 'active') return blocked(`${entry.sourceId}: Repository is unavailable.`);
    const occupied = this.storage.execution.worktrees
      .listActive()
      .find(
        (w) =>
          w.id !== attempt?.worktreeId &&
          this.storage.execution.sourceRepositories.find(w.workspaceId, w.repositoryId)
            ?.rootPath === repo.rootPath,
      );
    if (occupied)
      return blocked(
        `${entry.sourceId}: Repository has an unmerged worktree (${occupied.branchName}). Finish or remove it before this item starts.`,
        false,
      );
    return undefined;
  }
  private view(roadmap: Roadmap): RoadmapView {
    return {
      roadmap,
      progress: roadmap.definition.entries.map((entry) => {
        if (this.complete(roadmap, entry))
          return { entryId: entry.id, status: 'completed', reason: 'Completed.' };
        const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
        const cycle =
          attempt && this.storage.execution.cycles.find(roadmap.workspaceId, attempt.cycleId);
        if (cycle)
          return {
            entryId: entry.id,
            status:
              cycle.status === 'running'
                ? 'running'
                : cycle.status === 'awaiting-merge'
                  ? 'awaiting-merge'
                  : 'needs-attention',
            reason: cycle.reason,
          };
        const reason = this.blocker(roadmap, entry, attempt);
        return {
          entryId: entry.id,
          status: reason?.needsAttention
            ? 'needs-attention'
            : reason
              ? 'dependency-blocked'
              : 'queued',
          reason: reason?.reason ?? 'Waiting for its turn in the sequence.',
        };
      }),
    };
  }
  private find(workspaceId: WorkspaceId, id: string): Roadmap {
    const roadmap = this.storage.roadmaps.find(workspaceId, id);
    if (!roadmap) throw new NotFoundError();
    return roadmap;
  }
  private reason(roadmap: Roadmap, reason: string): void {
    const bounded = reason.slice(0, 4000);
    if (roadmap.reason !== bounded) this.change(roadmap, { reason: bounded });
  }
  private change(
    roadmap: Roadmap,
    changes: Partial<Roadmap>,
    action = 'advance',
    context?: AuthContext,
  ): Roadmap {
    const updated = {
      ...roadmap,
      ...changes,
      reason: (changes.reason ?? roadmap.reason).slice(0, 4000),
      version: roadmap.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.storage.transaction((tx) => this.persist(tx, updated, roadmap.version, action, context));
    this.notifier.notify();
    return updated;
  }
  private persist(
    tx: StorageRepositories,
    roadmap: Roadmap,
    expectedVersion: number,
    action: string,
    context?: AuthContext,
  ): void {
    if (!tx.roadmaps.save(roadmap, expectedVersion))
      conflict('Roadmap changed during this operation.');
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
}
