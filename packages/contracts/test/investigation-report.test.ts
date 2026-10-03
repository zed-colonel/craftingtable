import { expect, it } from 'vitest';
import { parseInvestigationReport } from '../src/investigation-report.js';

const block = (value: unknown) =>
  `Findings below.\n\n\`\`\`craftingtable-investigation\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const proposed = {
  question: 'Does the planning amendment change F-010?',
  status: 'proposed',
  answer: 'No: F-010 is deferred to the amendment.',
  sources: ['docs/plan.md:40'],
};
const open = {
  question: 'Which release carries it?',
  status: 'open',
  answer: '',
  sources: [],
  reason: 'Nothing in the sources names a release.',
};

it('reads one investigation block: a proposed answer with sources, or why a question stays open', () => {
  const parsed = parseInvestigationReport(block({ version: 1, questions: [proposed, open] }));
  expect(parsed.status).toBe('complete');
  if (parsed.status === 'complete') expect(parsed.report.questions).toHaveLength(2);
});

it('refuses a proposal without sources, an open question without a reason, and two blocks', () => {
  for (const question of [
    { ...proposed, sources: [] },
    { ...proposed, answer: '' },
    { ...open, reason: undefined },
  ])
    expect(parseInvestigationReport(block({ version: 1, questions: [question] })).status).toBe(
      'invalid',
    );
  expect(parseInvestigationReport(block({ version: 1, questions: [] })).status).toBe('invalid');
  const one = block({ version: 1, questions: [proposed] });
  expect(parseInvestigationReport(one + one)).toEqual({
    status: 'invalid',
    reason: 'Provide one consolidated investigation block.',
  });
  expect(parseInvestigationReport('```craftingtable-investigation\n{').status).toBe('invalid');
  expect(parseInvestigationReport('No block at all.')).toEqual({ status: 'absent' });
});
