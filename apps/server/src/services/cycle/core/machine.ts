import { parseWorkflowReport } from '@craftingtable/contracts';
import {
  type AgentRun,
  type AttentionRefs,
  type CycleAttentionCode,
  type CycleStep,
  effectiveCycleAttention,
  ownsIntegrationResolution,
  PHASE_BLOCKERS,
  type PhaseBlocker,
  phaseBlockerCode,
  type WorkCycle,
  type Worktree,
} from '@craftingtable/domain';
import type { Readiness } from './effect-decisions.js';
import type { CycleFacts, KernelFacts } from './facts.js';
import { investigationLive, worktreeChangeOpen } from '../../investigation.js';
import { decideStepOutcome, type StepOutcomeDecision } from './step-outcome.js';

/**
 * The cycle controller's decision core (R-B4).
 *
 * `decide(cycle, facts, kernel, now)` is what `reconcile` used to work out inline: the first of
 * the ordered, named guards (`CYCLE_GUARDS`) that has something to say about the cycle decides,
 * and `reconcile` applies the decision (a write, a launch, or an effect that does I/O and then
 * decides again with a small pure function). The guards keep `reconcile`'s order and outcomes;
 * that order is the precedence between them.
 *
 * `decide` writes nothing and awaits nothing. It reads the cycle's stored facts through
 * `CycleFacts`, lazily, and the daemon's process-local state through `KernelFacts`. A gate's
 * refusal reaches it as a typed result (`CycleFacts.readiness`), never as a throw (R-B4,
 * decision 3); a fact that throws anyway is an unexpected exception, the pass's to stop on.
 */

export const CYCLE_GUARDS = [
  // A roadmap being settled holds its cycles: its settle stops them (R-B11, ADR-073). First,
  // since the settle ends investigations itself.
  'roadmap-settling',
  // A live investigation holds the stop until it is read back (R-C16).
  'investigation-live',
  // So does a worktree change it found, until acknowledged or undone (R-C16).
  'worktree-change-open',
  // This process is refreshing the cycle from integration, or cleaning a run of its worktree.
  'kernel-busy',
  // A merged worktree, or a scope review whose evidence is recorded, ends the cycle.
  'integrated',
  // ADR-063: a stop on shared decisions whose checkpoints are now accepted is reassessed.
  'shared-decision-reassessment',
  // ADR-063: a question or report stop a delegated reviewer can classify is reassessed.
  'reassessable-stop',
  // Only `running` and `awaiting-merge` cycles are driven.
  'not-active',
  'worktree-inactive',
  'authority-lost',
  // An `awaiting-merge` cycle that only the operator can advance waits for the operator (R-B1).
  'operator-merge-only',
  // The work item's admission and predecessors, or the finalization's activity.
  'item-ready',
  'merge-reserved',
  // `awaiting-merge`: the workflow's reviews, then a refresh from integration.
  'merge-boundary',
  // A controller review reserved while scheduling is held waits for it.
  'controller-review-held',
  'scope-phase-gates',
  'design-dependencies',
  'phase-wait-cleared',
  'step-deadline',
  'provider-retry-due',
  'provider-retry-held',
  'integration-resolution',
  // A step reserved but not launched: a review refreshes from integration first.
  'no-run',
  // The current run's outcome (`decideStepOutcome`, with its own ordered checks).
  'step-outcome',
] as const;
export type CycleGuard = (typeof CYCLE_GUARDS)[number];

/** Effects `reconcile` runs for a decision: I/O, then a small pure decision on its result. */
export type CycleEffect =
  | { readonly name: 'settle-investigation' }
  | { readonly name: 'check-worktree-restored' }
  | { readonly name: 'reassess'; readonly source: AgentRun }
  | { readonly name: 'merge-boundary'; readonly review: AgentRun | undefined }
  | { readonly name: 'advance-resolution' };

/** A controller-owned phase wait to record or refresh, or to clear once its gates are met. */
export type CycleWait =
  | {
      readonly change: 'record-phase';
      readonly blockers: readonly PhaseBlocker[];
      readonly reason: string;
    }
  | { readonly change: 'clear-phase'; readonly runDeadlineAt: string; readonly reason: string };

/** Why a guard left the cycle as it is. */
export const IDLE_REASONS = [
  'settling',
  'busy',
  'reassessment-not-ready',
  'not-reassessable',
  'not-active',
  'operator-merge-only',
  'merge-reserved',
  'dependencies-pending',
  'roadmap-paused',
  'retry-not-due',
  'retry-held',
  'draining',
] as const;
export type IdleReason = (typeof IDLE_REASONS)[number];

/** The controller-owned waits a guard records or clears. */
export const WAIT_CHANGES = [
  'record-phase',
  'clear-phase',
] as const satisfies readonly CycleWait['change'][];

export type CycleDecisionBody =
  | {
      readonly kind: 'idle';
      readonly reason: IdleReason;
      /** When the cycle next needs a look by itself, where a time says so. */
      readonly dueAt?: string;
    }
  | {
      readonly kind: 'complete';
      readonly code: 'integrated' | 'scope-evidence-recorded';
      readonly reason: string;
    }
  | { readonly kind: 'wait'; readonly wait: CycleWait }
  | {
      readonly kind: 'attention';
      readonly code: CycleAttentionCode;
      readonly message: string;
      readonly refs?: AttentionRefs;
      /** The live turn is cancelled before the stop is written. */
      readonly endTurn?: boolean;
    }
  | {
      readonly kind: 'launch';
      readonly step: CycleStep;
      readonly parent: AgentRun | undefined;
      readonly changes: Omit<Partial<WorkCycle>, 'status' | 'attention'>;
      readonly action?: string;
    }
  | {
      readonly kind: 'start-run';
      /** A review refreshes from integration before it launches. */
      readonly refreshFirst: boolean;
      readonly parent: AgentRun | undefined;
    }
  | { readonly kind: 'effect'; readonly effect: CycleEffect }
  | {
      readonly kind: 'outcome';
      readonly run: AgentRun;
      readonly worktree: Worktree | undefined;
      readonly outcome: StepOutcomeDecision;
    };
export type CycleDecision = CycleDecisionBody & { readonly guard: CycleGuard };

/**
 * The stops the guards write themselves; the step outcome's are `STEP_ATTENTION_CODES` and the
 * effects' are their sub-decisions' (`effect-decisions.ts`). The item gate's and the finalization's
 * refusals are typed (R-B4, decision 3), so no guard writes `controller-error`.
 */
export const GUARD_CODES: readonly CycleAttentionCode[] = [
  'worktree-inactive',
  'authority-lost',
  'phase-gate',
  'item-unavailable',
  'item-not-admitted',
  'item-completed-unmerged',
  'predecessors-incomplete',
  'finalization-inactive',
  'design-dependency-unsupported',
  'design-recheck-unavailable',
  'design-dependency-continuations-exhausted',
  'step-time-limit',
  'service-retry-mismatch',
];

/** Stops a delegated reviewer can classify again (ADR-063). */
export const REASSESSABLE_STOPS: ReadonlySet<CycleAttentionCode> = new Set<CycleAttentionCode>([
  'implementation-open-questions',
  'review-open-questions',
  'review-open-questions-at-limit',
  'workflow-report-invalid',
  'workflow-questions-disagree',
  'finalization-needs-input',
]);

/** The blocker a held controller review records as its phase wait. */
export const SCHEDULING_HELD_BLOCKER: PhaseBlocker = {
  kind: 'authorization',
  code: 'scheduling-held',
  message: 'Roadmap scheduling or this entry is paused.',
};

interface GuardInput {
  readonly cycle: WorkCycle;
  readonly facts: CycleFacts;
  readonly kernel: KernelFacts;
  readonly now: Date;
}
type Guard = (input: GuardInput) => CycleDecisionBody | undefined;

const idle = (reason: IdleReason, dueAt?: string): CycleDecisionBody => ({
  kind: 'idle',
  reason,
  ...(dueAt ? { dueAt } : {}),
});
const attention = (
  code: CycleAttentionCode,
  message: string,
  endTurn = false,
  refs?: AttentionRefs,
): CycleDecisionBody => ({
  kind: 'attention',
  code,
  message,
  ...(refs ? { refs } : {}),
  ...(endTurn ? { endTurn } : {}),
});

/** A gate's readiness as a decision: nothing when ready, else its phase wait or its stop. */
function readinessDecision(readiness: Readiness): CycleDecisionBody | undefined {
  switch (readiness.kind) {
    case 'ready':
      return undefined;
    case 'wait':
      return {
        kind: 'wait',
        wait: { change: 'record-phase', blockers: readiness.blockers, reason: readiness.reason },
      };
    case 'refused':
      return attention(readiness.code, readiness.message, false, readiness.refs);
  }
}
const effect = (value: CycleEffect): CycleDecisionBody => ({ kind: 'effect', effect: value });

const GUARDS: Record<CycleGuard, Guard> = {
  'roadmap-settling': ({ facts }) => (facts.settling() ? idle('settling') : undefined),
  'investigation-live': ({ cycle }) =>
    investigationLive(cycle) ? effect({ name: 'settle-investigation' }) : undefined,
  'worktree-change-open': ({ cycle }) =>
    worktreeChangeOpen(cycle) ? effect({ name: 'check-worktree-restored' }) : undefined,
  'kernel-busy': ({ kernel }) =>
    kernel.refreshing() || kernel.cleaningRun() ? idle('busy') : undefined,
  integrated: ({ facts }) => {
    const merged = facts.worktree()?.mergedAt !== undefined;
    const recorded = facts.scopeEvidenceRecorded();
    if (!merged && !recorded) return undefined;
    return recorded
      ? {
          kind: 'complete',
          code: 'scope-evidence-recorded',
          reason: 'Independent scope evidence recorded; review cycle complete.',
        }
      : { kind: 'complete', code: 'integrated', reason: 'Worktree integrated; cycle complete.' };
  },
  'shared-decision-reassessment': ({ cycle, facts }) => {
    if (
      cycle.status !== 'needs-attention' ||
      !cycle.workflow?.questions.length ||
      !cycle.workflow.questions.every((q) => q.destination === 'shared-decision') ||
      !facts.delegationRunnable() ||
      cycle.workflow.reassessments >= 2 ||
      !facts.sharedDecisionsAccepted()
    )
      return undefined;
    const source = facts.currentRun();
    return source?.status === 'finished'
      ? effect({ name: 'reassess', source })
      : idle('reassessment-not-ready');
  },
  'reassessable-stop': ({ cycle, facts }) => {
    if (
      cycle.status !== 'needs-attention' ||
      cycle.executionScope?.kind !== 'slice' ||
      !['implement', 'review', 'remediate'].includes(cycle.step) ||
      !REASSESSABLE_STOPS.has(effectiveCycleAttention(cycle)?.code ?? 'legacy-attention') ||
      ownsIntegrationResolution(cycle)
    )
      return undefined;
    const prior = facts.currentRun();
    const turn = prior && facts.lastTurn(prior);
    return prior?.status === 'finished' &&
      turn !== undefined &&
      !turn.payload.truncated &&
      parseWorkflowReport(turn.payload.resultText).status !== 'complete' &&
      facts.delegationRunnable() === true &&
      (cycle.workflow?.reassessments ?? 0) < 2
      ? effect({ name: 'reassess', source: prior })
      : idle('not-reassessable');
  },
  'not-active': ({ cycle }) =>
    ['running', 'awaiting-merge'].includes(cycle.status) ? undefined : idle('not-active'),
  'worktree-inactive': ({ facts }) =>
    facts.worktree()?.status !== 'active'
      ? attention('worktree-inactive', 'Worktree is no longer active.')
      : undefined,
  'authority-lost': ({ facts }) =>
    facts.creatorAuthorized()
      ? undefined
      : attention(
          'authority-lost',
          'The initiating user no longer has permission to run this cycle.',
          true,
        ),
  'operator-merge-only': ({ cycle, facts }) => {
    // Its gate evaluation and projections are the idle controller's main cost, and cannot
    // change what happens next: the operator's merge evaluates its own gate. Only the item's own
    // status, one read, is asked first: an item withdrawn under the merge is the cycle's stop
    // (`item-ready`). One completed by hand keeps the merge, which reconciles it, as the exit;
    // the merge command does not read the item (R-B4, decision 2; increment 5 review).
    if (cycle.status !== 'awaiting-merge') return undefined;
    const refused = facts.itemRefusal();
    return (!refused || refused === 'item-completed-unmerged') && facts.onlyOperatorCanAdvance()
      ? idle('operator-merge-only')
      : undefined;
  },
  'item-ready': ({ cycle, facts }) =>
    // A changed admission gate must not prevent supervision, cancellation or deadline
    // enforcement for a scoped process already launched: it is checked again before the next
    // launch or merge.
    cycle.workItemId &&
    cycle.executionScope &&
    cycle.status !== 'awaiting-merge' &&
    facts.currentRun()
      ? undefined
      : readinessDecision(facts.readiness()),
  'merge-reserved': ({ facts }) => (facts.mergeReserved() ? idle('merge-reserved') : undefined),
  'merge-boundary': ({ cycle, facts }) =>
    cycle.status === 'awaiting-merge'
      ? effect({ name: 'merge-boundary', review: facts.currentRun() })
      : undefined,
  'controller-review-held': ({ cycle, facts }) =>
    !facts.currentRun() && cycle.workflow?.activeReview && !facts.controllerReviewRunnable()
      ? {
          kind: 'wait',
          wait: {
            change: 'record-phase',
            blockers: [SCHEDULING_HELD_BLOCKER],
            reason: 'Controller review reserved; waiting for scheduling to resume.',
          },
        }
      : undefined,
  'scope-phase-gates': ({ facts }) => {
    if (facts.currentRun()) return undefined;
    const blockers = facts.phaseBlockers();
    if (!blockers.length) return undefined;
    // Every blocker's message, as the scope's phase gate says them (`PhaseGateError`).
    const message = blockers.map((b) => b.message).join('\n');
    return blockers.every((b) => PHASE_BLOCKERS[phaseBlockerCode(b)].waits)
      ? { kind: 'wait', wait: { change: 'record-phase', blockers, reason: message } }
      : attention('phase-gate', message, false, {
          blockers: [...new Set(blockers.map(phaseBlockerCode))],
        });
  },
  'design-dependencies': ({ cycle, facts }) => {
    if (!cycle.designWait) return undefined;
    const state = facts.designDependencies(cycle.designWait.requirements);
    if (!state.supported)
      return attention('design-dependency-unsupported', state.pending.join(' '));
    if (state.pending.length) return idle('dependencies-pending');
    if (facts.roadmapPaused()) return idle('roadmap-paused');
    const parent = facts.currentRun();
    if (parent?.status !== 'finished')
      return attention(
        'design-recheck-unavailable',
        'Inspect the completed design before continuing.',
      );
    if ((cycle.designDependencyContinuations ?? 0) >= 2)
      return attention(
        'design-dependency-continuations-exhausted',
        'Two automatic dependency continuations have been used. Review the latest design and authorize recovery.',
      );
    return {
      kind: 'launch',
      step: 'design',
      parent,
      changes: {
        designWait: null,
        phaseWait: null,
        designDependencyContinuations: (cycle.designDependencyContinuations ?? 0) + 1,
        reason: 'Mapped predecessors are ready. Rechecking the design with current evidence.',
      },
    };
  },
  'phase-wait-cleared': ({ cycle, facts, now }) => {
    if (!cycle.phaseWait) return undefined;
    // The step's time limit moves by the time it spent waiting, unless it had already run.
    const delay =
      !facts.currentRun() && !cycle.providerRecovery
        ? now.getTime() - Date.parse(cycle.phaseWait.startedAt)
        : 0;
    return {
      kind: 'wait',
      wait: {
        change: 'clear-phase',
        runDeadlineAt: new Date(Date.parse(cycle.runDeadlineAt) + Math.max(0, delay)).toISOString(),
        reason: `Starting ${cycle.step} after phase requirements cleared.`,
      },
    };
  },
  'step-deadline': ({ cycle, now }) =>
    now.getTime() >= Date.parse(cycle.runDeadlineAt)
      ? attention(
          'step-time-limit',
          'Step time limit reached. The current process was cancelled; inspect it before resuming.',
          true,
        )
      : undefined,
  'provider-retry-due': ({ cycle, facts, now }) => {
    const recovery = cycle.providerRecovery;
    if (!recovery?.nextRetryAt) return undefined;
    if (facts.roadmapPaused()) return idle('retry-held');
    if (now.getTime() < Date.parse(recovery.nextRetryAt))
      return idle('retry-not-due', recovery.nextRetryAt);
    const parent = facts.currentRun();
    // A run that finished is retried only for the outage its last turn reported (R-C11).
    const lastTurn = parent?.status === 'finished' ? facts.lastTurn(parent) : undefined;
    if (
      !parent ||
      parent.id !== recovery.sourceRunId ||
      (parent.status !== 'failed' && !lastTurn?.payload.suspectedOutage) ||
      facts.newestRun()?.id !== parent.id
    )
      return attention(
        'service-retry-mismatch',
        'Provider recovery no longer matches the latest failed run. Inspect the worktree before resuming.',
      );
    if (cycle.workItemId) {
      const blocked = readinessDecision(facts.readiness());
      if (blocked) return blocked;
    }
    const { nextRetryAt: _due, ...pending } = recovery;
    return {
      kind: 'launch',
      step: cycle.step,
      parent,
      changes: {
        providerRecovery: { ...pending, attempts: pending.attempts + 1 },
        runDeadlineAt: cycle.runDeadlineAt,
        resultContinuations: cycle.resultContinuations ?? 0,
        instructions: cycle.instructions,
        housekeepingInstructions: cycle.housekeepingInstructions,
        reason: `Starting service retry ${pending.attempts + 1} of 3 on the same backend/model; no remediation round consumed.`,
      },
      action: 'retry-provider',
    };
  },
  'provider-retry-held': ({ cycle, facts }) =>
    cycle.providerRecovery && !facts.currentRun() && facts.roadmapPaused()
      ? idle('retry-held')
      : undefined,
  'integration-resolution': ({ cycle }) =>
    ownsIntegrationResolution(cycle) && cycle.integrationResolution?.status !== 'resolving'
      ? effect({ name: 'advance-resolution' })
      : undefined,
  'no-run': ({ cycle, facts, kernel }) => {
    if (facts.currentRun()) return undefined;
    if (cycle.step === 'review')
      return { kind: 'start-run', refreshFirst: true, parent: facts.parentRun() };
    // A drain admits no launches; the reservation survives the restart and launches then.
    if (kernel.draining()) return idle('draining');
    return { kind: 'start-run', refreshFirst: false, parent: undefined };
  },
  'step-outcome': ({ cycle, facts }) => {
    const run = facts.currentRun();
    if (!run) return undefined;
    return {
      kind: 'outcome',
      run,
      worktree: facts.worktree(),
      outcome: decideStepOutcome(cycle, facts.stepOutcome(run)),
    };
  },
};

/**
 * Whether one guard would decide this input on its own, whatever the guards before it say: the
 * precedence check combines two guards' inputs and needs to know that both still apply.
 */
export function guardApplies(
  guard: CycleGuard,
  cycle: WorkCycle,
  facts: CycleFacts,
  kernel: KernelFacts,
  now: Date,
): boolean {
  return GUARDS[guard]({ cycle, facts, kernel, now }) !== undefined;
}

/**
 * The first guard with something to say decides. `onGuard` is told each guard as it is asked,
 * so a caller can name the guard a throwing gate belongs to.
 */
export function decide(
  cycle: WorkCycle,
  facts: CycleFacts,
  kernel: KernelFacts,
  now: Date,
  onGuard?: (guard: CycleGuard) => void,
): CycleDecision {
  const input = { cycle, facts, kernel, now };
  for (const guard of CYCLE_GUARDS) {
    onGuard?.(guard);
    const decision = GUARDS[guard](input);
    if (decision) return { ...decision, guard };
  }
  // The step-outcome guard decides whenever a run exists, and no-run whenever none does.
  throw new Error('No cycle guard decided.');
}

/** A decision as a replay records it: what kind, which guard, and the code or name it carries. */
export function decisionSummary(decision: CycleDecision): {
  readonly kind: string;
  readonly guard: CycleGuard;
  readonly code?: string;
} {
  const { guard } = decision;
  switch (decision.kind) {
    case 'idle':
      return { kind: 'idle', guard, code: decision.reason };
    case 'complete':
    case 'attention':
      return { kind: decision.kind, guard, code: decision.code };
    case 'wait':
      return { kind: 'wait', guard, code: decision.wait.change };
    case 'launch':
      return { kind: 'launch', guard, code: decision.step };
    case 'start-run':
      return {
        kind: 'start-run',
        guard,
        ...(decision.refreshFirst ? { code: 'refresh-first' } : {}),
      };
    case 'effect':
      return { kind: 'effect', guard, code: decision.effect.name };
    case 'outcome':
      return { ...outcomeSummary(decision.outcome), guard };
  }
}

/** A step outcome (R-B2's vocabulary) in the core's kinds. */
function outcomeSummary(outcome: StepOutcomeDecision): {
  readonly kind: string;
  readonly code: string;
} {
  switch (outcome.kind) {
    case 'wait-for-run':
      return { kind: 'idle', code: 'run-live' };
    case 'attention':
      return { kind: 'attention', code: outcome.code };
    case 'schedule-service-retry':
      return { kind: 'wait', code: 'service-retry' };
    case 'design-wait':
      return { kind: 'wait', code: 'design' };
    case 'next-step':
      return { kind: 'launch', code: outcome.step };
    default:
      return { kind: 'effect', code: outcome.kind };
  }
}
