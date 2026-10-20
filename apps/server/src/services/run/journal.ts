/**
 * A run's journal and its end (R-B7): its events and tool results, its status transitions, the
 * operator's commands, and `finalize` with what it calls (the protected refs' check, the run's
 * temporary and agent directories).
 */
import { moveRecords, unrecordedMoves } from '../ref-watch.js';
import { randomUUID } from 'node:crypto';
import type { NormalizedAgentEvent } from '@craftingtable/agents';
import {
  type AgentBillingSource,
  type AgentExitReason,
  type AgentRun,
  type AgentRunEventPayload,
  type AgentRunId,
  type AgentRunStatus,
  type AgentRunVerdict,
  asAgentRunEventId,
  asAuditEventId,
  asEventId,
  isTerminalAgentRunStatus,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { removeAgentTree } from '../agent-tree.js';
import { offloadToolResult, readToolResult } from '../tool-result-store.js';
import type { AuthContext } from '../auth-service.js';
import { NotFoundError } from '../errors.js';
import type { RuntimeEvidenceService } from '../runtime-evidence-service.js';
import type { StorageService } from '../storage-service.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { WorkspaceService } from '../workspace-service.js';
import { LIVE_STATUSES, type RunLog, summarise } from './shared.js';

import type { RunState } from './state.js';

function appendStatusChanged(
  tx: StorageRepositories,
  run: AgentRun,
  fromStatus: AgentRunStatus,
  occurredAt: string,
): void {
  tx.workspaceEvents.appendEvent({
    id: asEventId(randomUUID()),
    occurredAt,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    runId: run.id,
    kind: 'agent-run-status-changed',
    payload: {
      runId: run.id,
      ...(run.workItemId ? { workItemId: run.workItemId } : { planVersionId: run.planVersionId }),
      fromStatus,
      toStatus: run.status,
    },
  });
}

export class RunJournal {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date,
    private readonly log: RunLog,
    private readonly storageService: StorageService,
    private readonly runtimeEvidence: RuntimeEvidenceService,
    private readonly state: RunState,
  ) {}

  appendEvent(workspaceId: WorkspaceId, runId: AgentRunId, event: NormalizedAgentEvent): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId,
        runId,
        occurredAt,
        kind: event.kind,
        payload:
          event.kind === 'tool-result'
            ? this.journalToolResult(tx, runId, event.payload)
            : event.payload,
        ...(event.raw === undefined ? {} : { raw: event.raw }),
      } as Parameters<typeof tx.execution.runEvents.append>[0]);
    });
    if (['session-started', 'turn-completed', 'run-finished'].includes(event.kind))
      this.notifier.notify('workflow');
    else this.activitySoon();
  }

  /**
   * One `activity` notification at the end of the macrotask, for every ordinary event appended in
   * it (R-B5 decision 6 B): its readers (the scheduler's attention cache) need to know that
   * something moved, not each event; the streams wake on the run's own channel per commit.
   */
  private activitySoon(): void {
    if (this.activityQueued) return;
    this.activityQueued = true;
    setImmediate(() => {
      this.activityQueued = false;
      this.notifier.notify('activity');
    });
  }
  private activityQueued = false;

  /**
   * A large tool result keeps only a preview in the journal; its body goes to the run's
   * directory (R-H2). Without a registered directory, or when the write fails, the whole
   * output is journaled as before.
   */
  journalToolResult(
    tx: StorageRepositories,
    runId: AgentRunId,
    payload: AgentRunEventPayload<'tool-result'>,
  ): AgentRunEventPayload<'tool-result'> {
    const directory = tx.maintenance.directory(runId)?.path;
    if (directory === undefined) return payload;
    try {
      return offloadToolResult(payload, directory);
    } catch {
      return payload;
    }
  }

  /** The full output of a tool result whose body left the journal (R-H2). */
  toolResult(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    digest: string,
    requestId?: string,
  ): string {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const run = this.storage.execution.runs.find(workspaceId, runId);
    const directory = run && this.storage.maintenance.directory(run.id)?.path;
    const body = directory === undefined ? undefined : readToolResult(directory, digest);
    if (body === undefined) throw new NotFoundError();
    return body;
  }

  /**
   * Guarded status transition. Emits a workspace event only when the status
   * actually changed, so per-event bookkeeping (session id, cost) stays out of
   * the workspace journal.
   */
  transition(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    expectedStatuses: readonly AgentRunStatus[],
    toStatus: AgentRunStatus,
    fields: {
      readonly backendSessionId?: string;
      readonly resolvedModel?: string;
      readonly billing?: AgentBillingSource;
      readonly verdict?: AgentRunVerdict | null;
      readonly startedAt?: string;
      readonly exitCode?: number;
      readonly outcomeSummary?: string;
      readonly costUsd?: number;
      readonly turnCountIncrement?: number;
    },
  ): AgentRun | undefined {
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const before = tx.execution.runs.find(workspaceId, runId);
      if (before === undefined || !expectedStatuses.includes(before.status)) {
        return undefined;
      }
      const after = tx.execution.runs.transition({
        workspaceId,
        runId,
        expectedStatuses,
        toStatus,
        occurredAt,
        ...fields,
      });
      if (after === undefined) {
        return undefined;
      }
      if (before.status !== after.status) {
        appendStatusChanged(tx, after, before.status, occurredAt);
      }
      return { before, after };
    });
    if (result !== undefined && result.before.status !== result.after.status) {
      this.notifier.notify();
    }
    return result?.after;
  }

  finalize(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    status: Extract<AgentRunStatus, 'finished' | 'failed' | 'cancelled' | 'interrupted'>,
    detail: {
      readonly exitCode?: number;
      readonly signal?: string;
      readonly message?: string;
      readonly reason?: AgentExitReason;
    },
  ): void {
    clearTimeout(this.state.preparationTimers.get(runId));
    this.state.preparationTimers.delete(runId);
    this.state.live.delete(runId);
    const occurredAt = this.now().toISOString();
    let changed: boolean;
    try {
      changed = this.storage.transaction((tx) => {
        tx.phaseScheduling.release(runId, occurredAt, status);
        const before = tx.execution.runs.find(workspaceId, runId);
        if (before === undefined || isTerminalAgentRunStatus(before.status)) {
          return false;
        }
        this.runtimeEvidence.freezeRun(tx, workspaceId, runId, this.state.checks?.inFlight(runId));
        const after = tx.execution.runs.transition({
          workspaceId,
          runId,
          expectedStatuses: LIVE_STATUSES,
          toStatus: status,
          occurredAt,
          finishedAt: occurredAt,
          ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
          ...(detail.reason ? { verdict: null } : {}),
          ...(detail.message === undefined || before.outcomeSummary !== undefined
            ? {}
            : { outcomeSummary: summarise(detail.message) }),
        });
        if (after === undefined) {
          return false;
        }
        tx.execution.runEvents.append({
          id: asAgentRunEventId(randomUUID()),
          workspaceId,
          runId,
          occurredAt,
          kind: 'run-finished',
          payload: {
            status,
            ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
            ...(detail.signal === undefined ? {} : { signal: detail.signal }),
            ...(detail.reason === undefined ? {} : { reason: detail.reason }),
            ...(detail.message === undefined ? {} : { message: detail.message }),
          },
        });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt,
          actorKind: 'system',
          workspaceId,
          action: 'agent-run.finished',
          targetType: 'agent-run',
          targetId: runId,
          outcome: status === 'finished' ? 'succeeded' : 'failed',
          priorVersion: before.version,
          resultingVersion: after.version,
          metadata: {
            status,
            ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
            turnCount: after.turnCount,
            ...(after.costUsd === undefined ? {} : { costUsd: after.costUsd }),
            ...(after.verdict === undefined ? {} : { verdict: after.verdict }),
          },
        });
        appendStatusChanged(tx, after, before.status, occurredAt);
        return true;
      });
    } finally {
      // After the run's record, and even if it failed, so nothing an agent left can keep a run
      // from ending, and its directory never waits for a restart (LIVE-31 review).
      this.removeProcessTemporaryDirectory(runId);
    }
    // Checks still running record nothing: the build record was frozen above.
    const checks = this.state.checks?.close(runId);
    if (checks) {
      const stopping = checks
        .catch((error) => this.log.warn('Check cleanup failed', { runId, error: String(error) }))
        .finally(() => this.state.cleanups.delete(stopping));
      this.state.cleanups.add(stopping);
    }
    if (changed) {
      const run = this.storage.execution.runs.find(workspaceId, runId);
      const cleanup = Promise.resolve(this.checkProtectedRefs(workspaceId, runId))
        // A failed comparison must not skip the run's other cleanup (R-G5 review).
        .catch((error) =>
          this.log.warn('Protected-ref check failed', { runId, error: String(error) }),
        )
        .then(() => this.runtimeEvidence.cleanupRun(workspaceId, runId))
        .then(() =>
          run && status !== 'interrupted'
            ? this.storageService.cleanupAfterRun(run.worktreeId)
            : undefined,
        )
        .catch((error) => this.log.warn('Run cleanup failed', { runId, error: String(error) }))
        .finally(() => {
          this.state.cleanups.delete(cleanup);
          this.notifier.notify();
        });
      this.state.cleanups.add(cleanup);
      this.notifier.notify();
    }
  }

  recordCommand(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    action: 'agent-run.end' | 'agent-run.cancel',
    requestId?: string,
  ): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action,
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'succeeded',
        metadata: {},
      });
    });
  }

  /** Flags protected branches that moved during a run by something other than the daemon. */
  async checkProtectedRefs(workspaceId: WorkspaceId, runId: AgentRunId): Promise<void> {
    if (!this.state.refWatch) return;
    const run = this.storage.execution.runs.find(workspaceId, runId);
    const tree = run && this.storage.execution.worktrees.find(workspaceId, run.worktreeId);
    const owned = this.storage.execution.worktrees
      .listActive(workspaceId)
      .filter((w) => w.repositoryId === tree?.repositoryId)
      .map((w) => w.branchName)
      .concat(tree ? [tree.branchName] : []);
    const moves = await this.state.refWatch.watch.unexplainedMoves(
      runId,
      this.state.refWatch.git,
      owned,
    );
    if (!moves.length) return;
    const described = moves
      .map(
        (m) =>
          `${m.branch} ${m.before?.slice(0, 12) ?? '(absent)'} → ${m.after?.slice(0, 12) ?? '(deleted)'}`,
      )
      .join(', ');
    this.appendEvent(workspaceId, runId, {
      kind: 'notice',
      payload: {
        category: 'other',
        message: `Protected branches moved during this run, not by CraftingTable: ${described}.`,
      },
    });
    const detectedAt = this.now().toISOString();
    // The audit stands on its own, so nothing about the records below can lose it.
    this.storage.transaction((tx) =>
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: detectedAt,
        actorKind: 'system',
        workspaceId,
        action: 'agent-run.protected-ref-moved',
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'failed',
        metadata: {
          repositoryId: tree?.repositoryId ?? null,
          moves: moves.map((m) => ({ branch: m.branch, before: m.before, after: m.after })),
        },
      }),
    );
    // Kept until the operator acknowledges it; the inbox shows it until then. A move another
    // run already recorded is not recorded again, and a large set takes several records.
    if (tree)
      this.storage.transaction((tx) => {
        const fresh = unrecordedMoves(
          tx.protectedRefs.unacknowledged(workspaceId, tree.repositoryId),
          moves.map((m) => ({ branch: m.branch, before: m.before, after: m.after })),
        );
        for (const chunk of moveRecords(fresh))
          tx.protectedRefs.add({
            id: randomUUID(),
            workspaceId,
            repositoryId: tree.repositoryId,
            runId,
            worktreeId: tree.id,
            detectedAt,
            moves: chunk,
          });
      });
  }

  removeProcessTemporaryDirectory(runId: AgentRunId): void {
    const directory = this.state.processTemporaryDirectories.get(runId);
    if (directory === undefined) return;
    this.state.processTemporaryDirectories.delete(runId);
    this.removeAgentDirectory(directory, { runId });
  }

  /**
   * Removes an agent's directory in the background, as a run's scratch is, never following
   * what the agent left (LIVE-31 verification). `quiesce` waits for it; a failure is logged.
   */
  removeAgentDirectory(directory: string, context: Record<string, string> = {}): void {
    const removing: Promise<void> = removeAgentTree(directory)
      .then((failure) => {
        if (failure)
          this.log.warn("An agent's temporary directory could not be removed", {
            ...context,
            directory,
            error: failure,
          });
      })
      // Nothing here may become an unhandled rejection, not even a failing log.
      .catch(() => undefined)
      .finally(() => this.state.cleanups.delete(removing));
    this.state.cleanups.add(removing);
  }
}
