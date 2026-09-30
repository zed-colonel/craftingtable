import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EvidenceDecision } from './EvidenceDecision.js';
import { request } from '../../lib/api-client.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const bodies = () =>
  vi.mocked(request).mock.calls.map(([url, , init]) => ({
    url: String(url),
    body: JSON.parse(String(init?.body)),
  }));

it('accepts only after the attestation and a rationale, and sends the review roles with it', async () => {
  vi.mocked(request).mockResolvedValue({ submissions: [] });
  const onDecided = vi.fn();
  render(
    <EvidenceDecision
      workspaceId="ws"
      definitionId="map"
      csrfToken="csrf"
      submissionIds={['s-1']}
      labels={{ rationale: 'Rationale', accepted: 'Accept', rejected: 'Reject' }}
      attestation="I reviewed it."
      checkpointReviewRoles={['provider-maintainer']}
      onDecided={onDecided}
    />,
  );
  const accept = screen.getByRole('button', { name: 'Accept' });
  const reject = screen.getByRole('button', { name: 'Reject' });
  fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: 'Checked.' } });
  expect(accept.hasAttribute('disabled')).toBe(true);
  expect(reject.hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed it.' }));
  fireEvent.click(accept);
  await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1));
  expect(bodies()).toEqual([
    {
      url: '/api/workspaces/ws/concurrency-definitions/map/runtime/decide',
      body: {
        submissionId: 's-1',
        outcome: 'accepted',
        rationale: 'Checked.',
        checkpointReviewRoles: ['provider-maintainer'],
      },
    },
  ]);
  expect(vi.mocked(request).mock.calls[0]?.[2]?.headers).toEqual({
    'x-craftingtable-csrf': 'csrf',
  });
});

it('rejects without the review roles, and blocks acceptance while the host says so', async () => {
  vi.mocked(request).mockResolvedValue({ submissions: [] });
  render(
    <EvidenceDecision
      workspaceId="ws"
      definitionId="map"
      csrfToken="csrf"
      submissionIds={['s-1']}
      labels={{ rationale: 'Rationale', accepted: 'Accept', rejected: 'Reject' }}
      checkpointReviewRoles={['provider-maintainer']}
      acceptBlocked
      onDecided={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: 'Stale.' } });
  expect(screen.getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(bodies()[0]?.body).toEqual({
    submissionId: 's-1',
    outcome: 'rejected',
    rationale: 'Stale.',
  });
});

it('decides several in turn and stops at the first refusal, naming what was decided', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({ submissions: [] })
    .mockRejectedValueOnce(new Error('Pause roadmap scheduling first.'));
  const onDecided = vi.fn();
  render(
    <EvidenceDecision
      workspaceId="ws"
      definitionId="map"
      csrfToken="csrf"
      submissionIds={['a', 'b', 'c']}
      outcomes={['accepted']}
      labels={{ rationale: 'Rationale', accepted: 'Approve' }}
      name={(id) => `ADR-${id}`}
      onDecided={onDecided}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: 'All read.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('Approved ADR-a; stopped: Pause roadmap scheduling first.');
  expect(bodies().map((b) => b.body.submissionId)).toEqual(['a', 'b']);
  expect(onDecided).toHaveBeenCalledTimes(1);
});
