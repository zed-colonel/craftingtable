import type { AgentSessionItem } from '@craftingtable/agents';
import type { AgentRunStatus, WorktreeId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { assessStageReport } from '../finalization-stage-policy.js';
import { assessReviewReport, finalVerdict } from '../review-report.js';
import { requiredFindingIds } from '../run-lineage.js';
import { scopeRepairPacket } from '../scope-repair.js';
import type { WorkspaceEventNotifier } from '../workspace-event-notifier.js';
import type { WorktreeMutationGuard } from '../worktree-mutation-guard.js';
import {
  DRAIN_INTERRUPTED_MESSAGE,
  drainUntilExit,
  type LiveRun,
  type RunLog,
  summarise,
} from './shared.js';

import type { RunState } from './state.js';
import type { RunJournal } from './journal.js';
import type { RunProcesses } from './processes.js';

export class RunSupervision {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly log: RunLog,
    private readonly mutations: WorktreeMutationGuard,
    private readonly state: RunState,
    private readonly journal: RunJournal,
    private readonly processes: RunProcesses,
  ) {}

  /**
   * Consumes the session. If supervision itself fails (a storage write, a
   * report assessment), the agent must not keep working unobserved: its process
   * group is killed, the run is closed as failed, and the worktree stays
   * reserved until the session reports its exit (AGT-01).
   */
  async supervise(liveRun: LiveRun, worktreeId: WorktreeId): Promise<void> {
    const items = liveRun.session.items[Symbol.asyncIterator]();
    try {
      await this.consume(liveRun, items);
    } catch (error) {
      const { workspaceId, runId } = liveRun;
      this.log.warn('agent run consumer failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      liveRun.cancelRequested = true;
      liveRun.session.kill();
      this.state.orphaned.add(liveRun);
      const reserved = this.mutations.untilExited(worktreeId, drainUntilExit(items));
      try {
        this.journal.finalize(workspaceId, runId, 'failed', { message: 'Run supervision failed' });
      } catch (finalizeError) {
        this.log.warn('agent run finalization failed', {
          runId,
          error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
        });
      }
      await reserved;
      // Not at the finalize above: the killed group may outlive it (R-G11 review LOW-4).
      this.processes.removeProcessRecord(runId);
      this.state.orphaned.delete(liveRun);
      this.notifier.notify();
    }
  }

  /**
   * Iterates by hand rather than with `for await`: an exception in the loop body
   * must not close the backend's stream, because `supervise` keeps reading it to
   * learn when the killed process has exited.
   */
  async consume(liveRun: LiveRun, items: AsyncIterator<AgentSessionItem>): Promise<void> {
    const { workspaceId, runId } = liveRun;
    const read = async () => {
      liveRun.awaitingItem = true;
      try {
        return await items.next();
      } finally {
        liveRun.awaitingItem = false;
      }
    };
    for (let next = await read(); next.done !== true; next = await read()) {
      const item = next.value;
      if (item.type === 'exited') {
        // Its process group is gone: nothing is left for a restart to end (R-G11 review).
        this.processes.removeProcessRecord(runId);
        const lastTurn = this.storage.execution.runEvents.latestOfKind(
          workspaceId,
          runId,
          'turn-completed',
        );
        const serviceFailed =
          lastTurn?.kind === 'turn-completed' &&
          lastTurn.payload.outcome === 'error' &&
          !!lastTurn.payload.providerFailure;
        // While the daemon is stopping on a signal, a signal the daemon did not send is the
        // service manager stopping the unit's whole process group: that is a restart, not a
        // failure. During a deploy's drain nothing else is stopping, so a signal-killed
        // agent (OOM, crash) is a failure and keeps the explicit resume.
        const drained =
          liveRun.drainInterrupted === true ||
          (this.state.serviceStopping && !liveRun.cancelRequested && item.signal !== null);
        const status: AgentRunStatus = drained
          ? 'interrupted'
          : liveRun.cancelRequested
            ? 'cancelled'
            : item.exitCode === 0 && !item.reason && !serviceFailed
              ? 'finished'
              : 'failed';
        this.journal.finalize(workspaceId, runId, status, {
          ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
          ...(item.signal === null ? {} : { signal: item.signal }),
          ...(drained
            ? { reason: 'daemon-drain' as const, message: DRAIN_INTERRUPTED_MESSAGE }
            : item.reason
              ? {
                  reason: item.reason,
                  message:
                    item.reason === 'background-work-incomplete'
                      ? 'The agent exited before collecting background work and reporting completion. Its process group has finished; the last message is an incomplete outcome.'
                      : 'Background work exceeded the step time limit and was terminated. Inspect partial verification results before resuming.',
                }
              : status === 'cancelled' && liveRun.cancelMessage
                ? { message: liveRun.cancelMessage }
                : {}),
        });
        return;
      }
      let event = item.event;
      if (event.kind === 'turn-completed') {
        const run = this.storage.execution.runs.find(workspaceId, runId);
        if (run?.role === 'review') {
          const repairCycle = this.storage.execution.cycles.activeForWorktree(
            run.workspaceId,
            run.worktreeId,
          );
          const repairIds = repairCycle?.scopeRepair
            ? scopeRepairPacket(this.storage, repairCycle).sources.flatMap((s) =>
                s.findings.map((f) => f.id),
              )
            : [];
          let reviewReport =
            event.payload.outcome === 'error'
              ? {
                  status: 'invalid' as const,
                  fault: 'content' as const,
                  issues: ['The review turn failed; request a successful consolidated report.'],
                }
              : assessReviewReport(
                  event.payload.resultText,
                  event.payload.truncated,
                  new Set([...requiredFindingIds(this.storage.execution, run), ...repairIds]),
                );
          const stagedCycle = this.storage.execution.cycles.activeForWorktree(
            run.workspaceId,
            run.worktreeId,
          );
          const staged = stagedCycle?.finalizationId
            ? this.storage.execution.finalizations.find(run.workspaceId, stagedCycle.finalizationId)
            : undefined;
          if (staged?.stages && stagedCycle?.currentRunId === run.id)
            reviewReport = assessStageReport(
              staged,
              stagedCycle,
              reviewReport,
              run.reviewBranchContext,
            );
          event = { ...event, payload: { ...event.payload, reviewReport } };
        }
      }
      this.journal.appendEvent(workspaceId, runId, event);
      switch (event.kind) {
        case 'session-started':
          this.journal.transition(
            workspaceId,
            runId,
            ['starting', 'running', 'waiting'],
            'running',
            {
              backendSessionId: event.payload.backendSessionId,
              resolvedModel: event.payload.model,
              billing: event.payload.billing,
            },
          );
          break;
        case 'assistant-message':
        case 'tool-call':
          // A message queued during the preceding turn can start after its result
          // moved the run to waiting. Activity belongs to the new turn.
          this.journal.transition(workspaceId, runId, ['waiting'], 'running', {});
          break;
        case 'turn-completed': {
          const run = this.storage.execution.runs.find(workspaceId, runId);
          const verdict =
            run?.role === 'review' &&
            event.payload.outcome === 'success' &&
            event.payload.reviewReport?.status !== 'invalid'
              ? finalVerdict(event.payload.resultText)
              : undefined;
          this.journal.transition(
            workspaceId,
            runId,
            ['starting', 'running', 'waiting'],
            'waiting',
            {
              turnCountIncrement: 1,
              ...(event.payload.model === undefined ? {} : { resolvedModel: event.payload.model }),
              outcomeSummary: summarise(event.payload.resultText),
              ...(event.payload.costUsd === undefined ? {} : { costUsd: event.payload.costUsd }),
              ...(run?.role === 'review' ? { verdict: verdict ?? null } : {}),
            },
          );
          if (this.state.preparationTimers.has(runId)) liveRun.session.end();
          break;
        }
        default:
          break;
      }
    }
  }
}
