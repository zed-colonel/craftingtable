import { describe, expect, it } from 'vitest';
import { parseDesignReport } from './design-report.js';
const block = (items: unknown[]) =>
  `\`\`\`craftingtable-design\n${JSON.stringify({ version: 1, items })}\n\`\`\`\n## Open questions\nnone`;
describe('design question classification', () => {
  it('retains legacy reports but rejects incomplete, duplicate and uncited classifications', () => {
    expect(parseDesignReport('## Open questions\nnone').status).toBe('absent');
    expect(parseDesignReport('```craftingtable-design\n{}').status).toBe('invalid');
    expect(parseDesignReport(block([]) + '\n' + block([])).status).toBe('invalid');
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
