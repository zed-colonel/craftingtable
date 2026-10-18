/**
 * What a cycle's run is given to launch (R-B7 run-context): today's `startForCycle` after its
 * checks, as a function of the stored state: the agent profile, the step's guidance, the
 * workflow's output and obligations file, and the controller's instructions.
 */
import { ownsIntegrationResolution, type WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import {
  cycleLaunchAgent,
  cycleLaunchRecord,
  launchProvenance,
} from '../../agent-profile-policy.js';
import { launchProfile } from '../../agent-resolution.js';
import { RUN_RECORDS } from '../../brief.js';
import { TypedRefusalError } from '../../errors.js';
import {
  finalizationForCycle,
  finalizationInstructions,
  finalizationStageOutput,
} from '../../finalization-policy.js';
import { scopeReviewerRoles } from '../../map-adoption-policy.js';
import { sessionResumeSource } from '../../restart-resume.js';
import { STEP_RULES } from '../../step-rules.js';
import { WORKFLOW_OBLIGATIONS_FILE, workflowBrief } from '../../workflow-policy.js';
import type { StartRunInput } from '../shared.js';

/** A cycle's launch: the run's input and the provenance of its agent profile. */
export interface CycleLaunchInput {
  readonly input: StartRunInput;
  readonly provenance: ReturnType<typeof launchProvenance>;
}

/** The cycle's launch input; refuses a stage-less finalization, which is retired. */
export function cycleLaunchInput(
  storage: CraftingTableStorage,
  cycle: WorkCycle,
): CycleLaunchInput {
  const resolution = ownsIntegrationResolution(cycle) ? cycle.integrationResolution : undefined;
  const finalization = finalizationForCycle(storage, cycle);
  // Every path that launches a finalization run (cycle control, service retries,
  // continuations) ends here; a stage-less finalization is retired (R-B10) and gets no run.
  if (finalization && !finalization.stages)
    throw new TypedRefusalError(
      'legacy-finalization-retired',
      'This finalization uses retired improvement rounds. Stop it and start a staged finalization.',
    );
  const recovery =
    cycle.step === 'design' && cycle.designRecovery?.runId === cycle.currentRunId
      ? cycle.designRecovery
      : undefined;
  const record = cycleLaunchRecord(storage, cycle);
  // A resumed session keeps the agent, model and permissions it was started with.
  const resumed = sessionResumeSource(
    storage.execution,
    cycle,
    cycle.parentRunId && storage.execution.runs.find(cycle.workspaceId, cycle.parentRunId),
  )?.run;
  const launch = cycleLaunchAgent(storage, cycle, {
    ...(resumed ? { resumed } : {}),
    ...(recovery ? { recovery } : {}),
    ...(finalization ? { finalization } : {}),
    ...(resolution ? { resolution } : {}),
  });
  const profile = launchProfile(launch);
  const workflow = ownsIntegrationResolution(cycle) ? undefined : workflowBrief(storage, cycle);
  const stage = finalization && finalizationStageOutput(finalization, cycle);
  return {
    input: {
      ...profile,
      worktreeId: cycle.worktreeId,
      role: cycle.step === 'remediate' ? 'implement' : cycle.step,
      ...(cycle.parentRunId === undefined ? {} : { parentRunId: cycle.parentRunId }),
      instructions: cycle.instructions,
      stepGuidance: [cycle.attempt?.stepGuidance, recovery?.instructions, resolution?.instructions]
        .filter(Boolean)
        .join('\n\n'),
      output: {
        ...(workflow ? { workflow: workflow.output } : {}),
        ...(stage ? { finalizationStage: stage } : {}),
      },
      // The obligations the workflow contract names, as a file rather than inline JSON (AGT-58).
      ...(workflow
        ? {
            records: [
              {
                filename: WORKFLOW_OBLIGATIONS_FILE,
                content: JSON.stringify(workflow.obligations, null, 2),
                about: RUN_RECORDS[WORKFLOW_OBLIGATIONS_FILE],
              },
            ],
          }
        : {}),
      controllerInstructions: [
        workflow?.rules ?? '',
        cycle.attempt?.providerRecovery
          ? `This is service retry ${cycle.attempt?.providerRecovery.attempts} of 3 for the SAME step after a model-service failure, in a fresh session with the configured retry backend/model. Read the prior handoff and partial scratch records; preserve completed work and unresolved findings. Inspect the current worktree and evidence before continuing. Do not assume an interrupted check passed, repeat completed side effects blindly, or treat a draft report as accepted. Complete every required check and the final report. Report genuine decisions in ## Open questions; never decide them for the operator. If the previous attempt stopped with questions the service failure caused, do not repeat them; ask again any that remain. The step deadline still applies; it moved only by time spent waiting for a usage-limit reset or for the provider to accept credentials.`
          : '',
        cycle.scopeRepair ? STEP_RULES.scopeRepair : '',
        ...(recovery
          ? [
              'This is a bounded design-question recovery in the existing worktree. Read the complete prior handoff, recovery context, shared source documents and operator attachments before asking for information again.',
              'Collect verifiable facts and cite exact artifacts, commits and commands. Saved pins and imported documents are context, not proof that tests passed. Separate repository observations, missing evidence, and decisions that require the operator. Do not invent owners, measurements, protection rules or acceptance receipts.',
              'Do not implement product changes, create/publish tags, change branch protection, push, merge or amend adopted requirements. Preserve source code; keep collected reports and logs in the supplied run scratch directory. Repository administration needs a separate explicit operator action.',
              recovery.mode === 'investigate'
                ? 'Investigate the unresolved questions and report evidence and remaining decisions. Classify each question in the design report: resolved only with a cited answer; anything the operator must decide stays an operator decision. If every question is resolved and Open questions is none, the controller continues the design with your evidence; otherwise it pauses for operator review.'
                : 'Apply the operator answers and supporting evidence to complete the design. The controller advances only if no genuine questions remain. Keep unresolved evidence requirements explicit.',
            ]
          : []),
        cycle.executionScope && cycle.executionScope.kind !== 'slice'
          ? `Operator-designated independent reviewer responsibilities: ${scopeReviewerRoles(storage, cycle.workspaceId, cycle.executionScope).join(', ') || 'standard independent review'}. Supply evidence for every applicable responsibility; if you cannot perform a required review, report an open question rather than claiming it passed.`
          : '',
        finalization ? finalizationInstructions(finalization, cycle) : '',
        resolution ? '' : (cycle.attempt?.housekeepingInstructions ?? ''),
        ...(resolution
          ? [
              'This is a daemon-owned integration conflict resolution. Do not start, abort, or commit a merge; do not commit source edits. Resolve files and explicitly stage all intended changes. The daemon completes the merge.',
              `Keep item HEAD at ${resolution.headSha} and MERGE_HEAD at ${resolution.targetSha}. The integration branch is ${resolution.targetBranch}; do not move it.`,
              `Conflict files: ${resolution.paths.join(', ')}`,
              resolution.diagnostics,
              'Read the supplied plan and both sides of the incoming commits. Preserve both work items’ intended behavior, including automatically merged files. Use the supplied scratch directory, run the repository checks on the combined state, and report commands, outcomes and any semantic decisions. Remove only your confirmed generated files; leave no untracked files. Preserve existing finding IDs in the handoff.',
            ]
          : []),
        (cycle.attempt?.resultContinuations ?? 0) > 0
          ? `This is completion recovery attempt ${cycle.attempt?.resultContinuations} of 2 for the SAME step. The previous agent exited while awaiting background work; its result is incomplete. CraftingTable waited for its owned process group to finish before this launch. Read the previous run handoff and its scratch verification records; do not assume any check passed. Reuse recorded passing checks only when their source commit, destination commit where relevant, inputs, and complete logs still match. Inspect and address failures; finish missing verification and reporting without restarting the whole polish pass or adding unrelated improvements. Keep every unresolved finding and operator question. If a decision is needed, report it in ## Open questions and stop rather than deciding for the operator. Do not detach commands with nohup, disown, or a new session. Await background work and produce the final outcome before ending; the original step time limit still applies.`
          : '',
        STEP_RULES.detach,
        STEP_RULES.automated,
        cycle.executionScope && cycle.executionScope.kind !== 'slice'
          ? 'This is an independent review of the integration snapshot. Do not implement changes or commit. Report findings for recovery in the owning slice.'
          : '',
        cycle.step === 'review' && (cycle.integrationRefreshes ?? 0) > 0
          ? 'The integration branch has been refreshed during this cycle. Review the combined changes and rerun the relevant repository checks; a prior review or a clean Git merge is not verification of this state.'
          : '',
        !resolution && cycle.step === 'remediate'
          ? cycle.finalizationProgress
            ? 'Address required correctness/conformance findings and all blocking/major findings. For optional improvements, implement the selected stage batch (or the explicit focused recovery subset) only; preserve every other selected finding for later verification. Do not implement retained optional follow-ups or restart discovery. Preserve finding IDs and provide evidence of each resolution.'
            : `Address all open blocking, major, and minor findings, and reduce open nits to at most ${cycle.policy.maxNits}. Preserve finding IDs and give the reviewer evidence of each resolution.`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    provenance: launchProvenance(record, launch, resumed?.profileSelection),
  };
}
