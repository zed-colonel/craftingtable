import { cycleLayers } from '../../agent-profile-policy.js';
import { resolveAgent } from '../../agent-resolution.js';
import { randomUUID } from 'node:crypto';
import {
  type AgentRun,
  asAgentRunId,
  OUTPUT_REPAIR_LIMIT,
  type WorkCycle,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AgentRunService } from '../../agent-run-service.js';
import { collectDesignRecovery } from '../../design-recovery.js';
import { ExecutionRequestError } from '../../errors.js';
import type { StepOutcomeDecision } from '../core/step-outcome.js';

export type { CyclePassObserver } from '../shared.js';

import type { CycleWriter } from '../writer.js';
import { OUTPUT_REPAIR_MINUTES } from '../shared.js';

export class CycleRestart {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly runs: AgentRunService,
    private readonly now: () => Date,
    private readonly writer: CycleWriter,
  ) {}

  /**
   * Relaunches a step the restart drain interrupted by resuming its vendor session, with
   * the same agent, permissions, guidance and original deadline (R-B9). The source run
   * becomes the new run's parent, which is what the launch resumes from. A run without a
   * session id is classified as `restart-session-lost` by `decideStepOutcome` instead.
   */
  async resumeAfterRestart(cycle: WorkCycle, run: AgentRun): Promise<void> {
    if (this.runs.isDraining()) return;
    await this.writer.next(
      cycle,
      cycle.step,
      run,
      undefined,
      {
        runDeadlineAt: cycle.runDeadlineAt,
        resultContinuations: cycle.resultContinuations ?? 0,
        providerRecovery: cycle.providerRecovery ?? null,
        outputRepair: cycle.outputRepair ?? null,
        stepGuidance: cycle.stepGuidance,
        instructions: cycle.instructions,
        housekeepingInstructions: cycle.housekeepingInstructions,
        reason: `Resuming the ${cycle.step} session that the daemon restart interrupted.`,
      },
      'resume-after-restart',
    );
  }

  /**
   * Resumes the session whose final report failed a structural check and asks for the
   * corrected report (R-C2). The step keeps its guidance and deadline; a repair turn gets at
   * least `OUTPUT_REPAIR_MINUTES` even when the step used most of its window.
   */
  async repairOutput(
    cycle: WorkCycle,
    run: AgentRun,
    repair: Extract<StepOutcomeDecision, { kind: 'repair-output' }>,
  ): Promise<void> {
    if (this.runs.isDraining()) return;
    const floor = this.now().getTime() + OUTPUT_REPAIR_MINUTES * 60_000;
    await this.writer.next(
      cycle,
      cycle.step,
      run,
      undefined,
      {
        outputRepair: {
          attempts: repair.attempt,
          sourceRunId: run.id,
          code: repair.code,
          issues: repair.issues,
        },
        runDeadlineAt:
          Date.parse(cycle.runDeadlineAt) >= floor
            ? cycle.runDeadlineAt
            : new Date(floor).toISOString(),
        resultContinuations: cycle.resultContinuations ?? 0,
        stepGuidance: cycle.stepGuidance,
        instructions: cycle.instructions,
        housekeepingInstructions: cycle.housekeepingInstructions,
        reason: `The final report did not pass validation. Asking the same agent session to correct it (automatic repair ${repair.attempt} of ${OUTPUT_REPAIR_LIMIT}).`,
      },
      'repair-output',
    );
  }

  /**
   * The controller's one continue after an investigation that answered every question
   * (R-C3a): the same bounded run the operator would start with Resolve design questions,
   * from the investigation's evidence and the operator's guidance, on the design agent.
   */
  continueDesign(cycle: WorkCycle, investigation: AgentRun, reason: string): WorkCycle {
    const recovery = cycle.designRecovery;
    if (recovery?.mode !== 'investigate' || recovery.runId !== investigation.id)
      throw new ExecutionRequestError('conflict', 'Only an investigation continues automatically.');
    const preview = this.storage.readTransaction((tx) =>
      collectDesignRecovery(tx, cycle, investigation.id),
    );
    const design = resolveAgent({
      purpose: 'design',
      ...cycleLayers(this.storage, cycle),
    }).selection;
    if (!this.runs.hasBackend(design.backend))
      throw new ExecutionRequestError('unavailable', 'The design backend is unavailable.');
    const runId = asAgentRunId(randomUUID());
    return this.writer.change(
      cycle,
      {
        status: 'running',
        step: 'design',
        currentRunId: runId,
        parentRunId: investigation.id,
        phaseWait: null,
        designWait: null,
        designDependencyContinuations: 0,
        resultContinuations: 0,
        // A new step: the investigation's service retries, repairs and guidance end with it.
        providerRecovery: null,
        outputRepair: null,
        stepGuidance: undefined,
        runDeadlineAt: this.writer.deadline(cycle.policy.maxRunMinutes),
        designRecovery: {
          runId,
          sourceRunId: investigation.id,
          mode: 'continue',
          automatic: true,
          profile: design,
          instructions: recovery.instructions,
          attachments: recovery.attachments,
          snapshotDigest: preview.snapshotDigest,
          facts: preview.facts,
          sources: preview.sources.map((entry) => entry.source),
        },
        reason,
      },
      'design-continue',
    );
  }
}
