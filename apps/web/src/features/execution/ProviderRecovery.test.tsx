import type { WorkCycle } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderRecovery } from './ProviderRecovery.js';
afterEach(cleanup);
const cycle = {
  status: 'running',
  providerRecovery: {
    attempts: 1,
    sourceRunId: 'failed',
    nextRetryAt: '2026-09-22T12:00:00Z',
    failure: { kind: 'capacity', message: 'Model at capacity.', safeToRetry: true },
    profile: { backend: 'codex', model: 'same-model', permissionMode: 'auto' },
  },
} as WorkCycle;
it('shows service limits independently and exposes bounded retry and pause controls', () => {
  const onRetry = vi.fn(),
    onPause = vi.fn();
  const view = render(
    <ProviderRecovery cycle={cycle} disabled={false} onRetry={onRetry} onPause={onPause} />,
  );
  expect(screen.getByText(/1 of 3 service retries used/)).toBeDefined();
  expect(screen.getByText(/Paused roadmap scheduling holds this retry/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
  fireEvent.click(screen.getByRole('button', { name: 'Pause service recovery' }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(onPause).toHaveBeenCalledOnce();
  view.rerender(
    <ProviderRecovery
      cycle={{ ...cycle, status: 'paused' }}
      disabled
      onRetry={onRetry}
      onPause={onPause}
    />,
  );
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry now' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Pause service recovery' })).toBeNull();
});
it('does not offer Retry now after exhaustion or completion', () => {
  const { nextRetryAt: _due, ...recovery } = cycle.providerRecovery!;
  const view = render(
    <ProviderRecovery
      cycle={{
        ...cycle,
        status: 'needs-attention',
        providerRecovery: { ...recovery, attempts: 3 },
      }}
      disabled={false}
      onRetry={vi.fn()}
      onPause={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  expect(screen.getByText(/explicit resume after exhaustion/)).toBeDefined();
  view.rerender(
    <ProviderRecovery
      cycle={{ ...cycle, status: 'completed' }}
      disabled={false}
      onRetry={vi.fn()}
      onPause={vi.fn()}
    />,
  );
  expect(screen.queryByRole('region', { name: 'Model service recovery' })).toBeNull();
});
