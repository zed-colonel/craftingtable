import { describe, expect, it } from 'vitest';
import { parseDesignReport } from '../src/design-report.js';
const block = (items: unknown[]) =>
  `\`\`\`craftingtable-design\n${JSON.stringify({ version: 1, items })}\n\`\`\`\n## Open questions\nnone`;
describe('design question classification', () => {
  it('validates standalone decision briefs without turning recommendations into resolutions', () => {
    const item = {
      kind: 'operator-decision',
      question: 'Approve LOCAL-ADR-01?',
      answer: 'Recommend explicit IDs',
      sources: ['plan §4'],
      decision: {
        checkpointId: 'LOCAL-ADR-01',
        decisionText: 'Use explicit stable IDs.',
        why: 'Replay preserves identity.',
        alternatives: [{ option: 'Generated IDs', tradeoff: 'Identity changes on replay' }],
        consequences: 'Implement and independently test replay.',
        coverage: 'full',
        consumers: [],
        retainedObligations: 'Independent implementation tests and qualification remain required.',
      },
    };
    const parsed = parseDesignReport(block([item]));
    expect(parsed.status).toBe('complete');
    if (parsed.status === 'complete')
      expect(parsed.report.items[0]?.kind).toBe('operator-decision');
    expect(
      parseDesignReport(
        block([
          {
            ...item,
            decision: {
              ...item.decision,
              consumers: [
                { sliceId: 'a/A-01/domain', phase: 'merge', replacesFullCheckpoint: true },
              ],
            },
          },
        ]),
      ).status,
    ).toBe('invalid');
    expect(parseDesignReport(block([{ ...item, kind: 'resolved' }])).status).toBe('invalid');
    expect(parseDesignReport(block([{ ...item, sources: [] }])).status).toBe('invalid');
    expect(
      parseDesignReport(block([{ ...item, decision: { ...item.decision, coverage: 'clauses' } }]))
        .status,
    ).toBe('invalid');
    expect(
      parseDesignReport(
        block([
          {
            ...item,
            decision: {
              ...item.decision,
              coverage: 'clauses',
              consumers: [
                { sliceId: 'local/A-01/domain', phase: 'merge', replacesFullCheckpoint: true },
              ],
              retainedObligations: 'Keep transport approval for integration.',
            },
          },
        ]),
      ).status,
    ).toBe('complete');
  });
  it('retains legacy reports but rejects incomplete, duplicate and uncited classifications', () => {
    expect(parseDesignReport('## Open questions\nnone').status).toBe('absent');
    expect(parseDesignReport('```craftingtable-design\n{}').status).toBe('invalid');
    expect(parseDesignReport(`${block([])}\n${block([])}`).status).toBe('invalid');
    expect(
      parseDesignReport(
        block([{ kind: 'resolved', question: 'Encoding?', answer: 'JSON', sources: [] }]),
      ).status,
    ).toBe('invalid');
  });
  it('preserves operator authority and accepts only explicit predecessor state shapes', () => {
    expect(
      parseDesignReport(
        block([
          {
            kind: 'operator-decision',
            question: 'Approve encoding?',
            answer: 'Recommend JSON',
            sources: ['plan.md §4'],
          },
        ]),
      ).status,
    ).toBe('complete');
    expect(
      parseDesignReport(
        block([
          {
            kind: 'dependency',
            question: 'Wait',
            answer: '',
            sources: [],
            dependency: { kind: 'slice', id: 'a/A-01/domain', state: 'verified' },
          },
        ]),
      ).status,
    ).toBe('complete');
    expect(
      parseDesignReport(
        block([
          {
            kind: 'dependency',
            question: 'Wait',
            answer: '',
            sources: [],
            dependency: { kind: 'checkpoint', id: 'ADR-01', state: 'passed' },
          },
        ]),
      ).status,
    ).toBe('invalid');
  });
});
