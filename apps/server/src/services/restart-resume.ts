import type { AgentRun, CycleStep, WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';

/**
 * Restart handling for cycle steps (R-B9). A controlled stop drains live turns for a
 * bounded time and then interrupts what is left, recording the typed exit reason
 * `daemon-drain`. After a clean restart the controller resumes such a step through its
 * vendor session, so the conversation and worktree edits survive and only the
 * in-flight tool call is redone. Crashes, runs without a session id, and failed resumes
 * keep the explicit operator resume.
 */

type Execution = Pick<StorageRepositories['execution'], 'runEvents'>;

/** True when a controlled drain, not a crash or the operator, ended this run. */
export function drainInterrupted(execution: Execution, run: AgentRun): boolean {
  if (run.status !== 'interrupted') return false;
  const ended = execution.runEvents.latestOfKind(run.workspaceId, run.id, 'run-finished');
  return ended?.kind === 'run-finished' && ended.payload.reason === 'daemon-drain';
}

export function cycleStepRole(step: CycleStep): AgentRun['role'] {
  return step === 'remediate' ? 'implement' : step;
}

export interface SessionResume {
  readonly run: AgentRun;
  readonly sessionId: string;
  /** `restart`: a drain interrupted the step (R-B9). `output-repair`: its report failed validation (R-C2). */
  readonly kind: 'restart' | 'output-repair';
}

/**
 * The vendor session a cycle's next launch resumes: its parent is a run of the same step in
 * the same worktree that reported a session id, and either the restart drain interrupted
 * it or it finished with a report the controller sent back for an output-format repair.
 */
export function sessionResumeSource(
  execution: Execution,
  cycle: Pick<WorkCycle, 'parentRunId' | 'step' | 'worktreeId' | 'outputRepair'>,
  parent: AgentRun | undefined,
): SessionResume | undefined {
  if (
    parent === undefined ||
    parent.id !== cycle.parentRunId ||
    parent.worktreeId !== cycle.worktreeId ||
    parent.role !== cycleStepRole(cycle.step) ||
    parent.backendSessionId === undefined
  )
    return undefined;
  if (drainInterrupted(execution, parent))
    return { run: parent, sessionId: parent.backendSessionId, kind: 'restart' };
  if (cycle.outputRepair?.sourceRunId === parent.id && parent.status === 'finished')
    return { run: parent, sessionId: parent.backendSessionId, kind: 'output-repair' };
  return undefined;
}

/** The first message of a resumed session; the original brief is already in its history. */
export function restartResumePrompt(input: {
  readonly deadlineAt: string;
  readonly previousRunDirectory: string;
  readonly runDirectory: string;
}): string {
  return [
    'CraftingTable restarted while this step was in progress and has resumed your session. The step, its instructions, your permissions and its deadline are unchanged; the deadline is ' +
      `${input.deadlineAt}.`,
    'Your last tool call may have been cut off. Before relying on its result, check what it actually did (files, commits, test output) and redo it if it did not complete. Do not assume an interrupted check passed.',
    `Files from before the restart are still in ${input.previousRunDirectory}. This resumed run's refreshed brief and scratch directory are in ${input.runDirectory}; use its tool paths from now on.`,
    'Continue the step from where you stopped and finish with the final report your original instructions ask for.',
  ].join('\n\n');
}

/**
 * The message that resumes a session whose final report failed a structural check (R-C2).
 * Only the reply's final message is read, so it must be the whole report again.
 */
export function outputRepairPrompt(input: {
  readonly issues: readonly string[];
  readonly attempt: number;
  readonly limit: number;
  readonly deadlineAt: string;
  readonly previousRunDirectory: string;
  readonly runDirectory: string;
}): string {
  return [
    `CraftingTable could not accept your final report for this step because it does not have the required structure. The validator reported:\n${input.issues.map((issue) => `- ${issue}`).join('\n')}`,
    `This is automatic repair ${input.attempt} of ${input.limit}; after that the step stops for the operator. Your work is not being rejected, only the report's format.`,
    'Reply with the complete corrected final report: the whole report your original instructions ask for, including every required section and structured block, not only the corrected part, because only this reply is read. Do not redo the step, change files or make commits. If you have questions for the operator, list them under “## Open questions” instead of guessing.',
    `Files from the previous turn are in ${input.previousRunDirectory}. This run's refreshed brief and scratch directory are in ${input.runDirectory}. The deadline is ${input.deadlineAt}.`,
  ].join('\n\n');
}
