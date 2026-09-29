import { describe, expect, it } from 'vitest';
import { cycleAttention } from './attention.js';
import { cycleActions, resumeRedirect } from './cycle-actions.js';
import type { WorkCycle } from './work-cycle.js';

const cycle = (status: WorkCycle['status'], code?: Parameters<typeof cycleAttention>[0]) =>
  ({ status, reason: '', ...(code ? { attention: cycleAttention(code) } : {}) }) as WorkCycle;

describe('cycle actions (R-A7)', () => {
  it('offers resume only for stops a resume can move', () => {
    for (const code of [
      'restart-resume',
      'step-incomplete',
      'step-time-limit',
      'controller-error',
      'upstream-transition-undeclared',
      'service-retries-exhausted',
      'review-baseline-changed',
      'shared-decision-required',
      'scope-review-recovery',
      'workflow-obligation',
    ] as const)
      expect(cycleActions(cycle('needs-attention', code))).toEqual(['resume', 'stop']);
    expect(cycleActions(cycle('paused'))).toEqual(['resume', 'stop']);
    expect(cycleActions(cycle('running'))).toEqual(['pause', 'stop']);
  });

  it('offers the shared decisions, not a resume, while a stop still waits on them (LIVE-18)', () => {
    const waiting = (status: WorkCycle['status']) =>
      ({
        ...cycle(status, 'shared-decision-required'),
        unsettledDecisions: ['EXO-ADR-022', 'EXO-ADR-030'],
      }) as WorkCycle;
    expect(cycleActions(waiting('needs-attention'))).toEqual(['open-shared-decisions', 'stop']);
    expect(cycleActions(waiting('paused'))).toEqual(['open-shared-decisions', 'stop']);
    // Once every decision is settled the stop resumes as before.
    expect(cycleActions(cycle('needs-attention', 'shared-decision-required'))).toEqual([
      'resume',
      'stop',
    ]);
  });

  it.each([
    ['design-report-invalid', 'resolve-design'],
    ['design-open-questions', 'resolve-design'],
    ['implementation-open-questions', 'continue-with-guidance'],
    ['remediation-exhausted', 'authorize-remediation'],
    ['review-open-questions-at-limit', 'authorize-remediation'],
    ['integration-conflict', 'resolve-integration'],
    ['checkpoint-attestation-failed', 'continue-with-guidance'],
  ] as const)('sends %s to %s instead of a resume', (code, action) => {
    expect(cycleActions(cycle('needs-attention', code))).toEqual([action, 'stop']);
    expect(resumeRedirect(cycle('needs-attention', code))?.message).toBeTruthy();
    // A pause taken at the stop keeps it: resume is offered, and returns to the stop.
    expect(cycleActions(cycle('paused', code))).toEqual(['resume', 'stop']);
    expect(resumeRedirect(cycle('paused', code))?.action).toBe(action);
  });

  it('lets a resume adopt a newer manual run whatever the stop', () => {
    const stopped = {
      ...cycle('needs-attention', 'design-open-questions'),
      currentRunId: 'r1',
    } as WorkCycle;
    expect(cycleActions(stopped, 'r1')).toEqual(['resolve-design', 'stop']);
    expect(cycleActions(stopped, 'manual-r2')).toEqual(['resume', 'stop']);
  });

  it('names the merge-boundary action from the gate', () => {
    expect(cycleActions(cycle('awaiting-merge', 'merge-approval'))).toEqual([
      'merge',
      'pause',
      'stop',
    ]);
    expect(cycleActions(cycle('awaiting-merge', 'final-promotion'))).toEqual([
      'approve-promotion',
      'pause',
      'stop',
    ]);
    expect(cycleActions(cycle('awaiting-merge', 'controller-wait'))).toEqual(['pause', 'stop']);
    expect(cycleActions(cycle('completed'))).toEqual([]);
  });
});
