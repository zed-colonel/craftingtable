import { createHash, randomUUID } from 'node:crypto';
import type { StartWorkCycleRequest } from '@craftingtable/contracts';
import {
  type AgentRun,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  type CycleStep,
  designHasNoOpenQuestions,
  evaluateCompletion,
  isTerminalAgentRunStatus,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AgentRunService } from './agent-run-service.js';
import type { AuthContext } from './auth-service.js';
import type { BranchService } from './branch-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { latestReviewReport, runLineage } from './run-handoff.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationGuard } from './worktree-mutation-guard.js';

/** Single-daemon controller. Reservations precede process launch; restart never replays a launch. */
export class WorkCycleService {
  private readonly abort = new AbortController();
  private task: Promise<void> | undefined;
  private readonly ending = new Set<string>();

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly runs: AgentRunService,
    private readonly git: GitOperations | undefined,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly now: () => Date = () => new Date(),
    private readonly mutations: WorktreeMutationGuard = new WorktreeMutationGuard(),
    private readonly branches?: BranchService,
  ) {}

  list(context: AuthContext, workspaceId: WorkspaceId): readonly WorkCycle[] {
    this.workspaceService.requireAuthorized(context, workspaceId);
    return this.storage.execution.cycles.list(workspaceId);
  }

  start(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartWorkCycleRequest,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    if (Object.values(input.profiles).some((profile) => !this.runs.hasBackend(profile.backend)))
      throw new ExecutionRequestError(
        'unavailable',
        'Every cycle step must use an available agent backend',
      );
    if (this.git === undefined)
      throw new ExecutionRequestError('unavailable', 'Git is required for an automated cycle');
    const worktree = this.storage.execution.worktrees.find(workspaceId, input.worktreeId);
    if (!worktree || worktree.workItemId !== workItemId) throw new NotFoundError();
    this.mutations.requireAvailable(input.worktreeId);
    const item = this.requireReady(workspaceId, workItemId);
    if (worktree.status !== 'active')
      throw new ExecutionRequestError('conflict', 'Worktree has been removed');
    if (
      this.storage.execution.cycles
        .list(workspaceId)
        .some(
          (cycle) =>
            cycle.workItemId === workItemId && !['stopped', 'completed'].includes(cycle.status),
        )
    ) {
      throw new ExecutionRequestError('conflict', 'This work item already has an active cycle');
    }
    const prior = this.storage.execution.runs.listForWorktree(workspaceId, input.worktreeId);
    if (prior.some((run) => !isTerminalAgentRunStatus(run.status))) {
      throw new ExecutionRequestError(
        'conflict',
        'End the open agent sessions before starting automation',
      );
    }
    const occurredAt = this.now().toISOString();
    const cycle: WorkCycle = {
      id: randomUUID(),
      workspaceId,
      workItemId,
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      workItemSourceId: item.sourceId,
      workItemTitle: item.title,
      createdByUserId: context.user.id,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      version: 1,
      status: 'running',
      step: 'design',
      policy: input.policy,
      profiles: input.profiles,
      instructions: input.instructions,
      currentRunId: asAgentRunId(randomUUID()),
      ...(prior[0] === undefined ? {} : { parentRunId: prior[0].id }),
      runDeadlineAt: this.deadline(input.policy.maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      reason:
        'Starting design. Automation pauses at unresolved design questions or merge approval.',
    };
    this.storage.transaction((tx) => {
      tx.execution.cycles.insert(cycle);
      this.record(tx, cycle, 'start', context);
    });
    this.notifier.notify();
    return cycle;
  }

  async control(
    context: AuthContext,
    workspaceId: WorkspaceId,
    id: string,
    action: 'pause' | 'resume' | 'stop',
    expectedVersion: number,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (cycle.version !== expectedVersion)
      throw new ExecutionRequestError(
        'conflict',
        'Cycle changed; refresh before issuing this command',
      );
    if (['stopped', 'completed'].includes(cycle.status))
      throw new ExecutionRequestError('conflict', 'This cycle has ended');
    if (action === 'stop') {
      const stopped = this.change(
        cycle,
        { status: 'stopped', reason: 'Automation stopped by operator. Manual flow is available.' },
        action,
        context,
      );
      this.runs.finishCycleTurn(stopped, true);
      return stopped;
    }
    if (action === 'pause') {
      return this.change(
        cycle,
        {
          status: 'paused',
          reason:
            'Automation paused by operator. The current session remains available for manual work.',
        },
        action,
        context,
      );
    }
    if (!['paused', 'needs-attention'].includes(cycle.status))
      throw new ExecutionRequestError('conflict', 'Only a paused cycle can resume');
    this.mutations.requireAvailable(cycle.worktreeId);
    this.requireReady(workspaceId, cycle.workItemId);
    const allRuns = this.storage.execution.runs.listForWorktree(workspaceId, cycle.worktreeId);
    const run = allRuns[0];
    if (
      allRuns.some(
        (candidate) => candidate.id !== run?.id && !isTerminalAgentRunStatus(candidate.status),
      )
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'End other open sessions before resuming automation',
      );
    }
    this.ending.delete(cycle.currentRunId);
    // Manual work is adopted only by this explicit operator command. A manually completed
    // review is reviewed again because the controller did not record its starting commit.
    if (run && run.id !== cycle.currentRunId && run.id !== cycle.parentRunId) {
      const anchor =
        this.storage.execution.runs.find(workspaceId, cycle.currentRunId)?.id ?? cycle.parentRunId;
      if (
        anchor !== undefined &&
        !runLineage(this.storage.execution, run).some((source) => source.id === anchor)
      ) {
        throw new ExecutionRequestError(
          'conflict',
          'The latest manual run does not continue this cycle’s handoff lineage. Continue from the cycle run, or stop this cycle before starting a new one.',
        );
      }
      if (run.role === 'review' && isTerminalAgentRunStatus(run.status))
        return this.next(cycle, 'review', run, context);
      if (run.role === 'review')
        throw new ExecutionRequestError(
          'conflict',
          'End the manual review before resuming automation',
        );
      return this.change(
        cycle,
        {
          status: 'running',
          step: run.role,
          currentRunId: run.id,
          runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
          reason: 'Resumed with the latest manual run.',
        },
        action,
        context,
      );
    }
    if (!run || ['failed', 'cancelled', 'interrupted'].includes(run.status)) {
      return this.next(cycle, cycle.step, run, context);
    }
    if (cycle.step === 'review' && run.status === 'finished') {
      return this.next(cycle, 'review', run, context);
    }
    return this.change(
      cycle,
      {
        status: 'running',
        runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
        reason: 'Automation resumed by operator.',
      },
      action,
      context,
    );
  }

  recoverInterrupted(): void {
    for (const cycle of this.storage.execution.cycles.list()) {
      if (cycle.status === 'running')
        this.attention(
          cycle,
          'Daemon restarted. Inspect the interrupted step and resume explicitly; no process was relaunched.',
        );
    }
  }

  startWorker(): void {
    if (this.task !== undefined) return;
    this.task = this.loop();
  }
  async shutdown(): Promise<void> {
    this.abort.abort();
    for (const cycle of this.storage.execution.cycles.list()) {
      if (cycle.status === 'running') this.runs.finishCycleTurn(cycle, true);
    }
    await this.task;
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const generation = this.notifier.generation;
      for (const cycle of this.storage.execution.cycles.list()) {
        if (this.abort.signal.aborted) break;
        try {
          await this.reconcile(cycle);
        } catch (error) {
          const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
          if (current?.version === cycle.version && current.status === 'running') {
            this.attention(
              current,
              error instanceof ExecutionRequestError
                ? error.message
                : 'Controller could not advance this step. Inspect the run before resuming.',
            );
          }
        }
      }
      await this.notifier.waitForChangeOrTimeout({
        generation,
        timeoutMs: 1000,
        signal: this.abort.signal,
      });
    }
  }

  private async reconcile(cycle: WorkCycle): Promise<void> {
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (worktree?.mergedAt !== undefined) {
      this.change(cycle, {
        status: 'completed',
        reason: 'Worktree merged by operator; cycle complete.',
      });
      return;
    }
    if (cycle.status !== 'running') return;
    if (worktree?.status !== 'active') {
      this.attention(cycle, 'Worktree is no longer active.');
      return;
    }
    const user = this.storage.users.findById(cycle.createdByUserId);
    const authorization = this.storage.workspaces.findAuthorized(
      cycle.createdByUserId,
      cycle.workspaceId,
    );
    if (
      user?.status !== 'active' ||
      !authorization ||
      !['owner', 'editor'].includes(authorization.membership.role)
    ) {
      this.runs.finishCycleTurn(cycle, true);
      this.attention(cycle, 'The initiating user no longer has permission to run this cycle.');
      return;
    }
    this.requireReady(cycle.workspaceId, cycle.workItemId);
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt)) {
      this.runs.finishCycleTurn(cycle, true);
      this.attention(
        cycle,
        'Step time limit reached. The current process was cancelled; inspect it before resuming.',
      );
      return;
    }
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!run) {
      await this.runs.startForCycle(cycle);
      return;
    }
    if (run.status === 'starting' || run.status === 'running') return;
    if (run.status === 'waiting') {
      if (!this.ending.has(run.id)) {
        this.ending.add(run.id);
        this.runs.finishCycleTurn(cycle);
      }
      return;
    }
    this.ending.delete(run.id);
    const turn = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'turn-completed',
    );
    if (
      run.status !== 'finished' ||
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      !turn.payload.resultText.trim()
    ) {
      this.attention(
        cycle,
        'The step did not finish with a complete successful result. Inspect it before resuming.',
      );
      return;
    }
    if (cycle.step === 'design') {
      if (!designHasNoOpenQuestions(turn.payload.resultText)) {
        this.attention(
          cycle,
          'Design has open questions or lacks an explicit “## Open questions” section containing only “none”. Resolve them manually, then resume.',
        );
        return;
      }
      await this.next(cycle, 'implement', run);
      return;
    }
    if (cycle.step === 'implement' || cycle.step === 'remediate') {
      await this.next(cycle, 'review', run);
      return;
    }
    const head = await this.cleanHead(cycle);
    if (head !== cycle.reviewHeadSha) {
      this.attention(cycle, 'The worktree changed during review. A fresh review is required.');
      return;
    }
    const reviewedWorktree = this.storage.execution.worktrees.find(
      cycle.workspaceId,
      cycle.worktreeId,
    );
    if (reviewedWorktree === undefined) throw new NotFoundError();
    await this.branches?.assertReview(reviewedWorktree, run);
    const assessment = latestReviewReport(this.storage.execution, run);
    const decision = evaluateCompletion(cycle.policy, assessment);
    if (decision.action !== 'remediate') {
      this.change(cycle, { status: decision.action, reason: decision.reason });
      return;
    }
    if (cycle.remediationRounds >= cycle.policy.maxRemediationRounds) {
      this.attention(cycle, `Remediation limit reached. ${decision.reason}`);
      return;
    }
    if (assessment?.status !== 'complete') return;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          gate: assessment.report.exitGate.met,
          verdict: assessment.report.verdict,
          findings: assessment.report.findings
            .filter((finding) => finding.status === 'open')
            .map((finding) => `${finding.id}:${finding.severity}`)
            .sort(),
        }),
      )
      .digest('hex');
    const stalledReviews =
      fingerprint === cycle.previousFindingFingerprint ? cycle.stalledReviews + 1 : 0;
    if (stalledReviews >= 2) {
      this.attention(
        cycle,
        'Two remediation rounds left the same open findings and gate result. Operator attention is required.',
      );
      return;
    }
    await this.next(cycle, 'remediate', run, undefined, {
      remediationRounds: cycle.remediationRounds + 1,
      previousFindingFingerprint: fingerprint,
      stalledReviews,
    });
  }

  private async next(
    cycle: WorkCycle,
    step: CycleStep,
    parent?: AgentRun,
    context?: AuthContext,
    changes: Partial<WorkCycle> = {},
  ): Promise<WorkCycle> {
    const reviewHeadSha = step === 'review' ? await this.cleanHead(cycle) : undefined;
    if (this.abort.signal.aborted) return cycle;
    return this.change(
      cycle,
      {
        ...changes,
        status: 'running',
        step,
        currentRunId: asAgentRunId(randomUUID()),
        ...(parent === undefined ? {} : { parentRunId: parent.id }),
        ...(reviewHeadSha === undefined ? {} : { reviewHeadSha }),
        runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
        reason: `Starting ${step}.`,
      },
      context === undefined ? 'advance' : 'resume',
      context,
    );
  }

  private async cleanHead(cycle: WorkCycle): Promise<string> {
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (worktree?.status !== 'active' || !this.git)
      throw new ExecutionRequestError('conflict', 'The active worktree or Git is unavailable');
    const result = await this.git.inspectRepository(worktree.path);
    if (!result.ok || !result.value.clean || result.value.branch !== worktree.branchName) {
      throw new ExecutionRequestError(
        'conflict',
        'Review requires a clean worktree on its managed branch. Commit or resolve the changes manually, then resume.',
      );
    }
    return result.value.headSha;
  }
  private requireReady(workspaceId: WorkspaceId, workItemId: WorkItemId) {
    const item = this.storage.planning.workItems.find(workspaceId, workItemId);
    if (item?.status !== 'admitted')
      throw new ExecutionRequestError(
        'conflict',
        'Automation requires an admitted, incomplete work item',
      );
    const blocked = this.storage.planning.dependencies
      .listPredecessors(workspaceId, workItemId)
      .filter((dependency) => dependency.kind === 'required' && dependency.status !== 'completed');
    if (blocked.length > 0)
      throw new ExecutionRequestError(
        'conflict',
        `Required predecessors are incomplete: ${blocked.map((dependency) => dependency.sourceId).join(', ')}`,
      );
    return item;
  }
  private deadline(minutes: number): string {
    return new Date(this.now().getTime() + minutes * 60_000).toISOString();
  }
  private attention(cycle: WorkCycle, reason: string): void {
    this.change(cycle, { status: 'needs-attention', reason });
  }
  private change(
    cycle: WorkCycle,
    changes: Partial<WorkCycle>,
    action = 'advance',
    context?: AuthContext,
  ): WorkCycle {
    const updated = {
      ...cycle,
      ...changes,
      reason: (changes.reason ?? cycle.reason).slice(0, 4000),
      version: cycle.version + 1,
      updatedAt: this.now().toISOString(),
    };
    this.storage.transaction((tx) => {
      if (!tx.execution.cycles.replace(updated, cycle.version))
        throw new ExecutionRequestError(
          'conflict',
          'Cycle changed while this operation was in progress',
        );
      this.record(tx, updated, action, context);
    });
    this.notifier.notify();
    return updated;
  }
  private record(
    tx: StorageRepositories,
    cycle: WorkCycle,
    action: string,
    context?: AuthContext,
  ): void {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: cycle.updatedAt,
      actorKind: context === undefined ? 'system' : 'user',
      actorUserId: context?.user.id ?? cycle.createdByUserId,
      ...(context === undefined ? {} : { sessionId: context.session.id }),
      workspaceId: cycle.workspaceId,
      action: 'work-cycle.updated',
      targetType: 'work-cycle',
      targetId: cycle.id,
      outcome: 'succeeded',
      resultingVersion: cycle.version,
      metadata: {
        action,
        status: cycle.status,
        step: cycle.step,
        reason: cycle.reason,
        runId: cycle.currentRunId,
      },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      occurredAt: cycle.updatedAt,
      workspaceId: cycle.workspaceId,
      actorUserId: context?.user.id ?? cycle.createdByUserId,
      projectId: cycle.projectId,
      workItemId: cycle.workItemId,
      kind: 'work-cycle-changed',
      payload: { cycleId: cycle.id, status: cycle.status, step: cycle.step, reason: cycle.reason },
    });
  }
}
