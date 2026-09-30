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
      cycle={
        {
          ...cycle,
          status: 'needs-attention',
          attention: { code: 'service-retries-exhausted', owner: 'operator' },
          providerRecovery: { ...recovery, attempts: 3 },
        } as WorkCycle
      }
      disabled={false}
      onRetry={vi.fn()}
      onPause={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  expect(screen.getByText(/Resuming grants a new step window/)).toBeDefined();
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

it('keeps a running retry visible with its pause control', () => {
  const { nextRetryAt: _due, ...running } = cycle.providerRecovery!;
  render(
    <ProviderRecovery
      cycle={{ ...cycle, status: 'running', providerRecovery: { ...running, attempts: 2 } }}
      disabled={false}
      onRetry={vi.fn()}
      onPause={vi.fn()}
    />,
  );
  expect(screen.getByText(/2 of 3 service retries used/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Pause service recovery' })).toBeDefined();
});

it('renders nothing when a later, unrelated stop leaves the retry record behind (R-E6, UI-10)', () => {
  const { nextRetryAt: _due, ...recovery } = cycle.providerRecovery!;
  for (const stopped of [
    {
      status: 'needs-attention',
      attention: { code: 'implementation-open-questions', owner: 'operator' },
    },
    { status: 'awaiting-merge', attention: { code: 'merge-approval', owner: 'operator' } },
  ]) {
    render(
      <ProviderRecovery
        cycle={
          { ...cycle, ...stopped, providerRecovery: { ...recovery, attempts: 3 } } as WorkCycle
        }
        disabled={false}
        onRetry={vi.fn()}
        onPause={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Model service recovery' })).toBeNull();
    cleanup();
  }
});

it('shows a service stop that is paused, and a failure the service reported as not retryable', () => {
  const { nextRetryAt: _due, ...recovery } = cycle.providerRecovery!;
  render(
    <ProviderRecovery
      cycle={
        {
          ...cycle,
          status: 'paused',
          attention: { code: 'service-failure-not-retryable', owner: 'operator' },
          providerRecovery: recovery,
        } as WorkCycle
      }
      disabled={false}
      onRetry={vi.fn()}
      onPause={vi.fn()}
    />,
  );
  expect(screen.getByRole('region', { name: 'Model service recovery' })).toBeDefined();
  expect(screen.getByText(/not retryable/)).toBeDefined();
});
