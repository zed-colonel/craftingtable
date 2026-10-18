/**
 * A staged finalization's stage effects (R-B7): advancing a stage after its review, whether the
 * review is current, and entering and completing a stage.
 */
import {
  type AgentRun,
  currentFinalizationStage,
  cycleAttention,
  type FinalizationProgress,
  optionalFinding,
  type WorkCycle,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { CommandContext } from '../../auth-service.js';
import type { BranchService } from '../../branch-service.js';
import { ExecutionRequestError, TypedRefusalError } from '../../errors.js';
import { finalizationForCycle } from '../../finalization-policy.js';
import { assessStageReport, recordStageEvidence } from '../../finalization-stage-policy.js';
import {
  decideDiscovery,
  decideStageCompletion,
  decideStageInput,
  decideStageOutcome,
  ledgerFull,
  nitsParked,
  stageFindings,
  STAGE_REVIEW_CHANGED_WORKTREE,
  stageReportInvalid,
} from '../core/effect-decisions.js';
import { latestReviewReport } from '../../run-lineage.js';

import type { CycleWriter } from '../writer.js';
import type { CycleRemediation } from './remediation.js';
import type { CycleIntegration } from './integration.js';

export class CycleFinalizationStage {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly git: GitOperations | undefined,
    private readonly branches: BranchService,
    private readonly writer: CycleWriter,
    private readonly remediation: CycleRemediation,
    private readonly integration: CycleIntegration,
  ) {}

  async advanceFinalizationStage(
    cycle: WorkCycle,
    run: AgentRun,
    noQuestions: boolean,
  ): Promise<void> {
    const value = finalizationForCycle(this.storage, cycle);
    const progress = cycle.finalizationProgress;
    const stage = value?.stages?.[progress?.stageIndex ?? 0];
    const baseline = run.reviewBranchContext;
    const raw = latestReviewReport(this.storage.execution, run);
    if (!value || !progress || !stage || !raw || !baseline) {
      const invalid = stageReportInvalid();
      this.writer.attention(cycle, invalid.code, invalid.message);
      return;
    }
    const assessment = assessStageReport(value, cycle, raw, baseline);
    if (assessment.status !== 'complete' || !assessment.report.finalization) {
      const invalid = stageReportInvalid(assessment.issues);
      this.writer.attention(cycle, invalid.code, invalid.message);
      return;
    }
    const report = assessment.report;
    const evidence = report.finalization;
    if (!evidence) return;
    let updated = recordStageEvidence(cycle, assessment, baseline);
    const state = currentFinalizationStage(cycle);
    const discovery =
      (stage.kind === 'simplification' || stage.kind === 'polish') && state?.status !== 'verifying';
    const followUps = new Map(updated.followUps.map((f) => [f.id, f]));
    for (const f of report.findings) {
      if (
        f.status === 'open' &&
        optionalFinding(f) &&
        !(cycle.findingFocus ?? []).includes(f.id) &&
        !updated.stages.some((s) => s.selectedFindingIds.includes(f.id)) &&
        (!discovery || f.category !== stage.kind)
      )
        followUps.set(f.id, f);
    }
    updated = { ...updated, followUps: [...followUps.values()] };
    if (updated.obligations.length > 2000 || updated.followUps.length > 500) {
      const full = ledgerFull();
      this.writer.attention(cycle, full.code, full.message);
      return;
    }
    cycle = this.writer.change(cycle, { finalizationProgress: updated }, 'stage-evidence');
    const input = decideStageInput(noQuestions, evidence.obligations);
    if (input) {
      this.writer.attention(cycle, input.code, input.message);
      return;
    }
    const findings = stageFindings(cycle, report, evidence);
    const reopenIndex = value.stages?.findLastIndex((s) => s.kind === findings.reopenKind) ?? -1;
    if (reopenIndex >= 0 && reopenIndex < updated.stageIndex) {
      const stages = updated.stages.map((s, i) =>
        i === reopenIndex
          ? { ...s, status: 'reviewing' as const }
          : value.stages?.[i]?.kind === 'final-review'
            ? { ...s, status: 'pending' as const }
            : s,
      );
      await this.enterFinalizationStage(
        cycle,
        run,
        { ...updated, stages, stageIndex: reopenIndex },
        `New ${findings.reopenKind} issues reopened ${value.stages?.[reopenIndex]?.name}. Its used budget is retained.`,
      );
      return;
    }
    const selectedOpen = report.findings.some(
      (f) =>
        f.status === 'open' &&
        ((cycle.findingFocus ?? []).includes(f.id) || state?.selectedFindingIds.includes(f.id)),
    );
    let required = findings.required;
    if (
      nitsParked(cycle, findings, {
        selectedOpen,
        finalReview: stage.kind === 'final-review',
        ownPass: state?.completedRunId === undefined,
      })
    ) {
      updated = { ...updated, followUps: [...updated.followUps, ...required] };
      if (updated.followUps.length > 500) {
        const full = ledgerFull();
        this.writer.attention(cycle, full.code, full.message);
        return;
      }
      cycle = this.writer.change(
        cycle,
        {
          finalizationProgress: updated,
          reason: `${stage.name}: its remediation attempts are spent and only nits remain; ${required.length} kept as follow-up work.`,
        },
        'stage-nits-parked',
      );
      required = [];
    }
    const outcome = decideStageOutcome(
      cycle,
      assessment,
      { ...findings, required },
      { discovery, selectedOpen, finalReview: stage.kind === 'final-review' },
    );
    switch (outcome.kind) {
      case 'discovery': {
        if (!(await this.stageReviewIsCurrent(cycle, run))) return;
        const choices = report.findings.filter(
          (f) => f.status === 'open' && optionalFinding(f) && f.category === stage.kind,
        );
        const found = decideDiscovery({
          stageName: stage.name,
          // R-C7 D6: started with "optional findings: follow-up", discovery keeps them all as
          // follow-up work, as an empty selection would, and the stage completes.
          keepAsFollowUps: stage.optionalFindings === 'follow-up',
          choices,
          followUps: updated.followUps,
        });
        if (found.kind === 'attention') {
          this.writer.attention(cycle, found.code, found.message);
          return;
        }
        if (found.kind === 'follow-ups') {
          cycle = this.writer.change(
            cycle,
            {
              finalizationProgress: { ...updated, followUps: found.followUps },
              reason: `${stage.name}: ${choices.length} optional finding(s) kept as follow-up work, as chosen at the start.`,
            },
            'stage-optional-follow-ups',
          );
          await this.completeFinalizationStage(cycle, run);
        } else if (found.kind === 'select')
          this.writer.change(
            cycle,
            {
              status: 'needs-attention',
              attention: cycleAttention(found.code),
              finalizationProgress: {
                ...updated,
                stages: updated.stages.map((s, i) =>
                  i === updated.stageIndex ? { ...s, status: 'selecting' } : s,
                ),
              },
              reason: found.reason,
            },
            'stage-selection-required',
          );
        else await this.completeFinalizationStage(cycle, run);
        return;
      }
      case 'remediate':
        await this.remediation.reviewRemediation(cycle, run);
        return;
      case 'attention':
        this.writer.attention(cycle, outcome.code, outcome.message);
        return;
      case 'complete':
        if (!(await this.stageReviewIsCurrent(cycle, run))) return;
        await this.completeFinalizationStage(cycle, run);
        return;
    }
  }

  async stageReviewIsCurrent(cycle: WorkCycle, run: AgentRun): Promise<boolean> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    const changes = tree && (await this.git?.inspectWorktreeChanges(tree.path));
    if (
      !tree ||
      !changes?.ok ||
      changes.value.conflicted ||
      changes.value.branch !== tree.branchName
    )
      throw new TypedRefusalError(
        'worktree-state',
        'Stage completion requires the managed branch without a pending Git operation.',
      );
    if (!changes.value.clean || changes.value.headSha !== run.reviewBranchContext?.headSha) {
      await this.remediation.housekeeping(cycle, run, STAGE_REVIEW_CHANGED_WORKTREE);
      return false;
    }
    if (await this.integration.refreshIntegration(cycle, run)) return false;
    await this.branches.assertReview(tree, run);
    return true;
  }

  async enterFinalizationStage(
    cycle: WorkCycle,
    run: AgentRun,
    progress: FinalizationProgress,
    reason: string,
    context?: CommandContext,
  ) {
    const value = finalizationForCycle(this.storage, cycle);
    const stage = value?.stages?.[progress.stageIndex];
    if (!stage) throw new ExecutionRequestError('conflict', 'Unknown finalization stage.');
    const state = progress.stages[progress.stageIndex];
    return this.writer.next(
      cycle,
      'review',
      run,
      context,
      {
        finalizationProgress: {
          ...progress,
          stages: progress.stages.map((s, i) =>
            i === progress.stageIndex && s.status === 'pending' ? { ...s, status: 'reviewing' } : s,
          ),
        },
        policy: stage.policy,
        polishPhase: stage.kind === 'final-review' ? 'final-review' : 'verify',
        findingFocus: state?.selectedFindingIds ?? [],
        stalledReviews: 0,
        previousFindingFingerprint: undefined,
        reason,
      },
      'enter-finalization-stage',
    );
  }

  async completeFinalizationStage(cycle: WorkCycle, run: AgentRun) {
    const progress = cycle.finalizationProgress;
    if (!progress || !run.reviewBranchContext)
      throw new ExecutionRequestError('conflict', 'Stage state is unavailable.');
    const stages = progress.stages.map((s, i) =>
      i === progress.stageIndex
        ? {
            ...s,
            status: 'completed' as const,
            completedRunId: run.id,
            headSha: run.reviewBranchContext?.headSha,
            targetSha: run.reviewBranchContext?.targetSha,
          }
        : s,
    );
    const completed = decideStageCompletion(stages);
    if (completed.kind === 'gate')
      return this.writer.change(
        cycle,
        {
          finalizationProgress: { ...progress, stages },
          status: 'awaiting-merge',
          attention: cycleAttention(completed.code),
          reason: completed.reason,
        },
        'final-stages-completed',
      );
    return this.enterFinalizationStage(
      cycle,
      run,
      { ...progress, stages, stageIndex: completed.stageIndex },
      'Starting the next finalization stage.',
    );
  }
}
