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

/**
 * The vendor session a cycle's next launch resumes: its parent is the drain-interrupted
 * run of the same step, and that run reported a session id.
 */
export function restartResumeSource(
  execution: Execution,
  cycle: Pick<WorkCycle, 'parentRunId' | 'step' | 'worktreeId'>,
  parent: AgentRun | undefined,
): { readonly run: AgentRun; readonly sessionId: string } | undefined {
  if (
    parent === undefined ||
    parent.id !== cycle.parentRunId ||
    parent.worktreeId !== cycle.worktreeId ||
    parent.role !== cycleStepRole(cycle.step) ||
    parent.backendSessionId === undefined ||
    !drainInterrupted(execution, parent)
  )
    return undefined;
  return { run: parent, sessionId: parent.backendSessionId };
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
