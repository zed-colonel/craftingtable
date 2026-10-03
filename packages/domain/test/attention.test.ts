import { describe, expect, it } from 'vitest';
import {
  AWAITING_MERGE_GATES,
  CYCLE_ATTENTION,
  cycleAttention,
  PHASE_BLOCKERS,
  SETUP_BLOCKER_CODES,
} from '../src/attention.js';
import {
  effectiveCycleAttention,
  effectiveHoldAttention,
  effectiveRoadmapAttention,
  phaseBlockerCode,
  phaseBlockerResourceKey,
} from '../src/attention-legacy.js';
import type { PhaseBlocker } from '../src/phase-scheduling.js';
import type { WorkCycle } from '../src/work-cycle.js';

const stopped = (status: WorkCycle['status'], reason: string, extra: Partial<WorkCycle> = {}) =>
  ({ status, reason, ...extra }) as WorkCycle;

describe('typed attention (R-A3)', () => {
  it('derives the owner from the code, or the controller while automation claims the stop', () => {
    expect(cycleAttention('merge-approval')).toEqual({ code: 'merge-approval', owner: 'operator' });
    expect(cycleAttention('controller-wait').owner).toBe('controller');
    expect(cycleAttention('merge-approval', undefined, { claim: 'roadmap-merge' })).toEqual({
      code: 'merge-approval',
      owner: 'controller',
      claim: 'roadmap-merge',
    });
    for (const gate of AWAITING_MERGE_GATES) expect(CYCLE_ATTENTION[gate]).toBeDefined();
  });

  it('prefers declared attention and has none outside the stop statuses', () => {
    const declared = cycleAttention('step-time-limit');
    expect(
      effectiveCycleAttention(
        stopped('needs-attention', 'Daemon restarted.', { attention: declared }),
      ),
    ).toBe(declared);
    expect(effectiveCycleAttention(stopped('running', 'Daemon restarted.'))).toBeUndefined();
    expect(
      effectiveCycleAttention(stopped('paused', 'Remediation limit reached.')),
    ).toBeUndefined();
  });

  it.each([
    ['Daemon restarted. Inspect the interrupted step.', 'restart-resume'],
    [
      'Remediation limit reached. Review needs your input. Answer…',
      'review-open-questions-at-limit',
    ],
    ['Remediation limit reached. Review requires remediation: 1 minor.', 'remediation-exhausted'],
    ['Two remediation rounds left the same open findings.', 'remediation-stalled'],
    [
      'Implementation needs your input. Answer the Open questions.',
      'implementation-open-questions',
    ],
    ['Review needs your input. Answer the Open questions.', 'review-open-questions'],
    ['Workflow report needs correction. The controller…', 'workflow-report-invalid'],
    ['Workflow report and Open questions disagree. Inspect…', 'workflow-questions-disagree'],
    ['Operator decision required. Open Shared architecture decisions.', 'shared-decision-required'],
    ['Operator input required. Answer the work-item questions.', 'work-item-questions'],
    ['Scope review requires recovery: Review requires remediation.', 'scope-review-recovery'],
    ['Something an older release said.', 'legacy-attention'],
  ] as const)('maps the older needs-attention reason %j to %s', (reason, code) => {
    expect(effectiveCycleAttention(stopped('needs-attention', reason))?.code).toBe(code);
  });

  it('recovers the awaiting-merge gate of an older record from its shape', () => {
    const gate = (extra: Partial<WorkCycle>, reason = 'Review meets the completion policy.') =>
      effectiveCycleAttention(stopped('awaiting-merge', reason, extra))?.code;
    expect(gate({})).toBe('merge-approval');
    expect(gate({ finalizationId: 'final-1' })).toBe('final-promotion');
    expect(
      gate({
        executionScope: {
          kind: 'parent-acceptance',
          definitionId: 'd',
          bindingRevision: 1,
          sourceId: 'P',
        },
      } as Partial<WorkCycle>),
    ).toBe('record-scope-evidence');
    expect(gate({ workflow: { reassessments: 0, questions: [], waiting: 'WI-1: waiting.' } })).toBe(
      'controller-wait',
    );
    expect(
      gate({}, 'Technical review finished. Further controller reviews are held until resume.'),
    ).toBe('scheduling-held');
  });

  it('recovers roadmap and hold attention for older records', () => {
    expect(
      effectiveRoadmapAttention({ status: 'needs-attention', reason: 'Daemon restarted.' })?.code,
    ).toBe('restart-resume');
    expect(effectiveRoadmapAttention({ status: 'running', reason: 'Daemon restarted.' })).toBe(
      undefined,
    );
    expect(effectiveHoldAttention({ status: 'needs-attention', reason: 'x' })?.code).toBe(
      'legacy-attention',
    );
    expect(effectiveHoldAttention({ status: 'paused', reason: 'x' })).toBeUndefined();
  });

  it('classifies phase blockers by code, recovering codes for blockers stored before them', () => {
    const legacy = (kind: PhaseBlocker['kind'], message: string) =>
      phaseBlockerCode({ kind, message });
    expect(legacy('authorization', 'Resource controlled-native-test-host needs approval.')).toBe(
      'environment-approval',
    );
    expect(legacy('authorization', 'Resource gpu-host has no managed execution adapter.')).toBe(
      'resource-unsupported',
    );
    expect(legacy('evidence', 'Checkpoint C-1 must pass.')).toBe('checkpoint-evidence');
    expect(legacy('evidence', 'Required slice S-1 has not merged.')).toBe(
      'required-slice-unmerged',
    );
    expect(legacy('evidence', 'Required slice S-1 has not been verified.')).toBe(
      'required-slice-unverified',
    );
    expect(legacy('review', 'Evidence profile needs reviewers.')).toBe('reviewer-assignment');
    expect(
      phaseBlockerCode({ kind: 'evidence', code: 'decision-checkpoint-evidence', message: 'x' }),
    ).toBe('decision-checkpoint-evidence');
    expect(
      phaseBlockerResourceKey({
        kind: 'resource',
        message: 'Waiting for local-verification: 1/1 reservations occupied.',
      }),
    ).toBe('local-verification');
    expect(
      phaseBlockerResourceKey({
        kind: 'resource',
        code: 'resource-busy',
        refs: { resourceKey: 'local-development' },
        message: 'Waiting.',
      }),
    ).toBe('local-development');
  });

  it('keeps the controller waiting for exactly the blockers it waited for by kind before', () => {
    // Before R-A3: waiting unless a blocker was authorization or review, except the
    // authorization blockers whose message started with "Resource ".
    for (const [code, { waits }] of Object.entries(PHASE_BLOCKERS)) {
      if (['scheduling-held', 'legacy-blocker'].includes(code)) continue;
      const operatorSetup =
        SETUP_BLOCKER_CODES.has(code as never) && code !== 'reviewer-assignment';
      const authorizationOrReview = [
        'binding-changed',
        'plan-inactive',
        'repository-unavailable',
        'binding-retired',
        'amendment-pending',
        'runtime-definition-unavailable',
        'binding-superseded',
        'decision-adoption-required',
        'merge-resource-mismatch',
        'reviewer-assignment',
      ].includes(code);
      expect([code, waits]).toEqual([code, operatorSetup || !authorizationOrReview]);
    }
  });
});
