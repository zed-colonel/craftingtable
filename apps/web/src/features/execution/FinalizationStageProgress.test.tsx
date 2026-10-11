import type { FinalizationView } from '@craftingtable/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FinalizationStageProgress } from './FinalizationStageProgress.js';

afterEach(cleanup);

const finding = (id: string, category: string, severity: string) => ({
  id,
  category,
  severity,
  status: 'open',
  title: `${id} title`,
  explanation: 'Why',
  recommendation: 'What',
});

/** R-C7 D7: a finalization names its parked nits apart from its optional suggestions. */
it('shows optional suggestions and nits parked at a spent allowance as separate follow-up work', () => {
  const view = {
    finalization: {
      stages: [
        {
          id: 'correctness',
          kind: 'correctness',
          name: 'Correctness',
          workItemSourceIds: [],
          policy: { maxNits: 0, maxRemediationRounds: 2, maxRunMinutes: 60 },
        },
      ],
    },
    cycle: {
      finalizationProgress: {
        stageIndex: 0,
        stages: [{ status: 'active', remediationRounds: 2, selectedFindingIds: [] }],
        obligations: [],
        decisions: [],
        followUps: [
          finding('S-1', 'polish', 'minor'),
          finding('N-1', 'correctness', 'nit'),
          finding('N-2', 'conformance', 'nit'),
        ],
      },
    },
    runs: [],
  } as unknown as FinalizationView;
  render(<FinalizationStageProgress view={view} />);
  expect(screen.getByText('Optional suggestions (1)')).toBeTruthy();
  expect(screen.getByText('Parked nits (2)')).toBeTruthy();
  expect(screen.queryByText(/Optional follow-up work/)).toBeNull();
  expect(screen.getByRole('heading', { name: /N-2 · conformance · nit/ })).toBeTruthy();
});
