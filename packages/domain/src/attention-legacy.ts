import {
  type CycleAttention,
  type CycleAttentionCode,
  cycleAttention,
  type PhaseBlockerCode,
  type RoadmapAttention,
  roadmapAttention,
} from './attention.js';
import type { PhaseBlocker } from './phase-scheduling.js';
import type { Roadmap, RoadmapEntryHold } from './roadmap.js';
import type { WorkCycle } from './work-cycle.js';

/**
 * Attention for records written before codes existed (R-A3).
 *
 * This module is the single place that may read the old human-readable reason text, and
 * only to recover a code for a record that has none. Every new write declares its code;
 * every consumer calls these functions instead of looking at text. The prefixes are the
 * exact messages earlier releases wrote.
 */

const LEGACY_CYCLE_REASONS: readonly (readonly [string, CycleAttentionCode])[] = [
  ['Daemon restarted.', 'restart-resume'],
  ['Remediation limit reached. Review needs your input.', 'review-open-questions-at-limit'],
  ['Remediation limit reached.', 'remediation-exhausted'],
  ['Two remediation rounds', 'remediation-stalled'],
  ['Implementation needs your input.', 'implementation-open-questions'],
  ['Review needs your input.', 'review-open-questions'],
  ['Workflow report needs correction.', 'workflow-report-invalid'],
  ['Workflow report and Open questions disagree.', 'workflow-questions-disagree'],
  ['Operator decision required.', 'shared-decision-required'],
  ['Operator input required.', 'work-item-questions'],
  ['Finalization needs your input', 'finalization-needs-input'],
  ['Design has open questions', 'design-open-questions'],
  ['Design needs an operator decision.', 'design-decision-required'],
  ['Design identified a planning conflict.', 'design-planning-conflict'],
  ['Design investigation finished.', 'design-investigation-finished'],
  ['Scope review requires recovery:', 'scope-review-recovery'],
  ['Scope review has open questions', 'scope-review-open-questions'],
  ['The step did not finish with a complete successful result.', 'step-incomplete'],
  ['Step time limit reached.', 'step-time-limit'],
  ['Integration refresh limit reached.', 'integration-refresh-limit'],
];

/** The stop a cycle is at: its declared attention, or one recovered for an older record. */
export function effectiveCycleAttention(
  cycle: Pick<
    WorkCycle,
    'status' | 'reason' | 'attention' | 'workflow' | 'executionScope' | 'finalizationId'
  >,
): CycleAttention | undefined {
  if (cycle.status !== 'needs-attention' && cycle.status !== 'awaiting-merge') return undefined;
  if (cycle.attention) return cycle.attention;
  if (cycle.status === 'awaiting-merge') {
    if (cycle.workflow?.waiting) return cycleAttention('controller-wait');
    if (cycle.reason.startsWith('Technical review finished. Further controller reviews are held'))
      return cycleAttention('scheduling-held');
    if (cycle.executionScope && cycle.executionScope.kind !== 'slice')
      return cycleAttention('record-scope-evidence');
    return cycleAttention(cycle.finalizationId ? 'final-promotion' : 'merge-approval');
  }
  const match = LEGACY_CYCLE_REASONS.find(([prefix]) => cycle.reason.startsWith(prefix));
  return cycleAttention(match?.[1] ?? 'legacy-attention');
}

export function effectiveRoadmapAttention(
  roadmap: Pick<Roadmap, 'status' | 'reason' | 'attention'>,
): RoadmapAttention | undefined {
  if (roadmap.status !== 'needs-attention') return undefined;
  if (roadmap.attention) return roadmap.attention;
  return roadmapAttention(
    roadmap.reason.startsWith('Daemon restarted.') ? 'restart-resume' : 'legacy-attention',
  );
}

export function effectiveHoldAttention(hold: RoadmapEntryHold): RoadmapAttention | undefined {
  if (hold.status !== 'needs-attention') return undefined;
  return hold.attention ?? roadmapAttention('legacy-attention');
}

/** The resource a `resource-busy` blocker waits for, also for blockers stored before refs. */
export function phaseBlockerResourceKey(blocker: PhaseBlocker): string | undefined {
  if (blocker.refs?.resourceKey) return blocker.refs.resourceKey;
  if (phaseBlockerCode(blocker) !== 'resource-busy') return undefined;
  return /^Waiting for (\S+):/.exec(blocker.message)?.[1];
}

/** A phase blocker's code, recovering one for a blocker stored before codes existed. */
export function phaseBlockerCode(blocker: PhaseBlocker): PhaseBlockerCode {
  if (blocker.code) return blocker.code;
  const { kind, message } = blocker;
  if (kind === 'authorization' && message.startsWith('Resource controlled-native-test-host'))
    return 'environment-approval';
  if (kind === 'authorization' && message.startsWith('Resource ')) return 'resource-unsupported';
  if (kind === 'evidence' && message.startsWith('Checkpoint ')) return 'checkpoint-evidence';
  if (kind === 'evidence' && message.startsWith('Required slice '))
    return message.endsWith('has not merged.')
      ? 'required-slice-unmerged'
      : 'required-slice-unverified';
  if (kind === 'evidence') return 'staged-approval-prerequisite';
  if (kind === 'dependency') return 'slice-requirement';
  if (kind === 'resource') return 'resource-busy';
  if (kind === 'review') return 'reviewer-assignment';
  return 'legacy-blocker';
}
