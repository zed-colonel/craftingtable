import { describe, expect, it } from 'vitest';
import { cycleAttention } from '../src/attention.js';
import { cycleActions, resumeRedirect } from '../src/cycle-actions.js';
import { stopRecord } from '../src/cycle-stop.js';
import type { WorkCycle } from '../src/work-cycle.js';
import { asAgentRunId } from '../src/ids.js';

const cycle = (status: WorkCycle['status'], code?: Parameters<typeof cycleAttention>[0]) =>
  ({
    status,
    reason: '',
    ...(code ? { stop: stopRecord(cycleAttention(code), '2026-01-01T00:00:00.000Z') } : {}),
  }) as WorkCycle;

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
      // The stops `controller-error` hid (R-B4, decision 3): resumed once the cause is fixed.
      'phase-gate',
      'item-unavailable',
      'item-not-admitted',
      'predecessors-incomplete',
      'predecessor-merge-missing',
      'worktree-state',
      'resolution-not-ready',
      'launch-refused',
      'roadmap-binding-changed',
      'delegation-authority-lost',
      'review-capture-failed',
      'finalization-inactive',
      'service-unavailable',
    ] as const)
      expect(cycleActions(cycle('needs-attention', code))).toEqual(['resume', 'stop']);
    // An item marked complete cannot be made incomplete, so no resume can pass its gate: the
    // stop offers Stop, after which the worktree merges by hand (R-B4 increment 5 review).
    expect(cycleActions(cycle('needs-attention', 'item-completed-unmerged'))).toEqual(['stop']);
    expect(cycleActions(cycle('paused', 'item-completed-unmerged'))).toEqual(['stop']);
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
        asAgentRunId('run-2'),
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
    expect(cycleActions(stopped, asAgentRunId('r1'))).toEqual(['resolve-design', 'stop']);
    expect(cycleActions(stopped, asAgentRunId('manual-r2'))).toEqual(['resume', 'stop']);
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

  it('accepts only acknowledging a worktree change, or stopping, until it is acknowledged (R-C16)', () => {
    const changed = { questions: true, live: false, changed: true };
    for (const stopped of [
      cycle('needs-attention', 'review-open-questions'),
      cycle('paused', 'implementation-open-questions'),
    ])
      expect(cycleActions(stopped, undefined, true, changed)).toEqual([
        'acknowledge-worktree-change',
        'stop',
      ]);
    // A cycle no longer at its stop is not held.
    expect(
      cycleActions(cycle('running', 'review-open-questions'), undefined, false, changed),
    ).toEqual(['pause', 'stop']);
  });
});

// R-B4, decision 14: a newer manual run outside the cycle's handoff lineage cannot be adopted,
// so Resume is not offered for it, as the daemon refuses it; one inside the lineage still is.
describe('the newer run’s lineage', () => {
  it('offers no resume for a newer run the cycle cannot adopt', () => {
    const stopped = { ...cycle('needs-attention', 'step-incomplete'), currentRunId: 'run-1' };
    const newer = asAgentRunId('run-2');
    expect(cycleActions(stopped as WorkCycle, newer)).toEqual(['resume', 'stop']);
    expect(cycleActions(stopped as WorkCycle, newer, false, undefined, true)).toEqual(['stop']);
    expect(
      cycleActions({ ...stopped, status: 'paused' } as WorkCycle, newer, false, undefined, true),
    ).toEqual(['stop']);
  });
  // Increment 6 review, LOW-3 (A2): only Resume goes; the stop's other offers stay.
  it('keeps the stop’s other offers', () => {
    const asking = {
      ...cycle('needs-attention', 'review-open-questions'),
      currentRunId: 'run-1',
    } as WorkCycle;
    expect(
      cycleActions(asking, asAgentRunId('run-2'), false, { questions: true, live: false }, true),
    ).toEqual(['investigate', 'stop']);
  });
});

// R-B4, decision 14 (increment 6 review): where a plain resume would be refused at the round
// limit, the grant is offered in its place, so the control the refusal names is there.
describe('a resume at the round limit', () => {
  const at = (stopped: WorkCycle) =>
    cycleActions(stopped, undefined, false, undefined, false, true);
  it('offers the grant in place of Resume at a stop with no redirect, and at a plain pause', () => {
    expect(at(cycle('needs-attention', 'restart-resume'))).toEqual([
      'authorize-remediation',
      'stop',
    ]);
    expect(at(cycle('needs-attention', 'worktree-state'))).toEqual([
      'authorize-remediation',
      'stop',
    ]);
    expect(at(cycle('paused'))).toEqual(['authorize-remediation', 'stop']);
  });
  it('keeps a redirect, and a pause whose resume returns to its stop', () => {
    expect(at(cycle('needs-attention', 'remediation-exhausted'))).toEqual([
      'authorize-remediation',
      'stop',
    ]);
    expect(at(cycle('paused', 'remediation-no-change'))).toEqual(['resume', 'stop']);
  });
  it('offers the grant once where a question stop already offers it', () =>
    expect(
      cycleActions(cycle('paused', 'work-item-questions'), undefined, true, undefined, false, true),
    ).toEqual(['authorize-remediation', 'stop']));
  it('offers Resume where the resume would not reach the limit', () =>
    expect(cycleActions(cycle('paused'))).toEqual(['resume', 'stop']));
});
