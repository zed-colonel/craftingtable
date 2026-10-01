import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewReportAssessment } from './review.js';
import {
  DEFAULT_COMPLETION_POLICY,
  designHasNoOpenQuestions,
  evaluateCompletion,
} from './work-cycle.js';

const finding: ReviewFinding = {
  id: 'F-1',
  severity: 'minor',
  status: 'open',
  title: 'Boundary',
  explanation: 'Missing case',
  recommendation: 'Cover it',
};
const assessment = (findings: readonly ReviewFinding[]): ReviewReportAssessment => ({
  status: 'complete',
  issues: [],
  report: {
    version: 1,
    complete: true,
    verdict: 'mergeable',
    exitGate: { met: true, evidence: 'Checks passed' },
    findings,
  },
});
describe('completion policy', () => {
  it.each(['blocking', 'major', 'minor'] as const)(
    'requires remediation of open %s findings even with a mergeable verdict',
    (severity) => {
      expect(
        evaluateCompletion(DEFAULT_COMPLETION_POLICY, assessment([{ ...finding, severity }]))
          .action,
      ).toBe('remediate');
    },
  );
  it('allows exactly the configured nit count and ignores closed findings', () => {
    const nits = [1, 2, 3].map((id) => ({ ...finding, id: `N-${id}`, severity: 'nit' as const }));
    expect(
      evaluateCompletion(
        DEFAULT_COMPLETION_POLICY,
        assessment([...nits, { ...finding, status: 'resolved', disposition: 'Verified' }]),
      ).action,
    ).toBe('awaiting-merge');
    expect(
      evaluateCompletion({ ...DEFAULT_COMPLETION_POLICY, maxNits: 2 }, assessment(nits)).action,
    ).toBe('remediate');
    expect(
      evaluateCompletion({ ...DEFAULT_COMPLETION_POLICY, maxNits: 0 }, assessment([])).action,
    ).toBe('awaiting-merge');
  });
  it.each([
    undefined,
    { status: 'unstructured', issues: [] },
    { status: 'invalid', issues: ['Missing findings'] },
  ] as const)('pauses for missing or invalid structured evidence', (report) => {
    expect(evaluateCompletion(DEFAULT_COMPLETION_POLICY, report).action).toBe('needs-attention');
  });
  // LIVE-32: a scope issue read as the generic reason, and three reviews were retried blind.
  it('names why a report is not usable, within the stored reason limit', () => {
    const scope = 'The review must identify this exact slice in scopeEvidence.';
    expect(
      evaluateCompletion(DEFAULT_COMPLETION_POLICY, { status: 'invalid', issues: [scope] }).reason,
    ).toBe(`A complete, valid structured review report is required. ${scope}`);
    expect(
      evaluateCompletion(DEFAULT_COMPLETION_POLICY, {
        status: 'unstructured',
        issues: ['End the review with one block.', 'Add the verdict line.'],
      }).reason,
    ).toBe(
      'A complete, valid structured review report is required. End the review with one block. Add the verdict line.',
    );
    expect(evaluateCompletion(DEFAULT_COMPLETION_POLICY, undefined).reason).toBe(
      'A complete, valid structured review report is required.',
    );
    const long = evaluateCompletion(DEFAULT_COMPLETION_POLICY, {
      status: 'invalid',
      issues: Array.from({ length: 20 }, () => 'x'.repeat(1000)),
    }).reason;
    expect(long.length).toBeLessThanOrEqual(3000);
    expect(long.startsWith('A complete, valid structured review report is required. xxx')).toBe(
      true,
    );
  });
  it('requires the exit gate and mergeable verdict independently', () => {
    const complete = assessment([]);
    if (complete.status !== 'complete') throw new Error('fixture');
    expect(
      evaluateCompletion(DEFAULT_COMPLETION_POLICY, {
        ...complete,
        report: { ...complete.report, verdict: 'changes-requested' },
      }).action,
    ).toBe('remediate');
    expect(
      evaluateCompletion(DEFAULT_COMPLETION_POLICY, {
        ...complete,
        report: { ...complete.report, exitGate: { met: false, evidence: 'Failed tests' } },
      }).action,
    ).toBe('remediate');
  });
});
describe('design checkpoint', () => {
  it.each(['Proposal\n\n## Open questions\nnone', '## Open questions\r\nNone\r\n'])(
    'accepts explicit final none',
    (text) => expect(designHasNoOpenQuestions(text)).toBe(true),
  );
  it.each([
    'Looks good',
    '## Open questions\n- Pick storage',
    '## Open questions\nnone\n## Risks\nquestion',
    '## Open questions\nnone\n## Open questions\nnone',
    '```md\n## Open questions\nnone\n```',
    '## Open questions\nnone, probably',
  ])('pauses ambiguous or non-final checkpoints', (text) =>
    expect(designHasNoOpenQuestions(text)).toBe(false),
  );
  it('rejects truncated results', () =>
    expect(designHasNoOpenQuestions('## Open questions\nnone', true)).toBe(false));
});
