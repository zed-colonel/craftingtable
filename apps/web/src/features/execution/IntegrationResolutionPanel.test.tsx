import type { WorkCycle } from '@craftingtable/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationResolutionPanel } from './IntegrationResolutionPanel.js';
afterEach(cleanup);

const panel = (cycle: Partial<WorkCycle>) =>
  render(
    <IntegrationResolutionPanel
      cycle={{ status: 'needs-attention', reason: '', profiles: {}, ...cycle } as WorkCycle}
      backends={[]}
      busy={false}
      canMutate
      onCommand={vi.fn()}
      onOpenRun={vi.fn()}
      runIds={[]}
    />,
  );

it('shows only the inspect action for an idle cycle with nothing to resolve (R-E6, UI-10)', () => {
  panel({ attention: { code: 'design-open-questions', owner: 'operator' } });
  expect(screen.queryByRole('region', { name: 'Integration conflicts' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
  cleanup();
  panel({ status: 'running' });
  expect(screen.queryByRole('button', { name: 'Inspect integration conflicts' })).toBeNull();
});

it('keeps inspection reachable on a paused cycle after a manual update conflicted', () => {
  // A conflicting manual update records no stop; the paused cycle still offers inspection.
  panel({ status: 'paused', reason: 'Automation paused by operator.' });
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
});

it('shows the panel for an integration stop written before codes existed', () => {
  panel({ reason: 'Integration refresh limit reached.' });
  expect(screen.getByRole('region', { name: 'Integration conflicts' })).toBeDefined();
});

it('offers inspection when an integration update stopped the cycle', () => {
  panel({ attention: { code: 'integration-update-failed', owner: 'operator' } });
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
});
