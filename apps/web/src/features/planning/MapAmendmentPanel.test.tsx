import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { asWorkspaceId, type Roadmap } from '@craftingtable/domain';
import { MapAmendmentPanel } from './MapAmendmentPanel.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const candidate = {
  definitionId: '12345678-1234-4234-8234-123456789abc',
  bindingRevision: 1,
  targetId: 'FULL',
  selection: 'prioritize-full' as const,
};
const roadmap = {
  id: 'roadmap',
  version: 4,
  definition: { revision: 2, crossProject: candidate },
} as Roadmap;
const impact = {
  digest: 'a'.repeat(64),
  candidate,
  queued: [],
  blockers: [],
  warnings: ['Approval never transfers.'],
  changes: [],
  bindings: [],
  attempts: [],
  evidence: [{ id: 'receipt', sourceId: 'WI-01', kind: 'parent', applicability: 'reassess' }],
  integrations: [
    {
      sourceId: 'WI-01/core',
      sourceWorktreeId: 'tree',
      mergeSha: 'b'.repeat(40),
      eligible: true,
      reason: 'Code only, fresh review required.',
    },
  ],
};
const pending = {
  id: 'proposal',
  summary: 'Reconcile revised plan',
  candidate,
  baseRevision: 2,
  createdAt: '2026-09-16',
  createdByUserId: 'owner',
  workspaceId: 'workspace',
  roadmapId: 'roadmap',
};
const view = {
  history: [pending],
  pendingImpact: impact,
  candidates: [
    { ...candidate, label: 'Map revision 2', targets: [{ id: 'FULL', scope: 'Whole plan' }] },
  ],
};
function setup(canMutate = true, blockers: string[] = []) {
  vi.mocked(request).mockImplementation(async (url) =>
    url.endsWith('/finalization-readiness')
      ? {
          projects: [
            {
              alias: 'wi',
              projectId: 'project',
              planVersionId: 'plan',
              accepted: 2,
              total: 4,
              status: 'blocked',
              blockers: ['Full original plan requires acceptance.'],
              integrationBranch: 'wi-revision',
            },
          ],
        }
      : { ...view, pendingImpact: { ...impact, blockers } },
  );
  render(
    <MapAmendmentPanel
      workspaceId={asWorkspaceId('workspace')}
      roadmap={roadmap}
      csrfToken="csrf"
      canMutate={canMutate}
    />,
  );
}
it('shows pending impact, keeps reuse opt-in and submits the reviewed digest with rationale', async () => {
  setup();
  await screen.findByText('Code only, fresh review required.', { exact: false });
  expect(
    (screen.getByRole('button', { name: 'Apply reviewed amendment' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Decision rationale'), {
    target: { value: 'Reviewed revised requirements.' },
  });
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed amendment' }));
  await waitFor(() =>
    expect(vi.mocked(request).mock.calls.some(([url]) => url.endsWith('/decision'))).toBe(true),
  );
  const call = vi.mocked(request).mock.calls.find(([url]) => url.endsWith('/decision'))!;
  expect(JSON.parse(String(call[2]?.body))).toEqual({
    amendmentId: 'proposal',
    outcome: 'apply',
    impactDigest: impact.digest,
    rationale: 'Reviewed revised requirements.',
    reuseIntegrationIds: ['WI-01/core'],
  });
  expect(screen.getByText('2 / 4 original parents accepted · wi-revision')).toBeTruthy();
});
it('allows rejection while active work blocks apply, with no code reuse on rejection', async () => {
  setup(true, ['Wait for current run.']);
  await screen.findByText('Wait for current run.');
  fireEvent.change(screen.getByLabelText('Decision rationale'), {
    target: { value: 'Keep current roadmap.' },
  });
  expect(
    (screen.getByRole('button', { name: 'Apply reviewed amendment' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reject proposal' }));
  await waitFor(() =>
    expect(vi.mocked(request).mock.calls.some(([url]) => url.endsWith('/decision'))).toBe(true),
  );
  expect(
    JSON.parse(
      String(vi.mocked(request).mock.calls.find(([url]) => url.endsWith('/decision'))![2]?.body),
    ).reuseIntegrationIds,
  ).toEqual([]);
});
