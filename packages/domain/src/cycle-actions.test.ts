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

  // LIVE-33: guidance cannot start a round, so at the limit a question stop offers the grant.
  it('offers only the grant at a question stop whose review needs rounds the allowance lacks', () => {
    for (const code of [
      'work-item-questions',
      'shared-decision-required',
      'review-open-questions',
      'review-open-questions-at-limit',
      'remediation-exhausted',
    ] as const) {
      expect(cycleActions(cycle('needs-attention', code), undefined, true)).toEqual([
        'authorize-remediation',
        'stop',
      ]);
      expect(cycleActions(cycle('paused', code), undefined, true)).toEqual([
        'authorize-remediation',
        'resume',
        'stop',
      ]);
    }
    // Other stops, rounds left, and a newer manual run (which a resume adopts) are unchanged.
    expect(cycleActions(cycle('needs-attention', 'step-incomplete'), undefined, true)).toEqual([
      'resume',
      'stop',
    ]);
    expect(cycleActions(cycle('needs-attention', 'work-item-questions'))).toEqual([
      'resume',
      'stop',
    ]);
    expect(
      cycleActions(
        { ...cycle('needs-attention', 'work-item-questions'), currentRunId: 'run-1' } as WorkCycle,
        'run-2',
        true,
      ),
    ).toEqual(['resume', 'stop']);
    expect(cycleActions(cycle('paused'), undefined, true)).toEqual(['resume', 'stop']);
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

describe('investigation actions (R-C16)', () => {
  const questions = { questions: true, live: false };
  it.each([
    'work-item-questions',
    'implementation-open-questions',
    'review-open-questions',
    'review-open-questions-at-limit',
    'scope-review-open-questions',
    'remediation-exhausted',
    'shared-decision-required',
  ] as const)("offers Investigate beside the stop's own control: %s", (code) => {
    const own = cycleActions(cycle('needs-attention', code));
    expect(cycleActions(cycle('needs-attention', code), undefined, false, questions)).toEqual([
      ...own.slice(0, -1),
      'investigate',
      'stop',
    ]);
  });

  it('offers it only at a question stop that holds questions, and at a pause taken there', () => {
    expect(cycleActions(cycle('needs-attention', 'review-open-questions'))).not.toContain(
      'investigate',
    );
    expect(
      cycleActions(cycle('needs-attention', 'step-incomplete'), undefined, false, questions),
    ).not.toContain('investigate');
    expect(cycleActions(cycle('running'), undefined, false, questions)).toEqual(['pause', 'stop']);
    expect(
      cycleActions(cycle('paused', 'review-open-questions'), undefined, false, questions),
    ).toEqual(['resume', 'investigate', 'stop']);
    // Beside the grant at the round limit, and beside the shared decisions a stop waits on.
    expect(
      cycleActions(
        cycle('needs-attention', 'review-open-questions-at-limit'),
        undefined,
        true,
        questions,
      ),
    ).toEqual(['authorize-remediation', 'investigate', 'stop']);
    const waiting = {
      ...cycle('needs-attention', 'shared-decision-required'),
      unsettledDecisions: ['ADR-1'],
    } as WorkCycle;
    expect(cycleActions(waiting, undefined, false, questions)).toEqual([
      'open-shared-decisions',
      'investigate',
      'stop',
    ]);
  });

  it('accepts only ending the investigation while it is live', () => {
    const live = { questions: true, live: true };
    expect(
      cycleActions(cycle('needs-attention', 'review-open-questions'), undefined, true, live),
    ).toEqual(['end-investigation']);
    expect(cycleActions(cycle('paused', 'remediation-exhausted'), undefined, false, live)).toEqual([
      'end-investigation',
    ]);
  });
});
