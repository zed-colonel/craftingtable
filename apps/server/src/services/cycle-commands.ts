import {
  type AgentRun,
  type CycleAction,
  type CycleStep,
  cycleAttention,
  effectiveCycleAttention,
  isTerminalAgentRunStatus,
  ownsIntegrationResolution,
  remediationAllowance,
  remediationUsed,
  resumeRedirect,
  type SourceRepositoryId,
  type WorkCycle,
} from '@craftingtable/domain';
import type { CycleChanges } from './cycle-transitions.js';

/**
 * The operator's cycle commands through the core (R-B4 increment 6). `decideCommand` decides
 * pause, stop, resume, guided resume and the provider retry from the cycle and the same facts the
 * controller reads; `control()` is the shell that gathers the facts, runs the gates that are
 * effects (the pins, the transition gate, a Git read) between the stages, and applies the
 * decision through `change()`, which holds every write to `CYCLE_TRANSITIONS`.
 *
 * The stages split where an asynchronous gate sits, so the refusals keep today's order:
 * `decideCommand` (the command itself), then the pins and settled decisions, then
 * `decideResume` (redirects and the resolution), then the worktree, readiness and transition
 * gates, then `decideResumeStep` (what the resume does).
 *
 * The commands keep today's preconditions; the offers (`cycleActions`) and the commands agree,
 * and two refusals changed (decision 14): a plain resume at the round limit is refused toward
 * Authorize more remediation, and a newer manual run outside the handoff lineage is no longer
 * offered a resume.
 */

/** Why a command was refused: its code, its words, and the control that resolves it instead. */
export interface CommandRefusal {
  readonly kind: 'refuse';
  readonly code: CommandRefusalCode;
  readonly message: string;
  readonly status: 'conflict' | 'invalid-request' | 'unavailable';
  readonly control?: CycleAction;
}

export const COMMAND_REFUSALS = [
  'cycle-changed',
  'cycle-ended',
  'finalization-retired',
  'merge-reserved',
  'no-provider-retry',
  'provider-retry-held',
  'newer-run',
  'amendment-retired',
  'guidance-too-long',
  'not-stopped',
  'redirect',
  'resolution-detected',
  'needs-guidance',
  'guidance-invalid',
  'review-guidance-invalid',
  'sessions-open',
  'outside-lineage',
  'manual-review-live',
  'round-limit',
  'resolution-owned',
  'not-reviewable',
] as const;
export type CommandRefusalCode = (typeof COMMAND_REFUSALS)[number];

const refuse = (
  code: CommandRefusalCode,
  message: string,
  extra: { readonly status?: CommandRefusal['status']; readonly control?: CycleAction } = {},
): CommandRefusal => ({
  kind: 'refuse',
  code,
  message,
  status: extra.status ?? 'conflict',
  ...(extra.control ? { control: extra.control } : {}),
});

/** A write the shell applies with `change()`, and what it ends beside it. */
export interface CommandWrite {
  readonly kind: 'write';
  readonly changes: CycleChanges;
  /** End the cycle's current turn after the write (a stop). */
  readonly endTurn?: true;
  /** Stop a review's adopted checks still starting (a pause). */
  readonly cancelChecks?: true;
}

export type OperatorCommand =
  | { readonly action: 'pause' | 'stop'; readonly expectedVersion: number }
  | {
      readonly action: 'resume' | 'retry-provider';
      readonly expectedVersion: number;
      readonly guidance?: string;
    };

/** The facts the commands read, each read when a stage asks for it. */
export interface CommandFacts {
  readonly now: Date;
  /** The plan finalization this cycle runs uses retired improvement rounds (R-B10). */
  readonly retiredFinalization: () => boolean;
  readonly mergeReserved: () => boolean;
  /** The roadmap that owns the cycle has paused its scheduling. */
  readonly providerRoadmapPaused: () => boolean;
  /** The worktree's newest run, which a resume adopts. */
  readonly newestRun: () => AgentRun | undefined;
  /** How many runs the worktree has. */
  readonly runCount: () => number;
  readonly amendmentRetired: () => boolean;
  /** A checkpoint attestation stop whose inputs changed since its review (R-C13). */
  readonly attestationInputsChanged: () => boolean;
  /** The step's questions need answers before a plain resume. */
  readonly needsGuidance: () => boolean;
  readonly liveRuns: () => readonly AgentRun[];
  /** The run continues this cycle's handoff lineage. */
  readonly continuesLineage: (run: AgentRun) => boolean;
  /** The finished review's complete report asks for remediation. */
  readonly reviewAsksRemediation: (run: AgentRun) => boolean;
  /** The worktree's scope rejects the finished review's report (`scopedReviewIssue`). */
  readonly reviewScopeIssue: (run: AgentRun) => boolean;
  /**
   * The finished review's last turn succeeded untruncated, which the grant asks of it
   * (`turnTakesGrant`).
   */
  readonly reviewTurnSucceeded: (run: AgentRun) => boolean;
  /** A new step window's deadline. */
  readonly deadline: () => string;
}

/** The first stage: the command itself, before any gate. */
export function decideCommand(
  cycle: WorkCycle,
  facts: CommandFacts,
  command: OperatorCommand,
): CommandRefusal | CommandWrite | { readonly kind: 'resume' } {
  const { action } = command;
  if (cycle.version !== command.expectedVersion)
    return refuse('cycle-changed', 'Cycle changed; refresh before issuing this command');
  if (['stopped', 'completed'].includes(cycle.status))
    return refuse('cycle-ended', 'This cycle has ended');
  // Improvement-round finalizations are retired (R-B10): their cycles never run again.
  if ((action === 'resume' || action === 'retry-provider') && facts.retiredFinalization())
    return refuse(
      'finalization-retired',
      'This finalization uses retired improvement rounds. Stop it and start a staged finalization.',
    );
  if (action !== 'pause' && facts.mergeReserved())
    return refuse(
      'merge-reserved',
      'Recover the pending merge before resuming or stopping this cycle.',
    );
  if (action === 'stop' && ownsIntegrationResolution(cycle))
    return {
      kind: 'write',
      changes: {
        status: 'paused',
        reason:
          'Resolution stopped with edits preserved. Resume or explicitly abandon the integration resolution.',
      },
      endTurn: true,
    };
  if (action === 'stop')
    return {
      kind: 'write',
      changes: {
        status: 'stopped',
        reason: 'Automation stopped by operator. Manual flow is available.',
      },
      endTurn: true,
    };
  if (action === 'pause') {
    // Pausing a stop holds it: the stop is kept so Resume returns to it rather than
    // relaunching a step the controller would stop again (R-A7, cycle d148f0a4).
    const held = cycle.status === 'needs-attention' ? effectiveCycleAttention(cycle) : undefined;
    // A review still in its adopted checks has no session to keep: its checks stop (R-G13).
    return {
      kind: 'write',
      changes: {
        status: 'paused',
        ...(held ? { attention: held } : {}),
        reason:
          'Automation paused by operator. The current session remains available for manual work.',
      },
      cancelChecks: true,
    };
  }
  const now = facts.now.getTime();
  const recovery = cycle.providerRecovery;
  if (
    action === 'retry-provider' ||
    (recovery?.nextRetryAt && now < Date.parse(cycle.runDeadlineAt))
  ) {
    if (
      !recovery?.nextRetryAt ||
      !['running', 'paused', 'needs-attention'].includes(cycle.status) ||
      recovery.attempts >= 3 ||
      now >= Date.parse(cycle.runDeadlineAt)
    )
      return refuse(
        'no-provider-retry',
        'No bounded provider retry is available. Inspect the outcome and explicitly resume for a new step window.',
      );
    if (action === 'retry-provider' && facts.providerRoadmapPaused())
      return refuse(
        'provider-retry-held',
        'Resume roadmap scheduling before retrying this provider failure.',
      );
    if (facts.newestRun()?.id !== cycle.currentRunId)
      return refuse('newer-run', 'The worktree has a newer run. Inspect it before resuming.');
    if (facts.amendmentRetired())
      return refuse('amendment-retired', 'This attempt was retired by a planning amendment.');
    // Guidance for a pending retry joins the guidance the retried step already carries.
    const offered = 'guidance' in command ? command.guidance : undefined;
    const stepGuidance = [cycle.stepGuidance, offered?.trim()].filter(Boolean).join('\n\n');
    if (stepGuidance.length > 16000)
      return refuse(
        'guidance-too-long',
        'Combined guidance for this step exceeds 16000 characters.',
        { status: 'invalid-request' },
      );
    return {
      kind: 'write',
      changes: {
        status: 'running',
        ...(stepGuidance ? { stepGuidance } : {}),
        providerRecovery: {
          ...recovery,
          nextRetryAt: action === 'retry-provider' ? facts.now.toISOString() : recovery.nextRetryAt,
        },
        reason:
          'Provider retry authorized; current phase gates, process cleanup and the original deadline still apply.',
      },
    };
  }
  if (facts.amendmentRetired())
    return refuse('amendment-retired', 'This attempt was retired by a planning amendment.');
  if (!['paused', 'needs-attention'].includes(cycle.status))
    return refuse('not-stopped', 'Only a paused cycle can resume');
  return { kind: 'resume' };
}

/** The second stage of a resume, after the pins and settled decisions: redirects and the merge. */
export function decideResume(
  cycle: WorkCycle,
  facts: CommandFacts,
  guidance: string | undefined,
): CommandRefusal | CommandWrite | { readonly kind: 'resolution' } | { readonly kind: 'gates' } {
  // A plain resume that would only reproduce this stop is refused with the control that
  // can resolve it (R-A7, CTRL-04); guided resumes carry the missing input. A newer run the
  // resume cannot adopt has no redirect: its own refusal follows (`outside-lineage`).
  const redirect =
    guidance === undefined && !facts.attestationInputsChanged()
      ? resumeRedirect(cycle, facts.newestRun()?.id)
      : undefined;
  if (redirect) {
    // A paused stop that a plain resume would only reproduce returns to the stop, where its
    // own control resolves it.
    if (cycle.status === 'paused' && cycle.attention)
      return {
        kind: 'write',
        changes: {
          status: 'needs-attention',
          attention: cycle.attention,
          reason: `Pause lifted. ${redirect.message}`,
        },
      };
    return refuse('redirect', redirect.message, { control: redirect.action });
  }
  if (cycle.integrationResolution?.status === 'detected')
    return refuse(
      'resolution-detected',
      'Use Resolve integration conflicts to delegate the detected conflict.',
      { control: 'resolve-integration' },
    );
  // The resolution's own command runs the launch gates itself.
  if (ownsIntegrationResolution(cycle)) return { kind: 'resolution' };
  return { kind: 'gates' };
}

/** Whether a resume adopts the worktree's newest run, which launches nothing (no launch gate). */
export function resumeAdopts(cycle: WorkCycle, newest: AgentRun | undefined): boolean {
  return !!newest && newest.id !== cycle.currentRunId && newest.id !== cycle.parentRunId;
}

/** What the third stage of a resume decided. */
export type ResumeStep =
  | CommandRefusal
  | CommandWrite
  | {
      readonly kind: 'launch';
      readonly step: CycleStep;
      readonly parent: AgentRun | undefined;
      readonly changes?: CycleChanges;
      readonly action?: string;
    }
  | {
      readonly kind: 'remediate';
      readonly grant?: { readonly additionalRounds: 0; readonly instructions: string };
    }
  /** Review an independent scope again; the shell reads Git first when `snapshotCheck`. */
  | {
      readonly kind: 'review-scope';
      readonly guidance: string;
      readonly snapshotCheck: boolean;
    };

/**
 * The third stage of a resume, after the worktree, readiness and transition gates: answers the
 * step needs, guidance, adopting a newer run, or relaunching the step. `clearsEnding` says the
 * shell has passed the open-sessions check, where today's resume forgets a turn it was ending.
 */
export function decideResumeStep(
  cycle: WorkCycle,
  facts: CommandFacts,
  guidance: string | undefined,
): ResumeStep & { readonly clearsEnding?: true } {
  const run = facts.newestRun();
  if (guidance === undefined && facts.needsGuidance())
    return refuse(
      'needs-guidance',
      'This step has open questions. Use Continue with guidance to supply answers before resuming.',
      { control: 'continue-with-guidance' },
    );
  const scope = cycle.executionScope;
  if (guidance !== undefined && !cycle.finalizationId && (!scope || scope.kind === 'slice')) {
    if (
      !guidance.trim() ||
      !['implement', 'remediate', 'review'].includes(cycle.step) ||
      !run ||
      run.id !== cycle.currentRunId ||
      facts.liveRuns().length > 0
    )
      return refuse(
        'guidance-invalid',
        'Guided continuation requires answers or guidance and the ended current implementation or review.',
      );
    // A step that failed or was interrupted (a service stop asks for guidance) never acted
    // on its guidance to completion, so the retry carries it forward with the new guidance.
    const stepGuidance = [run.status === 'finished' ? undefined : cycle.stepGuidance, guidance]
      .map((text) => text?.trim())
      .filter(Boolean)
      .join('\n\n');
    if (stepGuidance.length > 16000)
      return refuse(
        'guidance-too-long',
        'Combined guidance for this step exceeds 16000 characters.',
        { status: 'invalid-request' },
      );
    if (cycle.step === 'review' && run.status === 'finished' && facts.reviewAsksRemediation(run))
      return { kind: 'remediate', grant: { additionalRounds: 0, instructions: stepGuidance } };
    // After two remediations that changed nothing, the guidance is for a fresh review of the
    // same commit: another remediation would change nothing again (LIVE-27 review).
    const noChange = effectiveCycleAttention(cycle)?.code === 'remediation-no-change';
    return {
      kind: 'launch',
      step: noChange ? 'review' : cycle.step,
      parent: run,
      changes: {
        stepGuidance,
        stalledReviews: 0,
        reason: noChange
          ? 'A fresh review of the unchanged commit, with operator guidance; existing allowance retained.'
          : 'Continuing the current step with operator guidance; existing allowance retained.',
      },
      action: 'resume-with-guidance',
    };
  }
  if (guidance !== undefined || (cycle.step === 'review' && scope && scope.kind !== 'slice')) {
    if (
      cycle.step !== 'review' ||
      !scope ||
      scope.kind === 'slice' ||
      (run ? run.id !== cycle.currentRunId : facts.runCount() !== 0) ||
      facts.liveRuns().length > 0
    )
      return refuse(
        'review-guidance-invalid',
        'Review guidance requires an idle verification or parent-acceptance cycle with its current review run.',
      );
    // Reviewing the same integration snapshot again reproduces the same findings (CTRL-04,
    // cycle 10dbc912): a plain resume waits until the owning slice has changed it.
    const stop = effectiveCycleAttention(cycle)?.code;
    return {
      kind: 'review-scope',
      guidance: guidance?.trim() ?? '',
      snapshotCheck:
        guidance === undefined &&
        (stop === 'scope-review-recovery' || stop === 'scope-review-open-questions'),
    };
  }
  if (facts.liveRuns().some((candidate) => candidate.id !== run?.id))
    return refuse('sessions-open', 'End other open sessions before resuming automation');
  const step = decideRelaunch(cycle, facts, run);
  return { ...step, clearsEnding: true };
}

/** The resume of an idle step: adopt a newer manual run, relaunch, review or remediate. */
function decideRelaunch(
  cycle: WorkCycle,
  facts: CommandFacts,
  run: AgentRun | undefined,
): ResumeStep {
  // Manual work is adopted only by this explicit operator command. A manually completed
  // review is reviewed again because the controller did not record its starting commit.
  if (run && resumeAdopts(cycle, run)) {
    if (!facts.continuesLineage(run))
      return refuse(
        'outside-lineage',
        'The latest manual run does not continue this cycle’s handoff lineage. Continue from the cycle run, or stop this cycle before starting a new one.',
      );
    if (run.role === 'review' && isTerminalAgentRunStatus(run.status))
      return { kind: 'launch', step: 'review', parent: run };
    if (run.role === 'review')
      return refuse('manual-review-live', 'End the manual review before resuming automation');
    return {
      kind: 'write',
      changes: {
        status: 'running',
        step: run.role,
        currentRunId: run.id,
        runDeadlineAt: facts.deadline(),
        reason: 'Resumed with the latest manual run.',
        designWait: null,
      },
    };
  }
  if (!run || ['failed', 'cancelled', 'interrupted'].includes(run.status))
    return { kind: 'launch', step: cycle.step, parent: run };
  if (cycle.step === 'review' && run.status === 'finished') {
    // A plain resume at the round limit cannot start a round: it is refused toward the grant,
    // instead of recording the limit stop itself (R-B4, decision 14).
    if (resumeAtRoundLimit(cycle, run, facts))
      return refuse(
        'round-limit',
        'The remediation limit is reached, so a resume cannot start another round. Use Authorize more remediation.',
        { control: 'authorize-remediation' },
      );
    const scope = cycle.executionScope;
    if (
      !cycle.finalizationProgress &&
      (!scope || scope.kind === 'slice') &&
      facts.reviewAsksRemediation(run)
    )
      return { kind: 'remediate' };
    return { kind: 'launch', step: 'review', parent: run };
  }
  return {
    kind: 'write',
    changes: {
      status: 'running',
      runDeadlineAt: facts.deadline(),
      reason: 'Automation resumed by operator.',
      phaseWait: null,
    },
  };
}

/**
 * A plain resume of the cycle's finished review would need a remediation round its allowance has
 * spent (R-B4, decision 14). The command refuses it toward Authorize more remediation, and the
 * offer shows that control in place of Resume from this same rule (increment 6 review). A report
 * the worktree's scope rejects is not one: its resume reaches the review's own stop, as before.
 * Nor is a review whose turn failed or was clipped, which the grant refuses (NIT-4's turn half).
 */
export function resumeAtRoundLimit(
  cycle: WorkCycle,
  run: AgentRun | undefined,
  review: Pick<CommandFacts, 'reviewAsksRemediation' | 'reviewScopeIssue' | 'reviewTurnSucceeded'>,
): boolean {
  const scope = cycle.executionScope;
  return (
    // The grant asks for the cycle's own review: not a newer one a resume adopts, nor the parent
    // of one whose run was never created (increment 6 re-check, NIT-4).
    run?.id === cycle.currentRunId &&
    cycle.step === 'review' &&
    run.status === 'finished' &&
    !cycle.finalizationProgress &&
    (!scope || scope.kind === 'slice') &&
    remediationUsed(cycle) >= remediationAllowance(cycle) &&
    review.reviewTurnSucceeded(run) &&
    review.reviewAsksRemediation(run) &&
    !review.reviewScopeIssue(run)
  );
}

// ---------------------------------------------------------------------------------------------
// The writes the roadmap scheduler and start-up recovery make on a cycle, through the same core.
// Each keeps its own preconditions (today's checks in each path): `cycleActions` offers nothing
// on a completed cycle and only merge, pause and stop at the merge boundary, and the operator's
// offers do not change for them.

/** Nothing to write. */
export const NO_WRITE = { kind: 'none' } as const;

/** Puts a cycle back in the status (and stop) it had before an undone reservation. */
export function restoredStatus(cycle: WorkCycle): CycleChanges {
  if (cycle.status !== 'needs-attention' && cycle.status !== 'awaiting-merge')
    return { status: cycle.status };
  return {
    status: cycle.status,
    attention: effectiveCycleAttention(cycle) ?? cycleAttention('legacy-attention'),
  };
}

/** A roadmap's wind-down stops its cycle (R-B11), unless a merge or a resolution is its own. */
export function decideWindDownStop(
  cycle: WorkCycle,
  mergeReserved: boolean,
): CommandRefusal | CommandWrite | typeof NO_WRITE {
  if (['stopped', 'completed'].includes(cycle.status)) return NO_WRITE;
  if (mergeReserved)
    return refuse('merge-reserved', 'Recover the pending merge before stopping this cycle.');
  if (ownsIntegrationResolution(cycle))
    return refuse(
      'resolution-owned',
      'Abandon the integration resolution before stopping this cycle.',
    );
  return {
    kind: 'write',
    changes: { status: 'stopped', reason: 'Roadmap stopped. Manual flow is available.' },
    endTurn: true,
  };
}

/** A roadmap's refused merge that adopts changed check definitions becomes a person's (R-G13). */
export function decideLeaveMerge(
  cycle: WorkCycle,
  repositoryId: SourceRepositoryId,
  adoptsChecks: boolean,
): CommandWrite | typeof NO_WRITE {
  if (cycle.status !== 'awaiting-merge' || adoptsChecks) return NO_WRITE;
  return {
    kind: 'write',
    changes: {
      status: 'awaiting-merge',
      attention: cycleAttention('merge-approval', { repositoryId }),
      reason:
        'The slice changes adopted check definitions: approving its merge adopts them, so review them with the merge.',
    },
  };
}

/** The roadmap's fresh review for checks the last one skipped (LIVE-24): its reservation. */
export function decideDeclaredChecksReview(
  cycle: WorkCycle,
  facts: {
    readonly review: AgentRun | undefined;
    readonly alreadyAsked: boolean;
    readonly stopping: boolean;
    readonly live: boolean;
  },
): CommandWrite | typeof NO_WRITE {
  if (
    cycle.status !== 'awaiting-merge' ||
    cycle.step !== 'review' ||
    !facts.review?.reviewBranchContext?.headSha ||
    facts.alreadyAsked ||
    facts.stopping ||
    facts.live
  )
    return NO_WRITE;
  return {
    kind: 'write',
    changes: {
      status: 'running',
      reason: 'The last review did not run every adopted check; a fresh review runs them.',
    },
  };
}

/** The integration refresh's reservation, before it updates the worktree (R-C4). */
export function decideRefreshReservation(cycle: WorkCycle): CommandWrite {
  return {
    kind: 'write',
    changes: {
      status: 'running',
      integrationRefreshes: (cycle.integrationRefreshes ?? 0) + 1,
      reason: 'Updating from integration before a fresh review of the combined changes.',
    },
  };
}

/** Review again: an independent scope review that completed, awaits its merge, or never ran. */
export function decideReviewAgain(
  cycle: WorkCycle,
  facts: { readonly unstarted: boolean; readonly treeMatches: boolean },
): CommandRefusal | { readonly kind: 'review-again' } {
  if (
    (!['completed', 'awaiting-merge'].includes(cycle.status) && !facts.unstarted) ||
    cycle.step !== 'review' ||
    !cycle.workItemId ||
    !cycle.executionScope ||
    cycle.executionScope.kind === 'slice' ||
    !facts.treeMatches
  )
    return refuse(
      'not-reviewable',
      'Only a completed or unstarted independent scope review can be reviewed again.',
    );
  return { kind: 'review-again' };
}

/**
 * Start-up recovery: a baseline preparation the restart interrupted fails, and after a crash a
 * running cycle (one not waiting on its design's dependencies) waits for the operator.
 */
export function decideRestart(
  cycle: WorkCycle,
  cleanStop: boolean,
): { readonly baseline?: CommandWrite; readonly stop?: CommandWrite } {
  const baseline: CommandWrite | undefined =
    cycle.baselinePreparation?.status === 'preparing'
      ? {
          kind: 'write',
          changes: {
            baselinePreparation: {
              ...cycle.baselinePreparation,
              status: 'failed',
              message:
                'Preparation interrupted by restart. Inspect local tags and retry explicitly; existing tags will never be moved.',
            },
          },
        }
      : undefined;
  const stop: CommandWrite | undefined =
    cycle.status === 'running' && !cycle.designWait && !cleanStop
      ? {
          kind: 'write',
          changes: {
            status: 'needs-attention',
            attention: cycleAttention('restart-resume'),
            reason:
              'Daemon restarted. Inspect the interrupted step and resume explicitly; no process was relaunched.',
          },
        }
      : undefined;
  return { ...(baseline ? { baseline } : {}), ...(stop ? { stop } : {}) };
}
