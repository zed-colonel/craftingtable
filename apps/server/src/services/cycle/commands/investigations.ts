import { investigationAgent } from '../../agent-profile-policy.js';
import { asCycleInvestigationId, type WorkCycleId } from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import type { StartInvestigationRequest } from '@craftingtable/contracts';
import {
  asAgentRunId,
  type CycleInvestigation,
  type InvestigationWorktree,
  type InvestigationWorktreeChange,
  isTerminalAgentRunStatus,
  stopCode,
  type WorkCycle,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations, WorktreeSnapshot } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from '../../agent-run-service.js';
import type { CommandContext } from '../../auth-service.js';
import {
  investigationDocuments,
  investigationResult,
  investigationRules,
  investigationWorktree,
  questionsDigest,
  stopQuestions,
  worktreeChange,
  worktreeChangeOpen,
} from '../../investigation.js';
import { ConcurrentModificationError, ExecutionRequestError, NotFoundError } from '../../errors.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

export type { CyclePassObserver } from '../shared.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleLocks } from '../locks.js';
import { RESTORED_CHECK_MS, STUCK_INVESTIGATION_MS } from '../shared.js';

export class CycleInvestigations {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly mutations: WorktreeMutationGuard,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly locks: CycleLocks,
  ) {}

  /**
   * Starts a read-only investigation of the stop's questions (R-C16). It runs beside the cycle,
   * which keeps its stop: the operator answers through the stop's own control, with the
   * proposals to start from. One at a time; nothing retries or continues it automatically.
   */
  async startInvestigation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    input: StartInvestigationRequest,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== input.expectedVersion)
      throw new ConcurrentModificationError('Cycle changed; refresh and try again.');
    this.gates.requireNoInvestigation(cycle);
    const asked = stopQuestions(this.storage, cycle);
    const code = stopCode(cycle);
    if (!asked || code === undefined)
      throw new ExecutionRequestError('conflict', 'This stop holds no questions to investigate.');
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (tree?.status !== 'active')
      throw new ExecutionRequestError('conflict', 'The worktree is no longer active.');
    this.mutations.requireAvailable(cycle.worktreeId);
    if (this.storage.execution.runs.liveForWorktree(workspaceId, cycle.worktreeId).length > 0)
      throw new ExecutionRequestError(
        'conflict',
        'End the live session in this worktree before starting an investigation.',
      );
    if (this.storage.execution.merges.latest(workspaceId, cycle.worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError(
        'conflict',
        'Recover the reserved integration merge before starting an investigation.',
      );
    // The worktree as the run will find it: compared once the run has ended (R-C16, TS-M3).
    let worktree: InvestigationWorktree | undefined;
    if (this.git) {
      const snapshot = await this.git.snapshotWorktree(tree.path);
      if (!snapshot.ok)
        throw new ExecutionRequestError(
          'unavailable',
          `The worktree could not be read before the investigation: ${snapshot.failure.message}`,
        );
      worktree = investigationWorktree(snapshot.value);
    }
    const profile = investigationAgent(this.storage, cycle, input.profile).selection;
    if (!this.runs.hasBackend(profile.backend))
      throw new ExecutionRequestError(
        'unavailable',
        'The investigation profile’s agent backend is not available on this workstation.',
      );
    const startedAt = this.now();
    const record: CycleInvestigation = {
      id: asCycleInvestigationId(randomUUID()),
      runId: asAgentRunId(randomUUID()),
      sourceRunId: asked.sourceRunId,
      code,
      questionsDigest: questionsDigest(asked.questions),
      profile,
      instructions: input.instructions,
      minutes: input.minutes,
      deadlineAt: new Date(startedAt.getTime() + input.minutes * 60_000).toISOString(),
      startedAt: startedAt.toISOString(),
      startedByUserId: context.user.id,
      ...(worktree ? { worktree } : {}),
    };
    const documents = await investigationDocuments(
      this.storage,
      this.git,
      cycle,
      record,
      asked.questions,
    );
    // Settling waits for this launch; a record with neither a run nor a launch is over (M3).
    this.locks.launchingInvestigations.add(record.id);
    let updated: WorkCycle;
    try {
      updated = this.writer.change(
        cycle,
        { investigation: record },
        'investigation-started',
        context,
      );
    } catch (error) {
      this.locks.launchingInvestigations.delete(record.id);
      throw error;
    }
    const check = () => {
      const current = this.storage.execution.cycles.find(workspaceId, id);
      if (current?.investigation?.id !== record.id || current.investigation.result)
        throw new ExecutionRequestError(
          'conflict',
          'The stop changed before the investigation started.',
        );
    };
    try {
      await this.runs.startInvestigation(
        context,
        updated,
        { value: record, documents, check },
        investigationRules(record),
      );
    } catch (error) {
      // A launch that never recorded its run ends the investigation here; one that did is read
      // back from its run like any other.
      const current = this.storage.execution.cycles.find(workspaceId, id);
      if (
        current?.investigation?.id === record.id &&
        !current.investigation.result &&
        !this.storage.execution.runs.find(workspaceId, record.runId)
      )
        this.writer.change(
          current,
          {
            investigation: {
              ...record,
              result: {
                endedAt: this.now().toISOString(),
                outcome: 'failed',
                message: (error instanceof Error
                  ? error.message
                  : 'The investigation did not start.'
                ).slice(0, 4000),
              },
            },
          },
          'investigation-failed',
        );
      throw error;
    } finally {
      this.locks.launchingInvestigations.delete(record.id);
    }
    return this.storage.execution.cycles.find(workspaceId, id) ?? updated;
  }

  /**
   * Ends the stop's live investigation: the one command the stop accepts while it runs. A run
   * whose worktree was recorded is only asked to end here; its result is written once its
   * process has exited and the worktree is compared, which may find the operator's own End
   * left a changed tree (R-C16, RC F-7). Until then the stop waits, as it did while it ran.
   * A roadmap's Stop (`stopping`) ends the cycle next, so nothing will build on the tree: its
   * investigation ends at once, uncompared.
   */
  async endInvestigation(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
    stopping = false,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== expectedVersion)
      throw new ConcurrentModificationError('Cycle changed; refresh and try again.');
    const investigation = cycle.investigation;
    if (!investigation || investigation.result)
      throw new ExecutionRequestError('conflict', 'No investigation of this stop is running.');
    const run = this.storage.execution.runs.find(workspaceId, investigation.runId);
    if (run && !isTerminalAgentRunStatus(run.status))
      this.runs.cancelInvestigation(workspaceId, run.id, 'Ended by the operator.');
    if (investigation.worktree && run && !stopping) {
      // Recorded, with who asked, for the stop and the audit; a run that has already ended is
      // compared now, a live one at its exit.
      const requested = this.writer.change(
        cycle,
        {
          investigation: {
            ...investigation,
            endRequestedAt: this.now().toISOString(),
            endRequestedByUserId: context.user.id,
          },
        },
        'investigation-end-requested',
        context,
      );
      await this.settleInvestigation(requested);
      return this.storage.execution.cycles.find(workspaceId, id) ?? requested;
    }
    const ended =
      run && isTerminalAgentRunStatus(run.status)
        ? investigationResult(this.storage, run, this.now().toISOString())
        : {
            endedAt: this.now().toISOString(),
            outcome: 'cancelled' as const,
            message: 'Ended by the operator.',
          };
    return this.writer.change(
      cycle,
      { investigation: { ...investigation, result: ended } },
      'investigation-ended',
      context,
    );
  }

  /**
   * Reads an investigation's ended run back into the cycle: its proposals, or why it failed.
   * A recorded worktree is compared first, once no agent is still exiting in it (R-C16 review
   * M-1); a difference fails the investigation as `worktree-changed`, whatever its run found.
   */
  async settleInvestigation(cycle: WorkCycle): Promise<void> {
    const investigation = cycle.investigation;
    if (!investigation || investigation.result) return;
    if (this.locks.launchingInvestigations.has(investigation.id)) return;
    if (this.locks.settlingInvestigations.has(investigation.id)) return;
    const run = this.storage.execution.runs.find(cycle.workspaceId, investigation.runId);
    const now = this.now();
    if (!run) {
      // No launch is in flight and none recorded its run: the daemon restarted, or the launch
      // failed before its record. Either way it is over, now (R-C16 review M3).
      this.writer.change(cycle, {
        investigation: {
          ...investigation,
          result: {
            endedAt: now.toISOString(),
            outcome: 'failed',
            message: 'The investigation did not start. Start another if needed.',
          },
        },
      });
      return;
    }
    if (!isTerminalAgentRunStatus(run.status)) {
      // Its timer ends a live run at the deadline; a run left unfinished well past it, with no
      // process to end, is closed so the stop does not wait on it.
      if (now.getTime() > Date.parse(investigation.deadlineAt) + STUCK_INVESTIGATION_MS)
        this.runs.cancelInvestigation(
          cycle.workspaceId,
          run.id,
          'The investigation outlived its time limit.',
        );
      return;
    }
    let change: InvestigationWorktreeChange | undefined;
    let current = cycle;
    if (investigation.worktree) {
      if (this.mutations.agentTerminating(cycle.worktreeId)) return;
      this.locks.settlingInvestigations.add(investigation.id);
      try {
        change = worktreeChange(investigation.worktree, await this.investigatedTree(cycle));
      } finally {
        this.locks.settlingInvestigations.delete(investigation.id);
      }
      // The inspection awaited Git: settle what the cycle holds now.
      const reread = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (reread?.investigation?.id !== investigation.id || reread.investigation.result) return;
      current = reread;
    }
    const result = investigationResult(this.storage, run, this.now().toISOString());
    this.writer.change(
      current,
      {
        investigation: {
          ...(current.investigation ?? investigation),
          result: change
            ? { ...result, outcome: 'failed', code: 'worktree-changed', worktreeChange: change }
            : result,
        },
      },
      change ? 'investigation-worktree-changed' : 'investigation-finished',
    );
  }

  /** The investigated worktree as it is now, or nothing when it cannot be read (R-C16). */
  async investigatedTree(cycle: WorkCycle): Promise<WorktreeSnapshot | undefined> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !this.git) return undefined;
    const snapshot = await this.git.snapshotWorktree(tree.path);
    return snapshot.ok ? snapshot.value : undefined;
  }

  /**
   * An open worktree change is released when the tree matches its record again (R-C16); the
   * controller checks at most every `RESTORED_CHECK_MS`.
   */
  async checkWorktreeRestored(cycle: WorkCycle): Promise<void> {
    const investigation = cycle.investigation;
    if (!investigation?.worktree || !investigation.result) return;
    const last = this.locks.restoredChecks.get(investigation.id) ?? 0;
    if (this.now().getTime() - last < RESTORED_CHECK_MS) return;
    this.locks.restoredChecks.set(investigation.id, this.now().getTime());
    if (worktreeChange(investigation.worktree, await this.investigatedTree(cycle))) return;
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (!current?.investigation?.result || current.investigation.id !== investigation.id) return;
    if (!worktreeChangeOpen(current)) return;
    this.locks.restoredChecks.delete(investigation.id);
    this.writer.change(
      current,
      {
        investigation: {
          ...current.investigation,
          result: { ...current.investigation.result, restoredAt: this.now().toISOString() },
        },
      },
      'investigation-worktree-restored',
    );
  }

  /**
   * The operator has seen that the worktree changed while the stop's investigation ran (R-C16).
   * The stop's commands are accepted again; nothing in the tree is reset.
   */
  acknowledgeWorktreeChange(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: WorkCycleId,
    expectedVersion: number,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== expectedVersion)
      throw new ConcurrentModificationError('Cycle changed; refresh and try again.');
    const result = cycle.investigation?.result;
    if (!cycle.investigation || !result || !worktreeChangeOpen(cycle))
      throw new ExecutionRequestError(
        'conflict',
        'No worktree change of this stop’s investigation is waiting to be acknowledged.',
      );
    this.locks.restoredChecks.delete(cycle.investigation.id);
    return this.writer.change(
      cycle,
      {
        investigation: {
          ...cycle.investigation,
          result: {
            ...result,
            acknowledgedAt: this.now().toISOString(),
            acknowledgedByUserId: context.user.id,
          },
        },
      },
      'investigation-change-acknowledged',
      context,
    );
  }
}
