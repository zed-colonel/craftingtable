/**
 * A staged finalization's commands (R-B7): its start, the operator's guidance, the checkpoint's
 * findings and their decision, a stage's decision, and its remediation grant.
 */

import { validExtraRounds, withinInstructionLimit } from '../../command-bounds.js';
import { randomUUID } from 'node:crypto';
import type { ControlFinalizationRequest } from '@craftingtable/contracts';
import {
  asAgentRunId,
  currentFinalizationStage,
  type FinalizationProgress,
  noOpenQuestions,
  optionalFinding,
  parkedFollowUp,
  remediationAllowance,
  remediationUsed,
  stagedFollowUps,
  type WorkCycle,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { CommandContext } from '../../auth-service.js';
import type { BranchService } from '../../branch-service.js';
import { ExecutionRequestError, NotFoundError } from '../../errors.js';
import { finalizationForCycle } from '../../finalization-policy.js';
import { assessStageReport } from '../../finalization-stage-policy.js';
import { latestReviewReport } from '../../run-lineage.js';
import type { WorkspaceService } from '../../workspace-service.js';
import type { WorktreeMutationGuard } from '../../worktree-mutation-guard.js';

import type { CycleWriter } from '../writer.js';
import type { CycleGates } from '../gates.js';
import type { CycleSettings } from '../settings.js';
import type { CycleRemediation } from '../effects/remediation.js';
import type { CycleFinalizationStage } from '../effects/finalization-stage.js';

export class CycleFinalizationCommands {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly mutations: WorktreeMutationGuard,
    private readonly branches: BranchService,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
    private readonly gates: CycleGates,
    private readonly settings: CycleSettings,
    private readonly remediation: CycleRemediation,
    private readonly finalizationStage: CycleFinalizationStage,
  ) {}

  async startFinalization(
    context: CommandContext,
    value: import('@craftingtable/domain').Finalization,
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, value.workspaceId, ['owner', 'editor']);
    const existing = this.storage.execution.cycles.find(value.workspaceId, value.cycleId);
    if (existing) return existing;
    // Only staged finalizations run; improvement rounds are retired (R-B10).
    const stage = value.stages?.[0];
    if (!value.stages || !stage)
      throw new ExecutionRequestError(
        'conflict',
        'Improvement-round finalizations are retired. Start a staged finalization.',
      );
    const profiles = {
      design: stage.implement,
      implement: stage.implement,
      remediate: stage.implement,
      review: stage.review,
    };
    this.settings.validateSettings({ profiles });
    const cycle: WorkCycle = {
      id: value.cycleId,
      // A plan finalization is its own subject; no roadmap attempt owns it.
      owner: null,
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
      policy: stage.policy,
      profiles,
      instructions: '',
      currentRunId: asAgentRunId(randomUUID()),
      runDeadlineAt: this.writer.deadline(stage.policy.maxRunMinutes),
      remediationRounds: 0,
      stalledReviews: 0,
      polishPhase: 'verify',
      finalizationProgress: {
        stageIndex: 0,
        stages: value.stages.map((s, i) => ({
          id: s.id,
          status: i === 0 ? ('reviewing' as const) : ('pending' as const),
          remediationRounds: 0,
          additionalRemediationRounds: 0,
          selectedFindingIds: [],
        })),
        obligations: this.storage.planning.workItems
          .listForVersion(value.workspaceId, value.planVersionId)
          .map((item, index) => ({
            id: `gate-${index + 1}`,
            workItemSourceId: item.sourceId,
            source: `Work item ${item.sourceId}: exit gate`,
            requirement: item.exitGate,
            status: 'unverified' as const,
            evidence: 'Not yet assessed in staged finalization.',
          })),
        followUps: [],
        decisions: [],
      },

      reason: 'Starting plan-wide conformance review.',
    };
    const head = await this.writer.cleanHead(cycle);
    finalizationForCycle(this.storage, cycle);
    this.writer.insert({ ...cycle, reviewHeadSha: head }, 'start-finalization', context, cycle);
    return { ...cycle, reviewHeadSha: head };
  }

  async guideFinalization(
    context: CommandContext,
    cycle: WorkCycle,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    this.gates.requireNoInvestigation(cycle);
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
      (cycle.integrationResolution &&
        !['completed', 'abandoned'].includes(cycle.integrationResolution.status))
    )
      throw new ExecutionRequestError(
        'conflict',
        'Pause finalization first; pending conflicts use their resolution controls.',
      );
    const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
    if (this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0)
      throw new ExecutionRequestError(
        'conflict',
        'End the current session before resuming with guidance.',
      );
    return this.writer.next(cycle, cycle.step, runs[0], context, {
      attempt: { stepGuidance: instructions },
      ...(agentOverride === undefined ? {} : { finalizationAgentOverride: agentOverride }),
    });
  }

  finalizationCheckpointFindings(cycle: WorkCycle) {
    if (
      !cycle.finalizationId ||
      !['paused', 'needs-attention'].includes(cycle.status) ||
      cycle.step !== 'review' ||
      (cycle.integrationResolution &&
        !['completed', 'abandoned'].includes(cycle.integrationResolution.status)) ||
      this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
        'reserved'
    )
      return [];
    const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
    const run = runs[0];
    if (
      !run ||
      run.id !== cycle.currentRunId ||
      run.status !== 'finished' ||
      run.role !== 'review' ||
      this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
    )
      return [];
    const turn = this.storage.execution.runEvents.latestOfKind(
      cycle.workspaceId,
      run.id,
      'turn-completed',
    );
    const report = latestReviewReport(this.storage.execution, run);
    if (
      turn?.kind !== 'turn-completed' ||
      turn.payload.outcome !== 'success' ||
      turn.payload.truncated ||
      report?.status !== 'complete'
    )
      return [];
    // Parked nits are listed too (operator decision 2026-10-07): choosing one un-parks it.
    return report.report.findings.filter(
      (f) =>
        f.status === 'open' &&
        (!cycle.finalizationProgress ||
          currentFinalizationStage(cycle)?.status === 'selecting' ||
          !optionalFinding(f) ||
          cycle.findingFocus?.includes(f.id) ||
          currentFinalizationStage(cycle)?.selectedFindingIds.includes(f.id)),
    );
  }

  async decideFinalizationFindings(
    context: CommandContext,
    cycle: WorkCycle,
    input: {
      action: 'remediate-findings';
      findingIds: readonly string[];
      rationale: string;
      instructions?: string;
      additionalRounds?: number;
      agentOverride?: WorkCycle['finalizationAgentOverride'];
    },
  ): Promise<WorkCycle> {
    const check = () => {
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      this.gates.requireNoInvestigation(cycle);
      finalizationForCycle(this.storage, cycle);
      this.mutations.requireAvailable(cycle.worktreeId);
      if (
        this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !== cycle.version
      )
        throw new ExecutionRequestError(
          'conflict',
          'Finalization changed; refresh before deciding findings.',
        );
      if (currentFinalizationStage(cycle)?.status === 'selecting')
        throw new ExecutionRequestError(
          'conflict',
          'Use Next finalization step to select this stage’s improvement batch and record the remaining follow-ups.',
        );
      const findings = this.finalizationCheckpointFindings(cycle);
      const selected = findings.filter((f) => input.findingIds.includes(f.id));
      if (!selected.length || selected.length !== input.findingIds.length)
        throw new ExecutionRequestError('conflict', 'Select current open findings.');
    };
    check();
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree || !run?.reviewBranchContext)
      throw new ExecutionRequestError(
        'conflict',
        'The current review needs a recorded branch checkpoint.',
      );
    const baseline = await this.branches.captureReview(tree);
    check();
    if (
      baseline.headSha !== run.reviewBranchContext.headSha ||
      baseline.targetSha !== run.reviewBranchContext.targetSha ||
      baseline.targetBranch !== run.reviewBranchContext.targetBranch ||
      baseline.worktreeVersion !== run.reviewBranchContext.worktreeVersion
    )
      throw new ExecutionRequestError(
        'conflict',
        'The reviewed branches changed; obtain a fresh review before deciding findings.',
      );
    const instructions = `Operator decision for ${input.findingIds.join(', ')}: ${input.rationale}\n${input.instructions ?? ''}\nBefore editing, reassess every open question using this guidance. If any question remains unanswered, stop and ask; do not infer authorization for unrelated changes.`;
    if (!withinInstructionLimit(instructions))
      throw new ExecutionRequestError(
        'invalid-request',
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
      );
    const extra = input.additionalRounds ?? 0;
    if (!validExtraRounds(extra, { min: 1, base: cycle.additionalRemediationRounds ?? 0 }))
      throw new ExecutionRequestError(
        'invalid-request',
        'Authorize 1–20 additional remediation attempts.',
      );
    return this.writer.next(
      cycle,
      'remediate',
      run,
      context,
      {
        ...(input.agentOverride === undefined
          ? {}
          : { finalizationAgentOverride: input.agentOverride }),
        additionalRemediationRounds: (cycle.additionalRemediationRounds ?? 0) + extra,
        remediationRounds: cycle.remediationRounds + 1,
        stalledReviews: 0,
        findingFocus: input.findingIds,
        // A parked nit the operator chose is required work again (R-C7, operator 2026-10-07).
        ...(cycle.finalizationProgress?.followUps.some((f) => input.findingIds.includes(f.id))
          ? {
              finalizationProgress: {
                ...cycle.finalizationProgress,
                followUps: cycle.finalizationProgress.followUps.filter(
                  (f) => !input.findingIds.includes(f.id),
                ),
              },
            }
          : {}),
        attempt: {
          stepGuidance: instructions,
          housekeepingInstructions: this.remediation.housekeepingGuidance(),
        },
        reason: `Authorized focused remediation for ${input.findingIds.join(', ')}.`,
      },
      'remediate-findings',
    );
  }

  async decideFinalizationStage(
    context: CommandContext,
    cycle: WorkCycle,
    input: ControlFinalizationRequest,
  ) {
    const check = () => {
      this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
      this.gates.requireNoInvestigation(cycle);
      const value = finalizationForCycle(this.storage, cycle);
      this.mutations.requireAvailable(cycle.worktreeId);
      if (
        !value?.stages ||
        !cycle.finalizationProgress ||
        !['paused', 'needs-attention'].includes(cycle.status) ||
        cycle.step !== 'review' ||
        this.storage.execution.cycles.find(cycle.workspaceId, cycle.id)?.version !==
          cycle.version ||
        this.storage.execution.merges.latest(cycle.workspaceId, cycle.worktreeId)?.status ===
          'reserved' ||
        (cycle.integrationResolution &&
          !['completed', 'abandoned'].includes(cycle.integrationResolution.status))
      )
        throw new ExecutionRequestError(
          'conflict',
          'Use a current, idle staged review checkpoint for this decision.',
        );
      const runs = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId);
      if (
        runs[0]?.id !== cycle.currentRunId ||
        this.storage.execution.runs.liveForWorktree(cycle.workspaceId, cycle.worktreeId).length > 0
      )
        throw new ExecutionRequestError(
          'conflict',
          'End the current session and refresh before deciding.',
        );
      const run = runs[0];
      const report = latestReviewReport(this.storage.execution, run);
      const turn = this.storage.execution.runEvents.latestOfKind(
        cycle.workspaceId,
        run.id,
        'turn-completed',
      );
      if (
        run.status !== 'finished' ||
        report?.status !== 'complete' ||
        assessStageReport(value, cycle, report, run.reviewBranchContext).status !== 'complete' ||
        turn?.kind !== 'turn-completed' ||
        turn.payload.outcome !== 'success' ||
        turn.payload.truncated
      )
        throw new ExecutionRequestError(
          'conflict',
          'A complete successful staged review is required.',
        );
      return {
        value,
        run,
        report,
        noQuestions: noOpenQuestions(turn.payload.resultText),
        progress: cycle.finalizationProgress,
      };
    };
    let checked = check();
    // Decisions never adopt unreviewed changes; a new review is needed after drift.
    if (!(await this.finalizationStage.stageReviewIsCurrent(cycle, checked.run))) return;
    checked = check();
    const { run, report, progress, value } = checked;
    const stage = value.stages?.[progress.stageIndex];
    if (!stage || !input.rationale?.trim())
      throw new ExecutionRequestError('invalid-request', 'A disposition rationale is required.');
    const instructions = `Operator decision: ${input.rationale}. ${input.instructions ?? ''}\nReassess every unanswered question before editing. Do not infer authorization for unrelated changes.`;
    if (!withinInstructionLimit(instructions))
      throw new ExecutionRequestError(
        'invalid-request',
        'Disposition rationale and guidance together exceed 16,000 characters. Shorten them before retrying.',
      );
    const agent =
      input.agentOverride === undefined ? {} : { finalizationAgentOverride: input.agentOverride };
    if (input.action === 'approve-plan-change') {
      const obligation = progress.obligations.find((o) => o.id === input.obligationId);
      if (
        obligation?.status !== 'change-requested' ||
        !obligation.proposedRequirement ||
        obligation.runId !== run.id
      )
        throw new ExecutionRequestError(
          'conflict',
          'Choose a current, explicit proposed obligation change.',
        );
      const updated = {
        ...progress,
        obligations: progress.obligations.map((o) =>
          o.id !== obligation.id
            ? o
            : {
                ...o,
                requirement: obligation.proposedRequirement as string,
                status: 'unverified' as const,
                proposedRequirement: undefined,
                reusedFromRunId: undefined,
                headSha: undefined,
                targetSha: undefined,
                approvedChange: {
                  previousRequirement: obligation.requirement,
                  rationale: input.rationale as string,
                  userId: context.user.id,
                  createdAt: this.now().toISOString(),
                },
              },
        ),
      };
      return this.writer.next(
        cycle,
        'review',
        run,
        context,
        {
          ...agent,
          finalizationProgress: updated,
          attempt: { stepGuidance: instructions },
          reason: 'Plan adjustment recorded; reassessing conformance before further changes.',
        },
        'approve-plan-change',
      );
    }
    if (
      input.action !== 'select-stage-findings' ||
      currentFinalizationStage(cycle)?.status !== 'selecting' ||
      !checked.noQuestions
    )
      throw new ExecutionRequestError(
        'conflict',
        'Resolve open questions before selecting this stage’s improvement batch.',
      );
    const parked = stagedFollowUps(cycle);
    if (
      // A selection stop always has a met gate: the parked-nit waiver never applies while
      // optional findings are open.
      !report.report.exitGate.met ||
      report.report.finalization?.checks.some((c) => c.status !== 'passed') ||
      report.report.finalization?.obligations.some((o) => o.status !== 'met') ||
      report.report.findings.some(
        (f) => f.status === 'open' && !optionalFinding(f) && !parkedFollowUp(parked, f),
      )
    )
      throw new ExecutionRequestError(
        'conflict',
        'Resolve required findings, checks and conformance gaps before selecting optional improvements.',
      );
    const choices = report.report.findings.filter(
      (f) => f.status === 'open' && optionalFinding(f) && f.category === stage.kind,
    );
    const selected = input.selectedFindingIds ?? [];
    if (
      new Set(selected).size !== selected.length ||
      selected.some((id) => !choices.some((f) => f.id === id))
    )
      throw new ExecutionRequestError(
        'conflict',
        'Select current optional findings from this discovery review.',
      );
    if (progress.decisions.length >= 500)
      throw new ExecutionRequestError(
        'conflict',
        'The finding disposition history has reached its limit.',
      );
    const followUps = new Map(progress.followUps.map((f) => [f.id, f]));
    for (const f of choices) {
      if (selected.includes(f.id)) followUps.delete(f.id);
      else followUps.set(f.id, f);
    }
    if (followUps.size > 500)
      throw new ExecutionRequestError(
        'conflict',
        'The optional follow-up ledger has reached its limit.',
      );
    const updated: FinalizationProgress = {
      ...progress,
      followUps: [...followUps.values()],
      stages: progress.stages.map((s, i) =>
        i === progress.stageIndex ? { ...s, status: 'verifying', selectedFindingIds: selected } : s,
      ),
      decisions: [
        ...progress.decisions,
        {
          stageId: stage.id,
          runId: run.id,
          selectedIds: selected,
          rationale: input.rationale,
          userId: context.user.id,
          createdAt: this.now().toISOString(),
        },
      ],
    };
    const extra = input.additionalRounds ?? 0;
    if (!validExtraRounds(extra, { min: 0, base: cycle.additionalRemediationRounds ?? 0 }))
      throw new ExecutionRequestError(
        'invalid-request',
        'Authorize at most 20 additional stage attempts.',
      );
    if (selected.length && remediationUsed(cycle) >= remediationAllowance(cycle) + extra)
      throw new ExecutionRequestError(
        'conflict',
        'This stage has no remaining remediation attempts. Authorize focused remediation to add attempts for the selected findings.',
      );
    // Persist selection and reservation atomically. Empty selection runs a bounded verification
    // that records the follow-ups and advances, rather than reopening discovery on resume.
    return this.writer.next(
      cycle,
      selected.length ? 'remediate' : 'review',
      run,
      context,
      {
        ...agent,
        finalizationProgress: updated,
        findingFocus: selected,
        ...(selected.length ? { remediationRounds: cycle.remediationRounds + 1 } : {}),
        ...(extra
          ? { additionalRemediationRounds: (cycle.additionalRemediationRounds ?? 0) + extra }
          : {}),
        attempt: { stepGuidance: instructions },
        reason: selected.length
          ? 'Implementing the selected stage batch, followed by focused verification.'
          : 'Recording optional follow-ups and verifying the stage without new improvement discovery.',
      },
      'select-stage-findings',
    );
  }

  async authorizeFinalizationRemediation(
    context: CommandContext,
    cycle: WorkCycle,
    additionalRounds: number,
    instructions: string,
    agentOverride?: WorkCycle['finalizationAgentOverride'],
  ): Promise<WorkCycle> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    this.gates.requireNoInvestigation(cycle);
    finalizationForCycle(this.storage, cycle);
    if (
      !validExtraRounds(additionalRounds, {
        min: 1,
        base: cycle.additionalRemediationRounds ?? 0,
      })
    )
      throw new ExecutionRequestError(
        'conflict',
        'Authorize between 1 and 20 additional remediation attempts.',
      );
    this.mutations.requireAvailable(cycle.worktreeId);
    const blocker = this.remediation.finalizationRemediationBlocker(cycle);
    if (blocker) throw new ExecutionRequestError('conflict', blocker);
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (!run) throw new NotFoundError();
    return this.remediation.grantRemediation(cycle, run, context, {
      additionalRounds,
      instructions,
      agentOverride,
    });
  }
}
