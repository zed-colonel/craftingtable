import type { CycleDecision } from './machine.js';
import type { StepOutcomeDecision } from './step-outcome.js';

/**
 * Which lane a decision's application takes in the free-running controller (R-B5, decision 4):
 * `fast` writes and awaits nothing, so a round applies it at once; `slow` awaits I/O (Git, a
 * launch, a file) and runs as the slow lane's one job, so it never delays another cycle's
 * deadline, turn end or stop. Each table names every kind, so a new kind does not compile until
 * it is given a lane.
 */
export type Lane = 'fast' | 'slow';

const DECISION_LANES: Readonly<Record<Exclude<CycleDecision['kind'], 'outcome'>, Lane>> = {
  idle: 'fast',
  complete: 'fast',
  attention: 'fast',
  wait: 'fast',
  // `CycleWriter.next` reads Git for a review's head before it reserves.
  launch: 'slow',
  'start-run': 'slow',
  effect: 'slow',
};

const OUTCOME_LANES: Readonly<Record<StepOutcomeDecision['kind'], Lane>> = {
  'wait-for-run': 'fast',
  'end-turn': 'fast',
  attention: 'fast',
  'schedule-service-retry': 'fast',
  'continue-design': 'fast',
  'design-wait': 'fast',
  'resume-after-restart': 'slow',
  'repair-output': 'slow',
  'next-step': 'slow',
  'advance-resolution': 'slow',
  'finalize-implementation': 'slow',
  'advance-finalization-stage': 'slow',
  'remediate-review': 'slow',
  'approve-review': 'slow',
};

export function decisionLane(decision: CycleDecision): Lane {
  return decision.kind === 'outcome'
    ? OUTCOME_LANES[decision.outcome.kind]
    : DECISION_LANES[decision.kind];
}

/** The tables, for their completeness test. */
export const LANES = { decisions: DECISION_LANES, outcomes: OUTCOME_LANES } as const;
