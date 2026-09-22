import { describe, expect, it } from 'vitest';
import { parseWorkflowReport } from './workflow.js';
const report = {
  version: 1,
  questions: [],
  resolved: [],
  securityReview: { required: false, sources: [] },
};
const block = (value: unknown) => `\`\`\`craftingtable-workflow\n${JSON.stringify(value)}\n\`\`\``;
describe('workflow report authority', () => {
  it('preserves explicit operator destinations and cited plan answers', () => {
    expect(
      parseWorkflowReport(
        block({
          ...report,
          questions: [
            {
              question: 'Approve this architecture?',
              destination: 'shared-decision',
              checkpointId: 'APP-ADR-01',
            },
          ],
          resolved: [
            {
              question: 'Which branch?',
              answer: 'Saved revision branch',
              sources: ['Repository policy revision 1'],
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: 'complete',
      report: { questions: [{ destination: 'shared-decision' }] },
    });
  });
  it.each([
    { ...report, approved: true },
    {
      ...report,
      questions: [{ question: 'May I change architecture?', destination: 'controller' }],
    },
    {
      ...report,
      resolved: [{ question: 'Missing evidence?', answer: 'Assumed passed', sources: [] }],
    },
  ])('rejects invented authority and uncited resolutions', (value) => {
    expect(parseWorkflowReport(block(value)).status).toBe('invalid');
  });
  it('fails closed on duplicate or unfinished reports and preserves legacy absence', () => {
    expect(parseWorkflowReport(block(report) + '\n' + block(report)).status).toBe('invalid');
    expect(parseWorkflowReport('```craftingtable-workflow\n{}').status).toBe('invalid');
    expect(parseWorkflowReport('## Open questions\nNeeds an answer').status).toBe('absent');
  });
});
