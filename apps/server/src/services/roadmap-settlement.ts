import { createHash, randomUUID } from 'node:crypto';
import {
  type AgentRunId,
  asAuditEventId,
  asEventId,
  asRoadmapWindDownId,
  isTerminalAgentRunStatus,
  ownsIntegrationResolution,
  type RetirementChoice,
  type Roadmap,
  type RoadmapWindDown,
  type RoadmapWindDownView,
  startedAttempts,
  WIND_DOWN_STEPS,
  type WindDownCycle,
  type WindDownPreview,
  type WindDownRefusalDetail,
  type WindDownStep,
  type WindDownVersion,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  NotFoundError,
  windDownRefused,
} from './errors.js';
import { investigationLive } from './investigation.js';
import type { WorkCycleService } from './work-cycle-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * Settling a roadmap (R-B11, ADR-073): the one path for Stop and for winding down. A preflight
 * with no writes refuses by code; then the roadmap's `settling` record is the hold the scheduler
 * and the cycle worker honour, and idempotent steps stop what the roadmap still runs. The last
 * step stops the roadmap, writes the retirements and marks the record `settled` in one
 * transaction. A step that fails is recorded on the record, which raises one
 * `wind-down-incomplete` item; every scheduler pass resumes a record still settling.
 */

/** Writes a roadmap with its audit entry and event, as `RoadmapService` does. */
export type PersistRoadmap = (
  tx: StorageRepositories,
  roadmap: Roadmap,
  expectedVersion: number,
  action: string,
  context?: AuthContext,
) => void;

/** Told after each settle step ends; a test injects a crash by throwing (R-B11 done-when 3). */
export type SettlementObserver = (roadmapId: string, step: WindDownStep) => void;

/** How long a step may wait for cancelled sessions to end before it counts as failed. */
const SESSION_WAIT_LIMIT_MS = 10 * 60_000;
const STOPPED_REASON = 'Roadmap stopped. Existing worktrees remain available for manual work.';
const WOUND_DOWN_REASON =
  'Roadmap wound down. Its retired plan versions hold nothing; worktrees remain until the repositories are cleaned up.';
const MOOT = 'Moot: the roadmap was stopped or wound down, so nothing would apply this amendment.';

const ended = (roadmap: Pick<Roadmap, 'status'>) =>
  roadmap.status === 'stopped' || roadmap.status === 'completed';
const delegating = (roadmap: Pick<Roadmap, 'status'>) =>
  roadmap.status === 'running' ||
  roadmap.status === 'paused' ||
  roadmap.status === 'needs-attention';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A step that waits for something that ends by itself, such as a cancelled session. */
class StepWaiting extends Error {}

/** What a step failed on, by type and code, never by its text (review F10). */
const causeOf = (step: WindDownStep, error: unknown) =>
  error instanceof ExecutionRequestError
    ? `${step}:${error.code}:${error.detail?.reason ?? ''}`
    : `${step}:${error instanceof Error ? error.name : typeof error}`;

export class RoadmapSettlement {
  /** Roadmaps a command or pass is settling in this process. */
  private readonly busy = new Set<string>();
  /** The cause each roadmap's incomplete step last recorded, so a pass repeats no audit. */
  private readonly recorded = new Map<string, string>();
  private observer: SettlementObserver | undefined;

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly cycles: WorkCycleService,
    private readonly runs: AgentRunService | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date,
    private readonly persist: PersistRoadmap,
  ) {}

  observe(observer: SettlementObserver | undefined): void {
    this.observer = observer;
  }

  /** The roadmap's settlement record and what winding it down would do now. */
  view(context: AuthContext, ws: WorkspaceId, roadmapId: string): RoadmapWindDownView {
    this.workspaces.requireRole(context, ws, ['owner', 'editor', 'viewer']);
    return this.storage.readTransaction((tx) => {
      const roadmap = tx.roadmaps.find(ws, roadmapId);
      if (!roadmap) throw new NotFoundError();
      const record = tx.windDowns.find(ws, roadmapId);
      return { ...(record ? { record } : {}), preview: this.preview(tx, roadmap) };
    });
  }

  /** The roadmaps held by a record still settling. */
  held(): ReadonlySet<string> {
    return new Set(this.storage.windDowns.settling().map((record) => record.roadmapId));
  }

  /**
   * What a wind-down would do now, from stored state only. The digest covers what the command
   * acts on: the cycles it stops and the resolutions it abandons, the preparation runs it ends,
   * the amendment it rejects and each version's eligibility, never a version a running roadmap
   * rewrites on every pass.
   */
  preview(tx: StorageRepositories, roadmap: Roadmap): WindDownPreview {
    const ws = roadmap.workspaceId;
    const attempts = startedAttempts(roadmap);
    const preparations = roadmap.decisionPreparations ?? [];
    const owned = new Set<string>([
      ...attempts.map((a) => a.worktreeId),
      ...preparations.map((p) => p.worktreeId),
    ]);
    const cycles: WindDownCycle[] = [];
    const seen = new Set<string>();
    for (const attempt of attempts) {
      const cycle = tx.execution.cycles.find(ws, attempt.cycleId);
      if (
        !cycle ||
        seen.has(cycle.id) ||
        cycle.status === 'stopped' ||
        cycle.status === 'completed'
      )
        continue;
      seen.add(cycle.id);
      const run = tx.execution.runs.find(ws, cycle.currentRunId);
      cycles.push({
        cycleId: cycle.id,
        entryId: attempt.entryId,
        label: cycle.workItemSourceId,
        status: cycle.status,
        ...(run && !isTerminalAgentRunStatus(run.status) ? { liveRunId: run.id } : {}),
        investigation: investigationLive(cycle),
        abandonsResolution: ownsIntegrationResolution(cycle),
        reservedMerge: tx.execution.merges.latest(ws, cycle.worktreeId)?.status === 'reserved',
      });
    }
    const live = preparations.flatMap((p) => {
      const run = tx.execution.runs.find(ws, p.runId);
      return run && !isTerminalAgentRunStatus(run.status)
        ? [{ preparationId: p.id, checkpointId: p.checkpointId, runId: p.runId, live: true }]
        : [];
    });
    const amendment = tx.amendments.pending(ws, roadmap.id);
    const attention = tx.attention
      .open(ws)
      .filter((item) => item.refs.roadmapId === roadmap.id)
      .map((item) => ({ itemId: item.id, code: item.code, title: item.title }));
    const versions = this.versions(tx, roadmap, owned);
    const refusals: WindDownRefusalDetail[] = [];
    const reserved = [...owned].filter(
      (id) => tx.execution.merges.latest(ws, id as WorktreeId)?.status === 'reserved',
    );
    if (reserved.length)
      refusals.push({
        code: 'merge-in-flight',
        message: `A merge is reserved on ${reserved.length === 1 ? 'one of this roadmap’s worktrees' : `${reserved.length} of this roadmap’s worktrees`}. Recover it from its item, then stop the roadmap.`,
      });
    const digest = hash({
      roadmapId: roadmap.id,
      ended: ended(roadmap),
      cycles: cycles.map((c) => [c.cycleId, c.abandonsResolution, c.reservedMerge]),
      preparations: live.map((p) => p.preparationId),
      amendment: amendment?.id ?? null,
      versions: versions.map((v) => [v.planVersionId, v.retired ?? null, v.refusal?.code ?? null]),
      refusals: refusals.map((r) => r.code),
    });
    return {
      roadmapId: roadmap.id,
      status: roadmap.status,
      digest,
      cycles,
      preparations: live,
      ...(amendment ? { amendmentId: amendment.id } : {}),
      attention,
      versions,
      refusals,
    };
  }

  /** The roadmap's plan versions, each as a candidate for retirement. */
  private versions(
    tx: StorageRepositories,
    roadmap: Roadmap,
    owned: ReadonlySet<string>,
  ): WindDownVersion[] {
    const ws = roadmap.workspaceId;
    const ids = [
      ...new Set([
        ...roadmap.definition.entries.map((e) => e.planVersionId),
        ...(roadmap.decisionPreparations ?? []).map((p) => p.planVersionId),
      ]),
    ];
    const others = tx.roadmaps.list(ws).filter((r) => r.id !== roadmap.id && delegating(r));
    const active = tx.execution.worktrees.listActive(ws);
    return ids.flatMap((id): WindDownVersion[] => {
      const version = tx.planning.versions.find(ws, id);
      if (!version) return [];
      const project = tx.planning.projects.find(ws, version.projectId);
      const items = tx.planning.workItems.listForVersion(ws, id);
      const itemIds = new Set<string>(items.map((i) => i.id));
      const trees = active.filter(
        (t) => t.planVersionId === id || (t.workItemId !== undefined && itemIds.has(t.workItemId)),
      );
      const retired = tx.windDowns.retirement(ws, id)?.disposition;
      const user = others.find((r) => r.definition.entries.some((e) => e.planVersionId === id));
      const outside = trees.find(
        (t) =>
          !owned.has(t.id) &&
          (tx.execution.runs.liveForWorktree(ws, t.id).length > 0 ||
            tx.execution.cycles.activeForWorktree(ws, t.id) !== undefined),
      );
      const finalization = tx.execution.finalizations
        .list(ws)
        .find((f) => f.planVersionId === id && !['completed', 'stopped'].includes(f.status));
      const reserved = trees.find(
        (t) => tx.execution.merges.latest(ws, t.id)?.status === 'reserved',
      );
      const refusal: WindDownRefusalDetail | undefined = retired
        ? undefined
        : user
          ? {
              code: 'version-in-use',
              message: `The roadmap ${user.definition.name} still runs this version.`,
            }
          : outside
            ? {
                code: 'version-in-use',
                message: `Work outside this roadmap is live on ${outside.branchName}.`,
              }
            : finalization
              ? {
                  code: 'finalization-active',
                  message: 'A finalization of this version is open. Stop or finish it first.',
                }
              : reserved
                ? {
                    code: 'merge-in-flight',
                    message: `A merge is reserved on ${reserved.branchName}. Recover it first.`,
                  }
                : undefined;
      return [
        {
          planVersionId: version.id,
          projectId: version.projectId,
          projectName: project?.name ?? version.document,
          versionNumber: version.versionNumber,
          active: project?.activePlanVersionId === version.id,
          admittedItems: items.filter((i) => i.status === 'admitted').length,
          activeWorktrees: trees.length,
          ...(retired ? { retired } : {}),
          ...(refusal ? { refusal } : {}),
        },
      ];
    });
  }

  /** Winds the roadmap down: settles it and retires the chosen versions (ADR-073). */
  async windDown(
    context: AuthContext,
    ws: WorkspaceId,
    roadmapId: string,
    input: { readonly expectedDigest: string; readonly retire: readonly RetirementChoice[] },
  ): Promise<void> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const roadmap = this.storage.roadmaps.find(ws, roadmapId);
    if (!roadmap) throw new NotFoundError();
    const preview = this.storage.readTransaction((tx) => this.preview(tx, roadmap));
    if (preview.digest !== input.expectedDigest)
      windDownRefused(
        'preview-stale',
        'What winding down would do has changed. Review the current preview and try again.',
      );
    const refused = preview.refusals[0];
    if (refused) windDownRefused(refused.code, refused.message);
    for (const choice of input.retire) {
      const version = preview.versions.find((v) => v.planVersionId === choice.planVersionId);
      if (!version)
        throw new ExecutionRequestError(
          'invalid-request',
          'Choose plan versions this roadmap names.',
        );
      if (version.retired && version.retired !== choice.disposition)
        throw new ExecutionRequestError(
          'invalid-request',
          `Version ${version.versionNumber} of ${version.projectName} is already retired as ${version.retired}.`,
        );
      if (version.refusal) windDownRefused(version.refusal.code, version.refusal.message);
    }
    await this.begin(context, roadmap, preview, input.retire);
  }

  /** Stop: a wind-down that retires nothing (R-B11 decision 4). */
  async stop(
    context: AuthContext,
    ws: WorkspaceId,
    roadmapId: string,
    expectedVersion: number,
  ): Promise<void> {
    this.workspaces.requireRole(context, ws, ['owner', 'editor']);
    const roadmap = this.storage.roadmaps.find(ws, roadmapId);
    if (!roadmap) throw new NotFoundError();
    if (roadmap.version !== expectedVersion)
      windDownRefused('version-conflict', 'Roadmap changed; refresh before issuing this command.');
    if (ended(roadmap) && this.storage.windDowns.find(ws, roadmapId)?.status === 'settled')
      throw new ExecutionRequestError('conflict', 'This roadmap has ended.');
    const preview = this.storage.readTransaction((tx) => this.preview(tx, roadmap));
    const refused = preview.refusals[0];
    if (refused) windDownRefused(refused.code, refused.message);
    await this.begin(context, roadmap, preview, []);
  }

  /** Continues a record still settling, as the user who asked for it (every scheduler pass). */
  async resume(record: RoadmapWindDown): Promise<void> {
    await this.settle(record);
  }

  /** Writes the settling record (the hold), then settles. */
  private async begin(
    context: AuthContext,
    roadmap: Roadmap,
    preview: WindDownPreview,
    retire: readonly RetirementChoice[],
  ): Promise<void> {
    const ws = roadmap.workspaceId;
    const record = this.storage.windDowns.find(ws, roadmap.id);
    const added = retire.filter(
      (choice) => !record?.retire.some((r) => r.planVersionId === choice.planVersionId),
    );
    if (record?.status === 'settling') {
      if (added.length || this.busy.has(roadmap.id))
        windDownRefused(
          'wind-down-in-progress',
          'This roadmap is already settling. Wait for it to finish, then choose again.',
        );
      // Someone else finishes another user's retirements only by choosing them again, which asks
      // for the password as retiring does (decision 5; review F9).
      const pending = record.retire.filter(
        (r) => !this.storage.windDowns.retirement(ws, r.planVersionId),
      );
      if (
        context.user.id !== record.requestedByUserId &&
        pending.some(
          (p) =>
            !retire.some(
              (c) => c.planVersionId === p.planVersionId && c.disposition === p.disposition,
            ),
        )
      )
        windDownRefused(
          'wind-down-in-progress',
          'Another user chose to retire plan versions in this wind-down. To finish it yourself, wind down again choosing the same versions.',
        );
      await this.settle(record, context);
      return;
    }
    // Settled with nothing new to retire: a repeated command changes nothing.
    if (record && !added.length) return;
    const at = this.now().toISOString();
    const next: RoadmapWindDown = {
      id: record?.id ?? asRoadmapWindDownId(randomUUID()),
      workspaceId: ws,
      roadmapId: roadmap.id,
      version: (record?.version ?? 0) + 1,
      status: 'settling',
      retire: [...(record?.retire ?? []), ...added],
      abandonResolutions: preview.cycles.filter((c) => c.abandonsResolution).map((c) => c.cycleId),
      previewDigest: preview.digest,
      requestedAt: at,
      requestedByUserId: context.user.id,
      startedAt: record?.startedAt ?? at,
    };
    this.storage.transaction((tx) => {
      if (record) {
        if (!tx.windDowns.replace(next, record.version))
          throw new ConcurrentModificationError('The wind-down changed; refresh and try again.');
      } else tx.windDowns.insert(next);
      this.audit(tx, next, 'requested', context, {
        retire: added.map((c) => ({ planVersionId: c.planVersionId, disposition: c.disposition })),
        abandonResolutions: [...next.abandonResolutions],
        previewDigest: next.previewDigest,
      });
      this.event(tx, roadmap, 'Settling: stopping its cycles and preparations.', context);
    });
    this.notifier.notify();
    await this.settle(next, context);
  }

  /** Runs every step in order; each re-derives what is left, so a repeat converges. */
  private async settle(record: RoadmapWindDown, context?: AuthContext): Promise<void> {
    if (this.busy.has(record.roadmapId)) return;
    this.busy.add(record.roadmapId);
    try {
      for (const step of WIND_DOWN_STEPS) {
        try {
          const actor = context ?? this.requester(record);
          await this.step(step, record, actor, context);
          this.observer?.(record.roadmapId, step);
        } catch (error) {
          if (error instanceof StepWaiting) return;
          this.incomplete(record, step, error);
          return;
        }
      }
    } finally {
      this.busy.delete(record.roadmapId);
      this.notifier.notify();
    }
  }

  /** Whoever asked for the wind-down, while they may still act on the roadmap. */
  private requester(record: RoadmapWindDown): CommandContext {
    const user = this.storage.users.findById(record.requestedByUserId);
    const access = user && this.storage.workspaces.findAuthorized(user.id, record.workspaceId);
    if (
      user?.status !== 'active' ||
      !access ||
      !['owner', 'editor'].includes(access.membership.role)
    )
      throw new ExecutionRequestError(
        'conflict',
        'The user who asked for this wind-down can no longer act on the roadmap. Ask again as an editor.',
      );
    return { user };
  }

  private async step(
    step: WindDownStep,
    record: RoadmapWindDown,
    actor: CommandContext,
    context: AuthContext | undefined,
  ): Promise<void> {
    switch (step) {
      case 'cycles':
        return this.stopCycles(record, actor);
      case 'preparations':
        return this.endPreparations(record);
      case 'amendment':
        return this.rejectAmendment(record);
      case 'settle':
        return this.finish(record, context);
    }
  }

  private roadmap(record: RoadmapWindDown): Roadmap {
    const roadmap = this.storage.roadmaps.find(record.workspaceId, record.roadmapId);
    if (!roadmap) throw new NotFoundError();
    return roadmap;
  }

  /**
   * Per owned cycle: end a live investigation, abandon an integration resolution the preview
   * named (once its session has ended), then stop it with code `roadmap-wound-down`, which ends
   * its live run. Then releases reservations that ended runs still hold.
   */
  private async stopCycles(record: RoadmapWindDown, actor: CommandContext): Promise<void> {
    const ws = record.workspaceId;
    let waiting = false;
    for (const attempt of startedAttempts(this.roadmap(record))) {
      let cycle = this.storage.execution.cycles.find(ws, attempt.cycleId);
      if (!cycle || cycle.status === 'stopped' || cycle.status === 'completed') continue;
      if (investigationLive(cycle))
        cycle = await this.cycles.endInvestigation(actor, ws, cycle.id, cycle.version, true);
      if (ownsIntegrationResolution(cycle)) {
        if (!record.abandonResolutions.includes(cycle.id))
          throw new ExecutionRequestError(
            'conflict',
            `${cycle.workItemSourceId} started an integration resolution after the preview. Review the wind-down again.`,
          );
        // Stop pauses an owned resolution with its edits and ends its session first.
        if (!['paused', 'needs-attention'].includes(cycle.status))
          cycle = await this.cycles.control(actor, ws, cycle.id, 'stop', cycle.version);
        if (this.storage.execution.runs.liveForWorktree(ws, cycle.worktreeId).length) {
          waiting = true;
          continue;
        }
        cycle = await this.cycles.resolveIntegration(actor, ws, cycle.id, {
          action: 'abandon',
          expectedVersion: cycle.version,
        });
      }
      this.cycles.windDownStop(actor, cycle);
    }
    this.releaseReservations(record);
    if (waiting) {
      if (this.now().getTime() - Date.parse(record.requestedAt) > SESSION_WAIT_LIMIT_MS)
        throw new ExecutionRequestError(
          'conflict',
          'A cancelled resolution session has not ended. Inspect its run, then wind down again.',
        );
      throw new StepWaiting();
    }
  }

  /** Releases resource claims that the roadmap's ended runs still hold. */
  private releaseReservations(record: RoadmapWindDown): void {
    const roadmap = this.roadmap(record);
    const trees = new Set<string>([
      ...startedAttempts(roadmap).map((a) => a.worktreeId),
      ...(roadmap.decisionPreparations ?? []).map((p) => p.worktreeId),
    ]);
    const orphans = this.storage.phaseScheduling.active().filter((r) => {
      if (r.workspaceId !== record.workspaceId || !trees.has(r.worktreeId)) return false;
      // A Git or evidence operation holds its claim only for its own duration.
      if (r.ownerId.startsWith('operation:')) return false;
      const run = this.storage.execution.runs.find(record.workspaceId, r.ownerId as AgentRunId);
      return !run || isTerminalAgentRunStatus(run.status);
    });
    if (!orphans.length) return;
    const at = this.now().toISOString();
    this.storage.transaction((tx) => {
      for (const r of orphans) tx.phaseScheduling.release(r.ownerId, at, 'roadmap-wound-down');
    });
  }

  /** Ends the roadmap's live preparation runs; its record ends the preparations themselves. */
  private async endPreparations(record: RoadmapWindDown): Promise<void> {
    for (const p of this.roadmap(record).decisionPreparations ?? []) {
      const run = this.storage.execution.runs.find(record.workspaceId, p.runId);
      if (run && !isTerminalAgentRunStatus(run.status))
        this.runs?.cancelPreparation(record.workspaceId, p.runId, 'The roadmap was stopped.');
    }
  }

  /** A pending amendment on this roadmap is rejected as moot. */
  private async rejectAmendment(record: RoadmapWindDown): Promise<void> {
    const ws = record.workspaceId;
    const pending = this.storage.amendments.pending(ws, record.roadmapId);
    if (!pending) return;
    const at = this.now().toISOString();
    const roadmap = this.roadmap(record);
    this.storage.transaction((tx) => {
      if (
        !tx.amendments.decide(ws, pending.id, {
          outcome: 'rejected',
          rationale: MOOT,
          decidedAt: at,
          decidedByUserId: record.requestedByUserId,
          impactDigest: record.previewDigest,
          previous: roadmap,
          reusedIntegrationIds: [],
        })
      )
        return;
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: at,
        workspaceId: ws,
        actorKind: 'system',
        actorUserId: record.requestedByUserId,
        action: 'roadmap.amendment',
        targetType: 'roadmap',
        targetId: record.roadmapId,
        outcome: 'succeeded',
        metadata: { amendmentId: pending.id, outcome: 'rejected', moot: true },
      });
    });
  }

  /**
   * One transaction: stop the roadmap (a completed one stays completed), write each retirement
   * with its event, clear a retired version's active pointer, and mark the record settled.
   */
  private async finish(record: RoadmapWindDown, context: AuthContext | undefined): Promise<void> {
    const ws = record.workspaceId;
    const at = this.now().toISOString();
    this.storage.transaction((tx) => {
      const current = tx.windDowns.find(ws, record.roadmapId);
      if (current?.status !== 'settling' || current.version < record.version)
        throw new ConcurrentModificationError('The wind-down changed while it settled.');
      const roadmap = tx.roadmaps.find(ws, record.roadmapId);
      if (!roadmap) throw new NotFoundError();
      // Nothing started while the roadmap settled: the hold kept the scheduler away.
      for (const attempt of startedAttempts(roadmap)) {
        const cycle = tx.execution.cycles.find(ws, attempt.cycleId);
        if (cycle && cycle.status !== 'stopped' && cycle.status !== 'completed')
          throw new ExecutionRequestError(
            'conflict',
            `${cycle.workItemSourceId} is still ${cycle.status}; its cycle is stopped next.`,
          );
      }
      // A version chosen at the request may have come into use since: checked again here, in the
      // transaction that retires it (review F4). The step stays incomplete until the cause clears.
      const unwritten = current.retire.filter((c) => !tx.windDowns.retirement(ws, c.planVersionId));
      if (unwritten.length) {
        const owned = new Set<string>([
          ...startedAttempts(roadmap).map((a) => a.worktreeId),
          ...(roadmap.decisionPreparations ?? []).map((p) => p.worktreeId),
        ]);
        const refused = this.versions(tx, roadmap, owned).find(
          (v) => v.refusal && unwritten.some((c) => c.planVersionId === v.planVersionId),
        );
        if (refused?.refusal)
          windDownRefused(
            refused.refusal.code,
            `Version ${refused.versionNumber} of ${refused.projectName} cannot be retired now. ${refused.refusal.message}`,
          );
      }
      const retiring = current.retire.length > 0;
      if (!ended(roadmap)) {
        const { attention: _cleared, ...unattended } = roadmap;
        this.persist(
          tx,
          {
            ...unattended,
            status: 'stopped',
            reason: retiring ? WOUND_DOWN_REASON : STOPPED_REASON,
            version: roadmap.version + 1,
            updatedAt: at,
          },
          roadmap.version,
          retiring ? 'wind-down' : 'stop',
          context,
        );
      }
      const retired: { planVersionId: string; disposition: string; activeCleared: boolean }[] = [];
      for (const choice of current.retire) {
        if (
          !tx.windDowns.retire({
            ...choice,
            workspaceId: ws,
            windDownId: current.id,
            retiredAt: at,
            retiredByUserId: current.requestedByUserId,
          })
        )
          continue;
        const version = tx.planning.versions.find(ws, choice.planVersionId);
        if (!version) throw new NotFoundError();
        const activeCleared = tx.imports.deactivatePlan(ws, version.projectId, version.id);
        retired.push({ ...choice, activeCleared });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt: at,
          workspaceId: ws,
          actorKind: context ? 'user' : 'system',
          // Whoever finished it, with their session; the record keeps who chose it (review F9).
          actorUserId: context?.user.id ?? current.requestedByUserId,
          ...(context ? { sessionId: context.session.id } : {}),
          action: 'plan.version-retired',
          targetType: 'plan-version',
          targetId: version.id,
          outcome: 'succeeded',
          metadata: {
            projectId: version.projectId,
            roadmapId: current.roadmapId,
            windDownId: current.id,
            disposition: choice.disposition,
            activeCleared,
          },
        });
        tx.workspaceEvents.appendEvent({
          id: asEventId(randomUUID()),
          occurredAt: at,
          workspaceId: ws,
          actorUserId: context?.user.id ?? current.requestedByUserId,
          projectId: version.projectId,
          kind: 'plan-version-retired',
          payload: {
            planVersionId: version.id,
            roadmapId: roadmap.id,
            disposition: choice.disposition,
          },
        });
      }
      const { incomplete: _done, ...settling } = current;
      const settled: RoadmapWindDown = {
        ...settling,
        version: current.version + 1,
        status: 'settled',
        settledAt: at,
      };
      if (!tx.windDowns.replace(settled, current.version))
        throw new ConcurrentModificationError('The wind-down changed while it settled.');
      this.audit(tx, settled, 'settled', context, { retired });
      if (ended(roadmap)) this.event(tx, roadmap, roadmap.reason, context);
    });
  }

  /** Records the step that could not finish; the record's item asks the operator. */
  private incomplete(record: RoadmapWindDown, step: WindDownStep, error: unknown): void {
    const message = (error instanceof Error ? error.message : 'The step failed.').slice(0, 4000);
    const cause = causeOf(step, error);
    try {
      this.storage.transaction((tx) => {
        const current = tx.windDowns.find(record.workspaceId, record.roadmapId);
        if (current?.status !== 'settling') return;
        if (current.incomplete?.step === step && this.recorded.get(record.roadmapId) === cause)
          return;
        const next: RoadmapWindDown = {
          ...current,
          version: current.version + 1,
          incomplete: { step, at: this.now().toISOString(), message: message || 'Failed.' },
        };
        if (!tx.windDowns.replace(next, current.version)) return;
        this.audit(tx, next, 'incomplete', undefined, { step, message: next.incomplete!.message });
        this.recorded.set(record.roadmapId, cause);
      });
    } catch {
      // A record that cannot be written now is retried on the next pass.
    }
  }

  private audit(
    tx: StorageRepositories,
    record: RoadmapWindDown,
    phase: 'requested' | 'settled' | 'incomplete',
    context: AuthContext | undefined,
    metadata: Record<string, unknown>,
  ): void {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: this.now().toISOString(),
      workspaceId: record.workspaceId,
      actorKind: context ? 'user' : 'system',
      actorUserId: context?.user.id ?? record.requestedByUserId,
      ...(context ? { sessionId: context.session.id } : {}),
      action: 'roadmap.wind-down',
      targetType: 'roadmap',
      targetId: record.roadmapId,
      outcome: 'succeeded',
      resultingVersion: record.version,
      metadata: {
        phase,
        windDownId: record.id,
        status: record.status,
        ...(metadata as Record<string, import('@craftingtable/domain').JsonValue>),
      },
    });
  }

  /** Tells browsers the roadmap's wind-down changed (its record is read with the roadmap). */
  private event(
    tx: StorageRepositories,
    roadmap: Roadmap,
    reason: string,
    context: AuthContext | undefined,
  ): void {
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: this.now().toISOString(),
      workspaceId: roadmap.workspaceId,
      ...(context ? { actorUserId: context.user.id } : {}),
      kind: 'roadmap-changed',
      payload: { roadmapId: roadmap.id, status: roadmap.status, reason: reason.slice(0, 4000) },
    });
  }
}
