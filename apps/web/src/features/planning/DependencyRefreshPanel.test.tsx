import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import { DependencyRefreshPanel } from './DependencyRefreshPanel.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const view = {
  bindingRevision: 4,
  current: { id: 'runtime-3', generation: 3 },
  pinStatus: [
    {
      alias: 'wi',
      ref: 'revision',
      savedCommitSha: 'a'.repeat(40),
      currentCommitSha: 'b'.repeat(40),
      issue: 'WI advanced',
    },
  ],
} as RuntimeEvidenceView;
const preview = {
  bindingRevision: 4,
  expectedGeneration: 3,
  snapshotDigest: 'd'.repeat(64),
  pins: [
    { alias: 'wi', ref: 'revision', before: 'a'.repeat(40), after: 'b'.repeat(40), changed: true },
  ],
  nativeApproval: 'retained',
  blockers: [],
  evidence: [
    {
      id: 'wi-receipt',
      sourceId: 'WI-01',
      kind: 'parent',
      generation: 3,
      disposition: 'retained',
      reasons: ['AQ and environment inputs are unchanged.'],
    },
    {
      id: 'exo-receipt',
      sourceId: 'EXO-01',
      kind: 'parent',
      generation: 3,
      disposition: 'reverify',
      reasons: ['WI dependency changed.'],
    },
  ],
  reviews: [
    {
      roadmapId: 'roadmap',
      attemptId: 'attempt',
      sourceId: 'EXO-01',
      action: 'existing-recovery',
      reason: 'The existing recovery will reverify; its repair round is retained.',
    },
  ],
};
it('shows exact changes and retained evidence, and applies only an explicitly reviewed preview', async () => {
  const onSaved = vi.fn();
  vi.mocked(request)
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({ ...view, current: { id: 'runtime-4', generation: 4 } });
  render(
    <DependencyRefreshPanel
      base="/runtime"
      view={view}
      csrfToken="csrf"
      disabled={false}
      onSaved={onSaved}
    />,
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview dependency refresh' }));
  await screen.findByText('WI-01');
  expect(screen.getByText(/AQ and environment inputs/)).toBeTruthy();
  expect(screen.getByText(/existing recovery will reverify/)).toBeTruthy();
  const apply = screen.getByRole('button', { name: 'Apply reviewed dependency refresh' });
  expect(apply.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Dependency refresh rationale'), {
    target: { value: 'Reviewed the exact pins and retained work.' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(apply);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const options = vi.mocked(request).mock.calls[1]![2]!;
  expect(JSON.parse(options.body as string)).toEqual({
    bindingRevision: 4,
    expectedGeneration: 3,
    snapshotDigest: preview.snapshotDigest,
    rationale: 'Reviewed the exact pins and retained work.',
  });
  expect(screen.getByRole('status').textContent).toContain('No agents were started');
  expect(vi.mocked(request).mock.calls.map(([url]) => url)).toEqual([
    '/runtime/preview-refresh',
    '/runtime/refresh',
  ]);
});
it('keeps refresh blocked for live work and requires review again after a stale-preview error', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({
      ...preview,
      blockers: ['Pause roadmap scheduling before refreshing dependencies.'],
    })
    .mockResolvedValueOnce(preview)
    .mockRejectedValueOnce(
      new Error('The dependency refresh impact changed. Preview and review it again.'),
    );
  render(
    <DependencyRefreshPanel
      base="/runtime"
      view={view}
      csrfToken="csrf"
      disabled={false}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview dependency refresh' }));
  await screen.findByText(/Pause roadmap scheduling/);
  expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview dependency refresh' }));
  await waitFor(() => expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Dependency refresh rationale'), {
    target: { value: 'Reviewed' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed dependency refresh' }));
  await screen.findByRole('alert');
  expect(
    screen
      .getByRole('button', { name: 'Apply reviewed dependency refresh' })
      .hasAttribute('disabled'),
  ).toBe(true);
});
