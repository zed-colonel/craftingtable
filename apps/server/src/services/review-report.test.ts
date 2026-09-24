import { describe, expect, it } from 'vitest';
import { assessReviewReport, finalVerdict } from './review-report.js';
import { latestReviewReport } from './run-handoff.js';

const finding = {
  id: 'F-001',
  severity: 'minor',
  status: 'open',
  title: 'Missing case',
  explanation: 'An edge case lacks a test.',
  recommendation: 'Add the case.',
};
const report = {
  version: 1,
  complete: true,
  verdict: 'mergeable',
  exitGate: { met: true, evidence: 'Required checks pass.' },
  findings: [finding],
};
function message(value: unknown = report, verdict = 'mergeable') {
  return `Summary\n\n\`\`\`craftingtable-review\n${JSON.stringify(value)}\n\`\`\`\n\nVERDICT: ${verdict}`;
}

describe('consolidated findings', () => {
  it('accepts minor findings with a mergeable verdict and retains stable IDs', () => {
    expect(assessReviewReport(message(), false, new Set(['F-001']))).toMatchObject({
      status: 'complete',
      report,
    });
    expect(finalVerdict('VERDICT: mergeable\nactually still investigating')).toBeUndefined();
  });

  it.each([
    { ...report, findings: [finding, finding] },
    { ...report, complete: false },
    { ...report, version: 2 },
    { ...report, findings: [{ ...finding, severity: 'major' }] },
    { ...report, findings: [{ ...finding, severity: 'unknown' }] },
    { ...report, findings: [{ ...finding, status: 'resolved' }] },
    { ...report, findings: [{ ...finding, status: 'withdrawn', disposition: ' ' }] },
    { ...report, exitGate: { met: false, evidence: 'Missing check.' } },
  ])('rejects a contradictory or incomplete report %#', (value) => {
    expect(assessReviewReport(message(value)).status).toBe('invalid');
  });

  it('requires explicit dispositions instead of disappearing findings', () => {
    const missing = assessReviewReport(
      message({ ...report, findings: [] }),
      false,
      new Set(['F-001']),
    );
    expect(missing).toMatchObject({
      status: 'invalid',
      issues: [expect.stringContaining('F-001')],
    });
    const withdrawn = {
      ...report,
      findings: [
        { ...finding, status: 'withdrawn', disposition: 'Existing test covers this case.' },
      ],
    };
    expect(assessReviewReport(message(withdrawn), false, new Set(['F-001']))).toMatchObject({
      status: 'complete',
      report: withdrawn,
    });
  });

  it('keeps legacy reviews unstructured and never treats omitted structured findings as zero findings', () => {
    expect(assessReviewReport('Minor suggestion.\nVERDICT: mergeable').status).toBe('unstructured');
    expect(assessReviewReport('VERDICT: mergeable', false, new Set(['F-001'])).status).toBe(
      'invalid',
    );
    expect(assessReviewReport(message({ ...report, findings: [] })).status).toBe('complete');
  });

  it('rejects conflicting verdicts, duplicate blocks, malformed JSON, and truncated output', () => {
    for (const value of [
      message(report, 'changes-requested'),
      `${message()}\n${message()}`,
      '```craftingtable-review\n{\n```',
      '```craftingtable-review\n{',
    ]) {
      expect(assessReviewReport(value).status).toBe('invalid');
    }
    expect(assessReviewReport(message(), true).status).toBe('invalid');
    expect(assessReviewReport(`${message()}\n…[truncated by CraftingTable]`).status).toBe(
      'invalid',
    );
  });

  it('tells a structural fault from missing content (R-C2 repairs only the first)', () => {
    expect(assessReviewReport(message(report, 'changes-requested'))).toMatchObject({
      status: 'invalid',
      fault: 'format',
    });
    expect(assessReviewReport('```craftingtable-review\n{\n```')).toMatchObject({
      status: 'invalid',
      fault: 'format',
    });
    expect(
      assessReviewReport(message({ ...report, findings: [] }), false, new Set(['F-001'])),
    ).toMatchObject({ status: 'invalid', fault: 'content' });
  });

  it('derives the fault of a report recorded before faults were typed', () => {
    const recorded = (resultText: string) => {
      const event = {
        kind: 'turn-completed',
        sequence: 1,
        payload: {
          outcome: 'success',
          resultText,
          reviewReport: { status: 'invalid', issues: ['recorded issue'] },
        },
      };
      const execution = {
        runEvents: {
          latestOfKind: (_w: unknown, _r: unknown, kind: string) =>
            kind === 'turn-completed' ? event : undefined,
        },
      } as unknown as Parameters<typeof latestReviewReport>[0];
      return latestReviewReport(execution, { role: 'review', workspaceId: 'w', id: 'r' } as never);
    };
    // Its text is itself malformed: the structure was at fault.
    expect(recorded('```craftingtable-review\n{\n```')).toMatchObject({ fault: 'format' });
    // Its text is a valid report: the recorded issues came from content checks.
    expect(recorded(message())).toMatchObject({ fault: 'content', issues: ['recorded issue'] });
  });
});
