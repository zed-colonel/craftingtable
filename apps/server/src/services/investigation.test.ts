import {
  type AgentRun,
  type AgentRunStatus,
  cycleAttention,
  type CycleAttentionCode,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { openQuestions, stopQuestions } from './investigation.js';

/** The stores `stopQuestions` reads: the stop's run and its final message. */
function store(text: string, status: AgentRunStatus = 'finished') {
  return {
    execution: {
      runs: {
        find: (_ws: string, id: string) =>
          id === 'run-1' ? ({ id, workspaceId: 'ws', status } as AgentRun) : undefined,
      },
      runEvents: {
        latestOfKind: () => ({ kind: 'turn-completed', payload: { resultText: text } }),
      },
    },
  } as unknown as Parameters<typeof stopQuestions>[0];
}
const cycle = (
  code: CycleAttentionCode,
  extra: Partial<WorkCycle> = {},
  status: WorkCycle['status'] = 'needs-attention',
) =>
  ({
    workspaceId: 'ws',
    status,
    currentRunId: 'run-1',
    attention: cycleAttention(code),
    reason: '',
    ...extra,
  }) as unknown as WorkCycle;
const asked = 'Done in part.\n\n## Open questions\n- Which format?\n- Which release?\n';

describe('the questions an investigation works on (R-C16)', () => {
  it.each([
    'work-item-questions',
    'implementation-open-questions',
    'review-open-questions',
    'review-open-questions-at-limit',
    'scope-review-open-questions',
    'remediation-exhausted',
  ] as const)('reads the stop run report questions at %s', (code) => {
    expect(stopQuestions(store(asked), cycle(code))).toEqual({
      sourceRunId: 'run-1',
      questions: ['Which format?', 'Which release?'],
    });
  });

  it("takes a slice's routed work-item questions, never a shared decision's", () => {
    const workflow = {
      reassessments: 0,
      questions: [
        { question: 'Pick an ADR option?', destination: 'shared-decision', checkpointId: 'ADR-1' },
        { question: 'Which format?', destination: 'work-item' },
      ],
    } as WorkCycle['workflow'];
    expect(
      stopQuestions(store(asked), cycle('shared-decision-required', { workflow }))?.questions,
    ).toEqual(['Which format?']);
    const decisionsOnly = {
      reassessments: 0,
      questions: [workflow!.questions[0]!],
    } as WorkCycle['workflow'];
    expect(
      stopQuestions(store(asked), cycle('shared-decision-required', { workflow: decisionsOnly })),
    ).toBeUndefined();
    // A shared-decision stop never falls back to the report's text.
    expect(stopQuestions(store(asked), cycle('shared-decision-required'))).toBeUndefined();
  });

  it('offers nothing without questions, at another stop, while running or before the run ends', () => {
    expect(
      stopQuestions(store('Stopped.\n\n## Open questions\nnone'), cycle('remediation-exhausted')),
    ).toBeUndefined();
    expect(stopQuestions(store(asked), cycle('design-open-questions'))).toBeUndefined();
    expect(
      stopQuestions(store(asked), cycle('review-open-questions', {}, 'running')),
    ).toBeUndefined();
    expect(stopQuestions(store(asked, 'waiting'), cycle('review-open-questions'))).toBeUndefined();
    // A pause taken at the stop keeps it.
    expect(
      stopQuestions(store(asked), cycle('review-open-questions', {}, 'paused'))?.questions,
    ).toHaveLength(2);
  });

  it("reads a report's open questions item by item, or whole when it has no list", () => {
    expect(
      openQuestions(
        'Report.\n\n## Open questions\n1. First?\n   It matters because X.\n2) Second?\n\n## Notes\n- not a question',
      ),
    ).toEqual(['First?\nIt matters because X.', 'Second?']);
    expect(openQuestions('## Open questions\nShould the cache be shared?')).toEqual([
      'Should the cache be shared?',
    ]);
    expect(openQuestions('No section here.')).toEqual([]);
    expect(openQuestions('## Open questions\nnone')).toEqual([]);
  });
});
