import { createHash, randomUUID } from 'node:crypto';
import type { IntegrationResolutionRequest, StartWorkCycleRequest } from '@craftingtable/contracts';
import {
  DEFAULT_ROADMAP_SCHEDULING,
  DEFAULT_ROADMAP_AUTOMATION,
  ownsIntegrationResolution,
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
import type { CommandContext } from './auth-service.js';
import {
  IntegrationUpdateConflict,
  RepositoryMutationBusyError,
  type BranchService,
} from './branch-service.js';
import { ExecutionRequestError, NotFoundError } from './errors.js';
import { finalizationForCycle, finalizationHasNoQuestions } from './finalization-policy.js';
import { latestReviewReport, runLineage } from './run-handoff.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationGuard, WorktreeMutationBusyError } from './worktree-mutation-guard.js';

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

  list(context: CommandContext, workspaceId: WorkspaceId): readonly WorkCycle[] {
    this.workspaceService.requireAuthorized(context, workspaceId);
    return this.storage.execution.cycles.list(workspaceId);
  }

  validateSettings(input: Pick<StartWorkCycleRequest, 'profiles'>): void {
    if (Object.values(input.profiles).some((profile) => !this.runs.hasBackend(profile.backend)))
      throw new ExecutionRequestError(
        'unavailable',
        'Every cycle step must use an available agent backend',
      );
    if (this.git === undefined)
      throw new ExecutionRequestError('unavailable', 'Git is required for an automated cycle');
  }

  start(
    context: CommandContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartWorkCycleRequest,
    reservedId?: string,
  ): WorkCycle {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    this.validateSettings(input);
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
      id: reservedId ?? randomUUID(),
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

  async startFinalization(
    context: CommandContext,
    value: import('@craftingtable/domain').Finalization,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, value.workspaceId, ['owner', 'editor']);
    const existing = this.storage.execution.cycles.find(value.workspaceId, value.cycleId);
    if (existing) return existing;
    const round = value.rounds[0];
    const profile = round?.polish ?? value.finalReview;
    const profiles = {
      design: profile,
      implement: profile,
      remediate: profile,
      review: round?.review ?? value.finalReview,
    };
    this.validateSettings({ profiles });
    const cycle: WorkCycle = {
      id: value.cycleId,
      workspaceId: value.workspaceId,
      finalizationId: value.id,
      planVersionId: value.planVersionId,
      projectId: value.projectId,
      worktreeId: value.worktreeId,
      workItemSourceId: 'Finalization',
      workItemTitle: 'Plan conformance, simplification and polish',
      createdByUserId: context.user.id,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      version: 1,
      status: 'running',
      step: 'review',
      policy: value.policy,
      profiles,
      instructions: '',
      currentRunId: asAgentRunId(randomUUID()),
      runDeadlineAt: this.deadline(value.policy.maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      polishRound: 0,
      polishPhase: round ? 'assess' : 'final-review',
      reason: 'Starting plan-wide conformance review.',
    };
    const head = await this.cleanHead(cycle);
    finalizationForCycle(this.storage, cycle);
    this.storage.transaction((tx) => {
      tx.execution.cycles.insert({ ...cycle, reviewHeadSha: head });
      this.record(tx, cycle, 'start-finalization', context);
    });
    this.notifier.notify();
    return { ...cycle, reviewHeadSha: head };
  }

  async guideFinalization(
    context: CommandContext,
    cycle: WorkCycle,
    instructions: string,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    finalizationForCycle(this.storage, cycle);
    if (
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
      'reserved'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Recover the pending merge before launching another attempt.',
      );
    if (
      !cycle.finalizationId ||
      !['paused', 'needs-attention'].includes(cycle.status) ||
      ownsIntegrationResolution(cycle)
    )
      throw new ExecutionRequestError(
        'conflict',
        'Pause finalization first; pending conflicts use their resolution controls.',
      );
    const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
    if (runs.some((run) => !isTerminalAgentRunStatus(run.status)))
      throw new ExecutionRequestError(
        'conflict',
        'End the current session before resuming with guidance.',
      );
    return this.next(cycle, cycle.step, runs[0], context, { instructions });
  }

  async control(
    context: CommandContext,
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
    if (
      action !== 'pause' &&
      this.storage.execution.merges.latest(workspaceId, cycle.worktreeId)?.status === 'reserved'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Recover the pending merge before resuming or stopping this cycle.',
      );
    if (action === 'stop' && ownsIntegrationResolution(cycle)) {
      const paused = this.change(
        cycle,
        {
          status: 'paused',
          reason:
            'Resolution stopped with edits preserved. Resume or explicitly abandon the integration resolution.',
        },
        action,
        context,
      );
      this.runs.finishCycleTurn(paused, true);
      return paused;
    }
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
    if (cycle.integrationResolution?.status === 'detected')
      throw new ExecutionRequestError(
        'conflict',
        'Use Resolve integration conflicts to delegate the detected conflict.',
      );
    if (ownsIntegrationResolution(cycle))
      return this.resolveIntegration(context, workspaceId, id, {
        action: 'resume',
        expectedVersion,
      });
    this.mutations.requireAvailable(cycle.worktreeId);
    if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId);
    else finalizationForCycle(this.storage, cycle);
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
      const assessment = latestReviewReport(this.storage.execution, run);
      if (
        assessment?.status === 'complete' &&
        evaluateCompletion(cycle.policy, assessment).action === 'remediate'
      )
        return this.reviewRemediation(cycle, run, context);
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
          if (
            error instanceof RepositoryMutationBusyError ||
            error instanceof WorktreeMutationBusyError
          )
            continue;
          const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
          if (
            current?.version === cycle.version &&
            ['running', 'awaiting-merge'].includes(current.status)
          ) {
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
        reason: 'Worktree integrated; cycle complete.',
      });
      return;
    }
    if (!['running', 'awaiting-merge'].includes(cycle.status)) return;
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
    if (cycle.workItemId) this.requireReady(cycle.workspaceId, cycle.workItemId);
    else finalizationForCycle(this.storage, cycle);
    if (
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
      'reserved'
    )
      return;
    if (cycle.status === 'awaiting-merge') {
      const review = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
      await this.refreshIntegration(cycle, review);
      return;
    }
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt)) {
      this.runs.finishCycleTurn(cycle, true);
      this.attention(
        cycle,
        'Step time limit reached. The current process was cancelled; inspect it before resuming.',
      );
      return;
    }
    if (ownsIntegrationResolution(cycle) && cycle.integrationResolution?.status !== 'resolving') {
      await this.advanceResolution(cycle);
      return;
    }
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!run) {
      if (
        cycle.step === 'review' &&
        (await this.refreshIntegration(
          cycle,
          cycle.parentRunId
            ? this.storage.execution.runs.find(cycle.workspaceId, cycle.parentRunId)
            : undefined,
        ))
      )
        return;
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
    if (ownsIntegrationResolution(cycle)) {
      if (!/\n## Resolution status\s*\nready\s*$/i.test(`\n${turn.payload.resultText}`)) {
        this.attention(
          cycle,
          'Resolution needs guidance or verification. Inspect the final outcome, then resume with instructions.',
        );
        return;
      }
      await this.advanceResolution(cycle);
      return;
    }
    const finalization = finalizationForCycle(this.storage, cycle);
    if (finalization && !finalizationHasNoQuestions(turn.payload.resultText)) {
      this.attention(
        cycle,
        'Finalization needs your input or a complete Open questions checkpoint. Inspect the outcome and provide guidance before resuming.',
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
      const finalized = await this.finalizeImplementation(cycle, run);
      if (!finalized) return;
      if (await this.refreshIntegration(finalized, run)) return;
      await this.next(
        finalized,
        'review',
        run,
        undefined,
        finalization && cycle.polishPhase === 'polish' ? { polishPhase: 'verify' } : {},
      );
      return;
    }
    const assessment = latestReviewReport(this.storage.execution, run);
    const decision = evaluateCompletion(cycle.policy, assessment);
    if (finalization && cycle.polishPhase === 'assess') {
      if (decision.action === 'needs-attention') {
        this.attention(cycle, decision.reason);
        return;
      }
      await this.next(cycle, 'remediate', run, undefined, { polishPhase: 'polish' });
      return;
    }
    // Findings can request more work without granting approval to the reviewed state.
    if (decision.action === 'remediate') {
      await this.reviewRemediation(cycle, run);
      return;
    }
    if (decision.action === 'needs-attention') {
      this.attention(cycle, decision.reason);
      return;
    }
    const changes = await this.git?.inspectWorktreeChanges(worktree.path);
    if (!changes?.ok || changes.value.branch !== worktree.branchName || changes.value.conflicted)
      throw new ExecutionRequestError(
        'conflict',
        'Review approval requires the managed branch without unresolved Git operations.',
      );
    if (!changes.value.clean || changes.value.headSha !== cycle.reviewHeadSha) {
      await this.housekeeping(
        cycle,
        run,
        'Verification changed the worktree. Inspect these changes and generated files, restore a reviewable state, and commit intended source changes. The prior approval is invalid.',
      );
      return;
    }
    const head = await this.cleanHead(cycle);
    if (head !== cycle.reviewHeadSha) {
      this.attention(cycle, 'The worktree changed during review. A fresh review is required.');
      return;
    }
    if (await this.refreshIntegration(cycle, run)) return;
    const reviewedWorktree = this.storage.execution.worktrees.find(
      cycle.workspaceId,
      cycle.worktreeId,
    );
    if (reviewedWorktree === undefined) throw new NotFoundError();
    await this.branches?.assertReview(reviewedWorktree, run);
    if (finalization && cycle.polishPhase !== 'final-review') {
      const nextRound = (cycle.polishRound ?? 0) + 1;
      await this.next(cycle, 'review', run, undefined, {
        polishRound: nextRound,
        polishPhase: nextRound < finalization.rounds.length ? 'assess' : 'final-review',
        stalledReviews: 0,
      });
      return;
    }
    this.change(cycle, {
      status: 'awaiting-merge',
      reason: finalization
        ? 'Final independent review meets the completion policy. Inspect the conformance assessment, changes and verification; only you can approve promotion.'
        : decision.reason,
    });
  }

  private housekeepingGuidance(): string {
    return 'Before addressing the review findings, inspect git status including untracked files and reconcile any verification artifacts using the source run journal. Never blindly commit untracked files. Remove only confirmed generated test artifacts; preserve intended new source by staging it. Use the provided TMPDIR for tests. Complete the substantive findings in this same run, run checks, commit intended changes, and finish with a clean worktree.';
  }

  private async reviewRemediation(
    cycle: WorkCycle,
    run: AgentRun,
    context?: CommandContext,
  ): Promise<WorkCycle> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !this.git) throw new NotFoundError();
    const state = await this.git.inspectWorktreeChanges(tree.path);
    if (!state.ok || state.value.branch !== tree.branchName || state.value.conflicted)
      throw new ExecutionRequestError(
        'conflict',
        'Remediation requires the managed branch without unresolved Git operations.',
      );
    const assessment = latestReviewReport(this.storage.execution, run);
    const decision = evaluateCompletion(cycle.policy, assessment);
    if (cycle.remediationRounds >= cycle.policy.maxRemediationRounds) {
      this.attention(cycle, `Remediation limit reached. ${decision.reason}`);
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    if (assessment?.status !== 'complete') return cycle;
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
      return this.storage.execution.cycles.find(cycle.workspaceId, cycle.id) ?? cycle;
    }
    return this.next(cycle, 'remediate', run, context, {
      housekeepingInstructions: this.housekeepingGuidance(),
      remediationRounds: cycle.remediationRounds + 1,
      previousFindingFingerprint: fingerprint,
      stalledReviews,
    });
  }

  private async housekeeping(cycle: WorkCycle, run: AgentRun, reason: string): Promise<void> {
    if (cycle.remediationRounds >= cycle.policy.maxRemediationRounds) {
      this.attention(cycle, `Remediation limit reached. ${reason}`);
      return;
    }
    await this.next(cycle, 'remediate', run, undefined, {
      remediationRounds: cycle.remediationRounds + 1,
      housekeepingInstructions: `${reason}\n\n${this.housekeepingGuidance()}`,
    });
  }

  private async finalizeImplementation(
    cycle: WorkCycle,
    run: AgentRun,
  ): Promise<WorkCycle | undefined> {
    const git = this.git;
    if (!git || !this.branches || run.role !== 'implement') return cycle;
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repo =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repo) throw new NotFoundError();
    if (this.branches.repositoryBusy(repo.rootPath)) return;
    let current = cycle;
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = this.storage.workspaces.findAuthorized(
        cycle.createdByUserId,
        cycle.workspaceId,
      );
      if (
        this.abort.signal.aborted ||
        saved?.version !== current.version ||
        saved.status !== 'running' ||
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Finalization was superseded or its authority was revoked.',
        );
      if (
        this.storage.execution.runs
          .listForWorktree(cycle.workspaceId, cycle.worktreeId)
          .some((candidate) => !isTerminalAgentRunStatus(candidate.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'End agent sessions before finalizing the worktree.',
        );
    };
    try {
      return await this.branches.duringMerge(repo.rootPath, () =>
        this.mutations.during(tree.id, async () => {
          check();
          const inspected = await git.inspectWorktreeChanges(tree.path);
          if (!inspected.ok) throw new ExecutionRequestError('conflict', inspected.failure.message);
          const state = inspected.value;
          if (state.paths.length > 1000)
            throw new ExecutionRequestError(
              'conflict',
              'Checkpoint exceeds the 1000-file finalization limit.',
            );
          if (state.branch !== tree.branchName || state.conflicted)
            throw new ExecutionRequestError(
              'conflict',
              'Finalization requires the managed branch without unresolved Git operations.',
            );
          check();
          const pending =
            current.checkpoint?.sourceRunId === run.id && !current.checkpoint.commitSha
              ? current.checkpoint
              : undefined;
          if (pending || state.paths.length) {
            if (!pending)
              current = this.change(
                current,
                {
                  checkpoint: {
                    sourceRunId: run.id,
                    previousHeadSha: state.headSha,
                    fingerprint: state.fingerprint,
                    paths: state.paths,
                    createdAt: this.now().toISOString(),
                  },
                  reason: 'Checkpointing implementation changes before review.',
                },
                'checkpoint-reserved',
              );
            const checkpoint = current.checkpoint;
            if (!checkpoint) throw new Error('Missing checkpoint reservation');
            check();
            const result = await git.checkpointWorktree({
              worktreePath: tree.path,
              branchName: tree.branchName,
              expectedHeadSha: checkpoint.previousHeadSha,
              fingerprint: checkpoint.fingerprint,
              paths: checkpoint.paths,
              sourceRunId: run.id,
            });
            if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
            check();
            current = this.change(
              current,
              {
                checkpoint: { ...checkpoint, commitSha: result.value.commitSha },
                reason: 'Implementation checkpoint committed; preparing review.',
              },
              'checkpoint-completed',
            );
          }
          check();
          const after = await git.inspectWorktreeChanges(tree.path);
          if (!after.ok) throw new ExecutionRequestError('conflict', after.failure.message);
          check();
          if (!after.value.clean) {
            await this.housekeeping(
              current,
              run,
              'Files remain after implementation finalization. Classify and reconcile them before a fresh review.',
            );
            return;
          }
          return current;
        }),
      );
    } catch (error) {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        latest?.version === current.version &&
        latest.status === 'running' &&
        !this.abort.signal.aborted &&
        !(error instanceof RepositoryMutationBusyError)
      )
        this.attention(
          latest,
          error instanceof ExecutionRequestError
            ? error.message
            : 'Worktree finalization failed. Inspect the checkpoint before resuming.',
        );
      return;
    }
  }

  /** Only an actively delegated parallel attempt may refresh itself. Settings bind to its revision. */
  private refreshOwner(cycle: WorkCycle) {
    const finalization = finalizationForCycle(this.storage, cycle);
    if (finalization) {
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = user && this.storage.workspaces.findAuthorized(user.id, cycle.workspaceId);
      if (
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError('conflict', 'Finalization authority was revoked');
      return {
        settings: { ...DEFAULT_ROADMAP_SCHEDULING, maxIntegrationRefreshes: 3 },
        context: { user },
      };
    }
    const roadmap = this.storage.roadmaps
      .list(cycle.workspaceId)
      .find((r) => r.attempts.some((a) => a.cycleId === cycle.id && a.status === 'active'));
    if (roadmap?.status !== 'running') return;
    const attempt = roadmap.attempts.find((a) => a.cycleId === cycle.id);
    if (!attempt || roadmap.entryHolds?.[attempt.entryId]) return;
    const entry = roadmap.definition.entries.find((e) => e.id === attempt.entryId);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (
      !entry ||
      tree?.integrationBranch !== entry.integrationBranch ||
      tree.repositoryId !== entry.repositoryId
    )
      throw new ExecutionRequestError(
        'conflict',
        'The roadmap worktree branch binding changed. Reconcile it before resuming.',
      );
    const definition =
      roadmap.definition.revision === attempt.definitionRevision
        ? roadmap.definition
        : this.storage.roadmaps
            .history(cycle.workspaceId, roadmap.id)
            .find((d) => d.revision === attempt.definitionRevision);
    const settings = definition?.scheduling ?? DEFAULT_ROADMAP_SCHEDULING;
    const automation =
      definition?.entries.find((e) => e.id === attempt.entryId)?.automation ??
      definition?.automation ??
      DEFAULT_ROADMAP_AUTOMATION;
    if (
      settings.mode !== 'parallel' &&
      automation.integrationMerge !== 'automatic' &&
      automation.integrationConflicts !== 'automatic'
    )
      return;
    const user =
      roadmap.delegatedByUserId && this.storage.users.findById(roadmap.delegatedByUserId);
    const membership = user && this.storage.workspaces.findAuthorized(user.id, cycle.workspaceId);
    if (
      user?.status !== 'active' ||
      !membership ||
      !['owner', 'editor'].includes(membership.membership.role)
    )
      throw new ExecutionRequestError(
        'conflict',
        'The roadmap initiating user no longer has permission.',
      );
    return { settings, context: { user } };
  }

  async refreshIntegration(cycle: WorkCycle, parent?: AgentRun): Promise<boolean> {
    const owner = this.refreshOwner(cycle);
    if (!owner || !this.branches) return false;
    const worktree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (
      !worktree ||
      this.storage.execution.runs
        .listForWorktree(cycle.workspaceId, cycle.worktreeId)
        .some((run) => !isTerminalAgentRunStatus(run.status))
    )
      return false;
    const advanced = await this.branches.integrationAdvanced(
      worktree,
      cycle.step === 'review' && parent?.id === cycle.currentRunId ? parent : undefined,
    );
    if (advanced === undefined) return true; // Wait for the repository's mutation lane.
    if (!advanced) return false;
    // Reserve a bounded attempt before Git. A restart cannot silently retry a partial update.
    const current = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (
      this.abort.signal.aborted ||
      current?.version !== cycle.version ||
      !this.refreshOwner(cycle)
    )
      return true;
    if ((cycle.integrationRefreshes ?? 0) >= owner.settings.maxIntegrationRefreshes) {
      this.attention(
        cycle,
        'Integration refresh limit reached. Update from integration manually, then resume for fresh review.',
      );
      return true;
    }
    const reserved = this.change(cycle, {
      status: 'running',
      integrationRefreshes: (cycle.integrationRefreshes ?? 0) + 1,
      reason: 'Updating from integration before a fresh review of the combined changes.',
    });
    const check = () => {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        this.abort.signal.aborted ||
        latest?.version !== reserved.version ||
        latest.status !== 'running' ||
        !this.refreshOwner(reserved)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Integration refresh was superseded by an operator command.',
        );
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = this.storage.workspaces.findAuthorized(
        cycle.createdByUserId,
        cycle.workspaceId,
      );
      if (
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError(
          'conflict',
          'The initiating user no longer has permission to run this cycle.',
        );
    };
    try {
      check();
      await this.branches.changeWorktree(
        owner.context,
        cycle.workspaceId,
        cycle.worktreeId,
        { expectedVersion: worktree.version },
        true,
        { cycleId: cycle.id, check },
      );
      check();
      await this.next(reserved, 'review', parent);
    } catch (error) {
      const latest = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      if (
        latest?.version === reserved.version &&
        latest.status === 'running' &&
        error instanceof RepositoryMutationBusyError
      ) {
        this.change(latest, {
          status: cycle.status,
          integrationRefreshes: cycle.integrationRefreshes ?? 0,
          reason: 'Waiting for the repository mutation to finish before refreshing.',
        });
        return true;
      }
      if (
        latest?.version === reserved.version &&
        latest.status === 'running' &&
        !this.abort.signal.aborted
      )
        this.change(latest, {
          status: 'needs-attention',
          reason:
            error instanceof ExecutionRequestError
              ? error.message
              : 'Integration update failed. Inspect the worktree before resuming.',
          ...(error instanceof IntegrationUpdateConflict
            ? {
                integrationResolution: {
                  id: randomUUID(),
                  status: 'detected' as const,
                  ...error.details,
                  createdAt: this.now().toISOString(),
                  attempts: 0,
                },
              }
            : {}),
        });
    }
    return true;
  }

  private resolutionContext(cycle: WorkCycle) {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const resolution = cycle.integrationResolution;
    if (
      tree?.status !== 'active' ||
      !resolution ||
      tree.integrationBranch !== resolution.targetBranch
    )
      throw new ExecutionRequestError(
        'conflict',
        'Resolution worktree or integration binding changed',
      );
    return {
      worktreePath: tree.path,
      branchName: tree.branchName,
      headSha: resolution.headSha,
      targetSha: resolution.targetSha,
    };
  }
  private async resolutionMutation<T>(
    cycle: WorkCycle,
    operation: (check: () => void) => Promise<T>,
  ): Promise<T> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const repository =
      tree && this.storage.execution.sourceRepositories.find(cycle.workspaceId, tree.repositoryId);
    if (!tree || !repository || !this.branches || !this.git) throw new NotFoundError();
    const check = () => {
      const saved = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
      const user = this.storage.users.findById(cycle.createdByUserId);
      const access = this.storage.workspaces.findAuthorized(
        cycle.createdByUserId,
        cycle.workspaceId,
      );
      if (
        this.abort.signal.aborted ||
        saved?.version !== cycle.version ||
        user?.status !== 'active' ||
        !access ||
        !['owner', 'editor'].includes(access.membership.role)
      )
        throw new ExecutionRequestError(
          'conflict',
          'Resolution was superseded or delegation was revoked',
        );
      if (
        this.storage.execution.runs
          .listForWorktree(cycle.workspaceId, cycle.worktreeId)
          .some((run) => !isTerminalAgentRunStatus(run.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'End the active agent session before changing resolution state',
        );
    };
    return this.branches.duringMerge(repository.rootPath, () =>
      this.mutations.during(tree.id, async () => {
        check();
        return operation(check);
      }),
    );
  }
  async resolveIntegration(
    context: CommandContext,
    workspaceId: WorkspaceId,
    id: string,
    input: IntegrationResolutionRequest,
    delegatedCheck?: () => void,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor']);
    const cycle = this.storage.execution.cycles.find(workspaceId, id);
    if (!cycle) throw new NotFoundError();
    if (
      cycle.version !== input.expectedVersion ||
      !['paused', 'needs-attention'].includes(cycle.status)
    )
      throw new ExecutionRequestError(
        'conflict',
        'Pause the cycle and refresh before resolving integration conflicts',
      );
    const git = this.git;
    const tree = this.storage.execution.worktrees.find(workspaceId, cycle.worktreeId);
    if (!git || !tree?.integrationBranch || tree.status !== 'active') throw new NotFoundError();
    if (cycle.workItemId) this.requireReady(workspaceId, cycle.workItemId);
    else finalizationForCycle(this.storage, cycle);
    return this.resolutionMutation(cycle, async (checkOwned) => {
      const check = () => {
        checkOwned();
        delegatedCheck?.();
      };
      check();
      let resolution = cycle.integrationResolution;
      if (input.action === 'inspect') {
        if (ownsIntegrationResolution(cycle))
          throw new ExecutionRequestError('conflict', 'Resume or abandon the existing resolution');
        const head = await git.inspectRepository(tree.path);
        const target = await git.resolveBranch(tree.path, tree.integrationBranch ?? '');
        if (!head.ok || !target.ok)
          throw new ExecutionRequestError('conflict', 'Cannot inspect integration commits');
        const result = await git.previewIntegration({
          worktreePath: tree.path,
          branchName: tree.branchName,
          headSha: head.value.headSha,
          targetSha: target.value,
        });
        if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        check();
        if (!result.value.paths.length)
          throw new ExecutionRequestError(
            'conflict',
            'No textual conflicts found. Use Update from integration, then resume for review.',
          );
        return this.change(
          cycle,
          {
            integrationResolution: {
              id: randomUUID(),
              status: 'detected',
              headSha: head.value.headSha,
              targetSha: target.value,
              targetBranch: tree.integrationBranch ?? '',
              ...result.value,
              createdAt: this.now().toISOString(),
              attempts: 0,
            },
            reason: `Integration conflicts in ${result.value.paths.length} files. Delegate resolution when ready.`,
          },
          'resolution-inspected',
          context,
        );
      }
      if (!resolution)
        throw new ExecutionRequestError('conflict', 'Inspect integration conflicts first');
      if (input.action === 'abandon') {
        if (!ownsIntegrationResolution(cycle))
          throw new ExecutionRequestError(
            'conflict',
            'No pending integration resolution to abandon',
          );
        if (ownsIntegrationResolution(cycle)) {
          const result = await git.abortIntegrationResolution(this.resolutionContext(cycle));
          if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        }
        check();
        return this.change(
          cycle,
          {
            integrationResolution: { ...resolution, status: 'abandoned' },
            status: 'needs-attention',
            reason:
              'Resolution abandoned. The owned merge was aborted; untracked files and any unrelated edits are preserved. Inspect the diff before starting again.',
          },
          'resolution-abandoned',
          context,
        );
      }
      if (input.action === 'start') {
        if (resolution.status !== 'detected')
          throw new ExecutionRequestError(
            'conflict',
            'Inspect conflicts before starting another resolution',
          );
        const target = await git.resolveBranch(tree.path, resolution.targetBranch);
        const head = await git.inspectRepository(tree.path);
        if (
          !target.ok ||
          !head.ok ||
          target.value !== resolution.targetSha ||
          head.value.headSha !== resolution.headSha ||
          !head.value.clean ||
          head.value.branch !== tree.branchName
        )
          throw new ExecutionRequestError(
            'conflict',
            'Branches changed since inspection. Inspect integration conflicts again.',
          );
        const profile = input.profile ?? cycle.profiles.remediate;
        if (!this.runs.hasBackend(profile.backend))
          throw new ExecutionRequestError('unavailable', 'Resolution agent is unavailable');
        check();
        const source =
          this.storage.execution.runs.find(workspaceId, cycle.currentRunId) ??
          (cycle.parentRunId
            ? this.storage.execution.runs.find(workspaceId, cycle.parentRunId)
            : undefined);
        if (!source)
          throw new ExecutionRequestError(
            'conflict',
            'Resolution requires the prior cycle handoff',
          );
        const runId = asAgentRunId(randomUUID());
        resolution = {
          ...resolution,
          status: 'preparing',
          profile,
          instructions: input.instructions ?? '',
          attempts: 1,
          runIds: [runId],
        };
        return this.change(
          cycle,
          {
            integrationResolution: resolution,
            status: 'running',
            step: 'remediate',
            parentRunId: source.id,
            currentRunId: runId,
            runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
            reason: 'Preparing the pinned integration merge for agent resolution.',
          },
          'resolution-started',
          context,
        );
      }
      if (!ownsIntegrationResolution(cycle))
        throw new ExecutionRequestError('conflict', 'There is no pending resolution to resume');
      const run = this.storage.execution.runs.find(workspaceId, cycle.currentRunId);
      if (
        resolution.status === 'resolving' &&
        run?.status === 'finished' &&
        cycle.status === 'paused' &&
        input.instructions === undefined &&
        input.profile === undefined
      ) {
        check();
        return this.change(
          cycle,
          {
            status: 'running',
            runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
            reason: 'Resuming verification of the completed resolution run.',
          },
          'resolution-resumed',
          context,
        );
      }
      if (resolution.status === 'resolving' && run) {
        if (resolution.attempts >= 3)
          throw new ExecutionRequestError(
            'conflict',
            'Resolution reached its three-agent-attempt limit. Abandon and inspect again to authorize a new attempt.',
          );
        const profile = input.profile ?? resolution.profile ?? cycle.profiles.remediate;
        if (!this.runs.hasBackend(profile.backend))
          throw new ExecutionRequestError('unavailable', 'Resolution agent is unavailable');
        check();
        const runId = asAgentRunId(randomUUID());
        return this.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              profile,
              instructions: input.instructions ?? resolution.instructions ?? '',
              attempts: resolution.attempts + 1,
              runIds: [...(resolution.runIds ?? []), runId],
            },
            status: 'running',
            parentRunId: run.id,
            currentRunId: runId,
            runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
            reason: 'Resuming conflict resolution with the existing edits and handoff.',
          },
          'resolution-resumed',
          context,
        );
      }
      check();
      return this.change(
        cycle,
        {
          status: 'running',
          runDeadlineAt: this.deadline(cycle.policy.maxRunMinutes),
          reason: 'Resuming the reserved integration operation.',
        },
        'resolution-resumed',
        context,
      );
    });
  }
  private async advanceResolution(cycle: WorkCycle): Promise<void> {
    const git = this.git;
    const resolution = cycle.integrationResolution;
    if (!git || !resolution) throw new NotFoundError();
    await this.resolutionMutation(cycle, async (check) => {
      const input = this.resolutionContext(cycle);
      if (resolution.status === 'preparing') {
        const result = await git.prepareIntegrationResolution(input);
        if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        check();
        this.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              status: 'resolving',
              paths: result.value.conflicts,
            },
            reason: 'Agent resolving the pinned integration update before a fresh review.',
          },
          'resolution-prepared',
        );
        return;
      }
      if (resolution.status === 'resolving') {
        const state = await git.inspectIntegrationResolution(input);
        if (!state.ok) throw new ExecutionRequestError('conflict', state.failure.message);
        if (
          state.value.headSha !== resolution.headSha ||
          state.value.mergeHeadSha !== resolution.targetSha ||
          state.value.conflicts.length ||
          state.value.untracked.length ||
          state.value.unstaged ||
          !state.value.treeSha
        )
          throw new ExecutionRequestError(
            'conflict',
            'Resolution is not ready: resolve and stage all changes, clear generated files, and keep the pinned merge pending. Resume with guidance.',
          );
        check();
        this.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              status: 'committing',
              treeSha: state.value.treeSha,
            },
            reason:
              'Recording the verified resolution tree before the daemon commits the integration update.',
          },
          'resolution-commit-reserved',
        );
        return;
      }
      if (resolution.status === 'committing') {
        if (!resolution.treeSha)
          throw new ExecutionRequestError('conflict', 'Missing resolution tree reservation');
        const result = await git.finishIntegrationResolution({
          ...input,
          treeSha: resolution.treeSha,
          resolutionId: resolution.id,
        });
        if (!result.ok) throw new ExecutionRequestError('conflict', result.failure.message);
        check();
        const changed = this.change(
          cycle,
          {
            integrationResolution: {
              ...resolution,
              status: 'completed',
              commitSha: result.value.commitSha,
            },
            reason:
              'Integration conflict resolved. A fresh review of the combined changes is required.',
          },
          'resolution-completed',
        );
        const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
        await this.next(changed, 'review', run);
      }
    });
  }

  private async next(
    cycle: WorkCycle,
    step: CycleStep,
    parent?: AgentRun,
    context?: CommandContext,
    changes: Partial<WorkCycle> = {},
  ): Promise<WorkCycle> {
    const reviewHeadSha = step === 'review' ? await this.cleanHead(cycle) : undefined;
    if (
      this.abort.signal.aborted ||
      this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !== cycle.version
    )
      return cycle;
    return this.change(
      cycle,
      {
        housekeepingInstructions: '',
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
    context?: CommandContext,
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
    context?: CommandContext,
  ): void {
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      occurredAt: cycle.updatedAt,
      actorKind: context?.session === undefined ? 'system' : 'user',
      actorUserId: context?.user.id ?? cycle.createdByUserId,
      ...(context?.session === undefined ? {} : { sessionId: context.session.id }),
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
        ...(cycle.integrationResolution
          ? {
              integrationResolution: {
                ...cycle.integrationResolution,
                paths: [...cycle.integrationResolution.paths],
              },
            }
          : {}),
        ...(cycle.checkpoint
          ? { checkpoint: { ...cycle.checkpoint, paths: [...cycle.checkpoint.paths] } }
          : {}),
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
      payload: {
        ...(cycle.planVersionId ? { planVersionId: cycle.planVersionId } : {}),
        cycleId: cycle.id,
        status: cycle.status,
        step: cycle.step,
        reason: cycle.reason,
      },
    });
  }
}
