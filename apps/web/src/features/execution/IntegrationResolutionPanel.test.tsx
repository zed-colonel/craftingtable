import type { WorkCycle } from '@craftingtable/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationResolutionPanel } from './IntegrationResolutionPanel.js';
afterEach(cleanup);

const panel = (cycle: Partial<WorkCycle>) =>
  render(
    <IntegrationResolutionPanel
      cycle={{ status: 'needs-attention', profiles: {}, ...cycle } as WorkCycle}
      backends={[]}
      busy={false}
      canMutate
      onCommand={vi.fn()}
      onOpenRun={vi.fn()}
      runIds={[]}
    />,
  );

it('does not render for an idle cycle with nothing to resolve (R-E6, UI-10)', () => {
  panel({ attention: { code: 'design-open-questions', owner: 'operator' } });
  expect(screen.queryByRole('region', { name: 'Integration conflicts' })).toBeNull();
  panel({ status: 'paused' });
  expect(screen.queryByRole('region', { name: 'Integration conflicts' })).toBeNull();
});

it('offers inspection when an integration update stopped the cycle', () => {
  panel({ attention: { code: 'integration-update-failed', owner: 'operator' } });
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
});
