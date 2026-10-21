/**
 * The step outcome's application (R-B2, R-B4; R-B7): what the pass does once `decideStepOutcome`
 * classified the current run, each outcome through the effect it names (approval and the
 * workflow's reviews, a finalization stage, remediation and the implementation checkpoint, the
 * integration refresh and resolution, the restart's resume, output repair, design continuation)
 * or the writer.
 */

import type { AgentRun, WorkCycle, Worktree } from '@craftingtable/domain';
import type { AgentRunService } from '../../agent-run-service.js';
import { continueDesignFailure, decideFinalized } from '../core/effect-decisions.js';
import type { StepOutcomeDecision } from '../core/step-outcome.js';
import type { CycleLocks } from '../locks.js';
import type { CycleWriter } from '../writer.js';
import type { CycleFinalizationStage } from './finalization-stage.js';
import type { CycleIntegration } from './integration.js';
import type { CycleRemediation } from './remediation.js';
import type { CycleRestart } from './restart.js';
import type { CycleWorkflow } from './workflow.js';

export class CycleOutcomes {
  constructor(
    private readonly runs: AgentRunService,
    private readonly writer: CycleWriter,
    private readonly locks: CycleLocks,
    private readonly remediation: CycleRemediation,
    private readonly integration: CycleIntegration,
    private readonly workflow: CycleWorkflow,
    private readonly finalizationStage: CycleFinalizationStage,
    private readonly restart: CycleRestart,
  ) {}

  /** Carries out what `decideStepOutcome` decided for the current run (R-B2). */
  async applyStepOutcome(
    cycle: WorkCycle,
    run: AgentRun,
    worktree: Worktree,
    decision: StepOutcomeDecision,
  ): Promise<void> {
    switch (decision.kind) {
      case 'wait-for-run':
        return;
      case 'resume-after-restart':
        await this.restart.resumeAfterRestart(cycle, run);
        return;
      case 'end-turn':
        if (!this.locks.ending.has(run.id) && this.runs.finishCycleTurn(cycle))
          this.locks.ending.add(run.id);
        return;
      case 'attention':
        // A drain stops the loop before it interrupts runs; this only guards a late pass.
        if (decision.code === 'restart-session-lost' && this.runs.isDraining()) return;
        break;
      default:
        break;
    }
    this.locks.ending.delete(run.id);
    if (decision.workflow) cycle = this.writer.change(cycle, { workflow: decision.workflow });
    switch (decision.kind) {
      case 'attention':
        this.writer.attention(
          cycle,
          decision.code,
          decision.message,
          undefined,
          decision.repairAttempts,
        );
        return;
      case 'repair-output':
        await this.restart.repairOutput(cycle, run, decision);
        return;
      case 'schedule-service-retry':
        this.writer.change(
          cycle,
          {
            attempt: decision.attempt,
            ...(decision.runDeadlineAt ? { runDeadlineAt: decision.runDeadlineAt } : {}),
            reason: decision.reason,
          },
          'provider-backoff',
        );
        return;
      case 'next-step':
        await this.writer.next(
          cycle,
          decision.step,
          run,
          undefined,
          decision.changes,
          decision.action,
        );
        return;
      case 'advance-resolution':
        await this.integration.advanceResolution(cycle);
        return;
      case 'continue-design':
        try {
          this.restart.continueDesign(cycle, run, decision.reason);
        } catch (error) {
          // The investigation's stop stays the operator's, with its results panel.
          const stopped = continueDesignFailure(error);
          this.writer.attention(cycle, stopped.code, stopped.message);
        }
        return;
      case 'design-wait':
        this.writer.change(cycle, {
          waits: { design: decision.designWait },
          reason: decision.reason,
        });
        return;
      case 'finalize-implementation': {
        const finalized = await this.remediation.finalizeImplementation(cycle, run);
        if (!finalized) return;
        if (await this.integration.refreshIntegration(finalized, run, true)) return;
        let head: string | undefined;
        if (finalized.step === 'remediate')
          try {
            head = await this.writer.cleanHead(finalized);
          } catch {
            head = undefined;
          }
        const reviewed = decideFinalized({
          step: finalized.step,
          unchangedTwice: !!head && this.remediation.remediatedNothingTwice(finalized, run, head),
        });
        if (reviewed.kind === 'attention') {
          this.writer.attention(finalized, reviewed.code, reviewed.message);
          return;
        }
        await this.writer.next(finalized, 'review', run);
        return;
      }
      case 'advance-finalization-stage':
        await this.finalizationStage.advanceFinalizationStage(cycle, run, decision.noQuestions);
        return;
      case 'remediate-review':
        if (decision.clearActiveReview && cycle.workflow)
          cycle = this.writer.change(cycle, {
            workflow: { ...cycle.workflow, activeReview: null, waiting: null },
          });
        await this.remediation.reviewRemediation(cycle, run);
        return;
      case 'approve-review':
        await this.workflow.approveReview(cycle, run, worktree, decision);
        return;
      default:
        return;
    }
  }
}
