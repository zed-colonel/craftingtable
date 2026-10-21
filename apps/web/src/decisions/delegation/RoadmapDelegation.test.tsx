import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Roadmap } from '@craftingtable/domain';
import type { CrossProjectView } from '@craftingtable/contracts';
import { RoadmapDelegation } from './RoadmapDelegation.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('requires an explicit entry selection and confirmed grant, including already-started work', async () => {
  const roadmap = {
    id: 'roadmap',
    workspaceId: 'workspace',
    version: 12,
    status: 'paused',
    attempts: [{ entryId: 'entry' }],
    definition: {
      entries: [
        {
          id: 'entry',
          sourceId: 'WI-04',
          reviewerRoles: ['repository-maintainer'],
          executionScope: { kind: 'slice' },
        },
      ],
    },
  } as unknown as Roadmap;
  const view = {
    reviewerRoles: ['repository-maintainer', 'profile-owner'],
    nodes: [{ included: true, sourceId: 'WI-WORKER-G1', reviewerRoles: ['profile-owner'] }],
  } as CrossProjectView;
  const changed = vi.fn();
  vi.mocked(request).mockResolvedValue({ roadmap });
  render(
    <RoadmapDelegation
      roadmap={roadmap}
      view={view}
      backends={[]}
      csrfToken="csrf"
      disabled={false}
      onChanged={changed}
    />,
  );
  const details = screen.getByText('Delegation for queued and started work').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await screen.findByRole('button', { name: 'Select all entries' });
  expect(
    screen.getByRole('button', { name: 'Apply future delegation' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Select all entries' }));
  fireEvent.click(screen.getByLabelText('profile-owner'));
  fireEvent.change(screen.getByLabelText('Integration conflicts'), {
    target: { value: 'automatic' },
  });
  fireEvent.change(screen.getByLabelText('Reason for changing delegation'), {
    target: { value: 'Authorize checkpoint responsibilities and conflict resolution' },
  });
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/I authorize these future actions/));
  fireEvent.click(screen.getByRole('button', { name: 'Apply future delegation' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  const options = vi.mocked(request).mock.calls[0]![2]!;
  expect(JSON.parse(options.body as string)).toEqual({
    expectedVersion: 12,
    entryIds: ['entry'],
    reviewerRoles: ['repository-maintainer', 'profile-owner'],
    automation: { integrationMerge: 'manual', integrationConflicts: 'automatic' },
    rationale: 'Authorize checkpoint responsibilities and conflict resolution',
  });
});
it('is offered while the roadmap runs, not once it ended (R-B6, decision 2)', async () => {
  const roadmap = (status: string) =>
    ({
      id: 'roadmap',
      workspaceId: 'workspace',
      version: 12,
      status,
      attempts: [],
      definition: { entries: [{ id: 'entry', sourceId: 'WI-04', reviewerRoles: [] }] },
    }) as unknown as Roadmap;
  const view = { reviewerRoles: [], nodes: [] } as unknown as CrossProjectView;
  for (const [status, locked] of [
    ['running', false],
    ['stopped', true],
  ] as const) {
    render(
      <RoadmapDelegation
        roadmap={roadmap(status)}
        view={view}
        backends={[]}
        csrfToken="csrf"
        disabled={false}
        onChanged={vi.fn()}
      />,
    );
    const details = screen.getByText('Delegation for queued and started work').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const select = await screen.findByRole('button', { name: 'Select all entries' });
    expect(select.closest('fieldset')!.disabled).toBe(locked);
    expect(screen.queryByText(/Pause scheduling/)).toBeNull();
    cleanup();
  }
});
