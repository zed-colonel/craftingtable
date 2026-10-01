import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CheckpointPreparation } from './CheckpointPreparation.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const candidate = {
  checkpointId: 'WI-AQ-G1',
  title: 'Core vocabulary',
  requirements: ['Fresh replay passes'],
  reviewerRoles: ['provider-maintainer', 'consumer-maintainer'],
  cases: [{ id: 'AB-WI-001' }],
  laterCases: [{ id: 'AB-WI-019', sliceId: 'wi/WI-11/embedded-runtime' }],
  issues: [],
  snapshotDigest: 'digest',
  runId: 'review',
  headSha: 'candidate-sha',
  integrationSha: 'integration-sha',
  report: 'All assigned tests passed.',
  buildReceipts: 'retained receipts',
};
const preview = { worktreeId: 'tree', candidates: [candidate] };
const prepared = {
  worktreeId: 'tree',
  candidates: [{ ...candidate, submission: { id: 'packet' } }],
};
function show() {
  const onChanged = vi.fn();
  render(
    <CheckpointPreparation
      workspaceId="ws"
      definitionId="map"
      worktreeId="tree"
      csrfToken="csrf"
      canMutate
      onChanged={onChanged}
    />,
  );
  return onChanged;
}
it('prepares saved proof and requires explicit responsibilities and rationale before acceptance', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce(prepared)
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({
      worktreeId: 'tree',
      candidates: [{ ...prepared.candidates[0], decision: { outcome: 'accepted' } }],
    });
  const changed = show();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Review checkpoint evidence' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare checkpoint evidence' }));
  const accept = await screen.findByRole('button', { name: 'Accept checkpoint evidence' });
  expect(screen.getByText(/AB-WI-019: required at wi\/WI-11/)).toBeDefined();
  expect(accept.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Checkpoint review rationale'), {
    target: { value: 'Reviewed source-bound proof' },
  });
  expect(accept.hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(accept);
  await screen.findByText('Checkpoint accepted for this candidate.');
  expect(JSON.parse(String(vi.mocked(request).mock.calls[2]![2]!.body))).toEqual({
    submissionId: 'packet',
    outcome: 'accepted',
    rationale: 'Reviewed source-bound proof',
    checkpointReviewRoles: ['provider-maintainer', 'consumer-maintainer'],
  });
  expect(changed).toHaveBeenCalledTimes(2);
});
it('shows stale evidence without dropping operator rationale or enabling acceptance', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(prepared)
    .mockRejectedValueOnce(new Error('Integration advanced. Refresh evidence.'));
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Review checkpoint evidence' }));
  const accept = await screen.findByRole('button', { name: 'Accept checkpoint evidence' });
  const rationale = screen.getByLabelText('Checkpoint review rationale') as HTMLTextAreaElement;
  fireEvent.change(rationale, { target: { value: 'My review' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(accept);
  await screen.findByRole('alert');
  expect(rationale.value).toBe('My review');
  vi.mocked(request).mockResolvedValueOnce({
    ...prepared,
    candidates: [{ ...prepared.candidates[0], issues: ['Integration advanced.'] }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh checkpoint evidence' }));
  await waitFor(() => expect(accept.hasAttribute('disabled')).toBe(true));
});
