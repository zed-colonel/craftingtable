import type { AgentRunDetailResponse } from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadRun } from '../../lib/execution-api.js';
import { SourceRunReport } from './SourceRunReport.js';
vi.mock('../../lib/execution-api.js', () => ({ loadRun: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const props = { workspaceId: 'ws', runId: 'run', label: 'Investigation results and evidence' };
const detail = {
  run: { status: 'finished' },
  latestOutcome: {
    sequence: 2,
    occurredAt: '2026-09-22T00:00:00Z',
    outcome: 'success',
    truncated: false,
    text: '**Observed:** no source changes.\nEvidence details remain here.',
  },
} as AgentRunDetailResponse;
it('loads journaled evidence only on expansion and preserves it across refreshes', async () => {
  vi.mocked(loadRun).mockResolvedValue(detail);
  const { container, rerender } = render(<SourceRunReport {...props} />);
  expect(loadRun).not.toHaveBeenCalled();
  const disclosure = container.querySelector('details')!;
  disclosure.open = true;
  await screen.findByText('Observed:');
  expect(screen.getByRole('link', { name: 'Open source run' }).getAttribute('href')).toBe(
    '/workspaces/ws/runs/run',
  );
  rerender(<SourceRunReport {...props} />);
  expect(disclosure.open).toBe(true);
  expect(loadRun).toHaveBeenCalledTimes(1);
});
it('offers a retry without launching an agent when the report cannot load', async () => {
  vi.mocked(loadRun).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(detail);
  const { container } = render(<SourceRunReport {...props} />);
  const disclosure = container.querySelector('details')!;
  disclosure.open = true;
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading report' }));
  await screen.findByText('Observed:');
});
