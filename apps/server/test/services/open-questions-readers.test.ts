import type { Roadmap, RoadmapEntry, WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { scopeRecoveryDecision } from '../../src/services/scope-recovery-policy.js';
import { operatorQuestionRoutes } from '../../src/services/workflow-policy.js';

/**
 * The open-questions readers outside the step outcome (R-B4 increment 3 review, finding 3): each
 * reads the one checkpoint rule its own way, a presentation reader showing only a standing
 * checkpoint's questions, a strict one reading a missing checkpoint as a fault.
 */

const cycle = { id: 'cycle', workspaceId: 'ws', currentRunId: 'run' } as unknown as WorkCycle;

describe('operatorQuestionRoutes (the question routes, a presentation reader)', () => {
  const tx = {} as StorageRepositories;
  it.each([
    ['questions listed', 'Done.\n\n## Open questions\n- Which queue?', '- Which queue?'],
    ['none', 'Done.\n\n## Open questions\nnone', undefined],
    ['None. with a full stop', 'Done.\n\n## Open questions\nNone.', undefined],
    ['a repeated section', '## Open questions\n- A\n## Open questions\n- B', undefined],
    ['no section', 'Done.', undefined],
    ['CRLF line endings', 'Done.\r\n\r\n## Open questions\r\n- Which queue?\r\n', '- Which queue?'],
  ])('%s', (_name, text, question) =>
    expect(operatorQuestionRoutes(tx, cycle, text)).toEqual(
      question === undefined ? [] : [{ question, destination: 'work-item' }],
    ),
  );
});

describe('scopeRecoveryDecision (a strict reader)', () => {
  const roadmap = { workspaceId: 'ws' } as unknown as Roadmap;
  const entry = {} as RoadmapEntry;
  const decide = (resultText: string) =>
    scopeRecoveryDecision(
      {
        execution: {
          runs: { find: () => ({ id: 'run', status: 'finished' }) },
          runEvents: {
            latestOfKind: () => ({
              kind: 'turn-completed',
              payload: {
                outcome: 'success',
                resultText,
                reviewReport: { status: 'complete', report: { findings: [] } },
              },
            }),
          },
        },
      } as unknown as StorageRepositories,
      roadmap,
      entry,
      cycle,
    );
  it('needs the operator when the review has no checkpoint, or a broken one', () => {
    for (const text of ['Reviewed.', '## Open questions\nnone\n## Open questions\nnone'])
      expect(decide(text)).toEqual({
        reason:
          'Recovery needs your input: resolve questions, failed runs or incomplete review reports from the work item.',
      });
  });
  it('reads a review whose checkpoint is none on to its findings', () =>
    expect(decide('Reviewed.\n\n## Open questions\nnone')).toEqual({
      reason: 'This review needs manual recovery; it has no actionable open findings.',
    }));
});
