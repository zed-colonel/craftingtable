import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CheckpointEvidence } from './CheckpointEvidence.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const definitionId = '12345678-1234-4234-8234-123456789abc';
const base = `/api/workspaces/ws/concurrency-definitions/${definitionId}/runtime`;
const submission = (id: string, sourceId: string, createdAt = '2026-10-08T00:00:00Z') => ({
  id,
  createdAt,
  subject: { kind: 'checkpoint', sourceId },
  environmentId: 'local',
  executedAt: '2026-10-08T00:00:00Z',
  executedBy: 'author',
  reviewers: [{ identity: 'reviewer', roles: ['independent-reviewer'] }],
  artifacts: [{ name: `${id}-log`, digest: 'e'.repeat(64), bytes: 3 }],
});
const subject = (sourceId: string) => ({
  subject: { kind: 'checkpoint', sourceId },
  title: `${sourceId} title`,
  profile: 'qualified',
  requirements: [`${sourceId} requirement`],
  reviewerRoles: ['independent-reviewer'],
  testedRepositories: [],
  cases: [],
  issues: [],
});
const view = {
  issues: [],
  builds: [],
  bindingRevision: 1,
  current: { id: definitionId, generation: 1, pins: [], consumers: [], environments: [] },
  history: [],
  repositories: [],
  upstreamHistory: [],
  subjects: [subject('QUALIFIED'), subject('OTHER')],
  submissions: [
    { submission: submission('older', 'QUALIFIED', '2026-10-07T00:00:00Z'), issues: [] },
    { submission: submission('mine', 'QUALIFIED'), issues: [] },
    { submission: submission('theirs', 'OTHER'), issues: [] },
  ],
} as unknown as RuntimeEvidenceView;

it("renders only its checkpoint's requirements and submissions, opened for review (R-A6 rest)", async () => {
  vi.mocked(request).mockImplementation(async (url) => ({
    ...submission('mine', 'QUALIFIED'),
    artifacts: [{ name: 'mine-log', digest: 'e'.repeat(64), content: 'Passed.' }],
    url,
  }));
  render(
    <CheckpointEvidence
      workspaceId={asWorkspaceId('ws')}
      definitionId={definitionId}
      base={base}
      view={view}
      checkpointId="QUALIFIED"
      csrfToken="csrf"
      canMutate
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getAllByText('QUALIFIED requirement').length).toBeGreaterThan(0);
  expect(screen.queryByText('OTHER requirement')).toBeNull();
  expect(screen.queryByText('theirs-log')).toBeNull();
  await screen.findByText('Passed.');
  // Only the newest undecided one is read at once; the older waits to be opened (review L7).
  expect(vi.mocked(request).mock.calls.map(([url]) => url)).toEqual([`${base}/submissions/mine`]);
  expect(screen.getByText('older-log')).toBeDefined();
});

it('submits evidence for its own checkpoint, its template already chosen', async () => {
  render(
    <CheckpointEvidence
      workspaceId={asWorkspaceId('ws')}
      definitionId={definitionId}
      base={base}
      view={{ ...view, submissions: [] }}
      checkpointId="QUALIFIED"
      csrfToken="csrf"
      canMutate
      onChanged={vi.fn()}
    />,
  );
  screen.getByText('No evidence has been submitted for this checkpoint.');
  fireEvent.click(screen.getByRole('button', { name: 'Prepare evidence template' }));
  const template = JSON.parse(
    (screen.getByLabelText('Evidence package') as HTMLTextAreaElement).value,
  );
  expect(template.subject).toEqual({ kind: 'checkpoint', sourceId: 'QUALIFIED' });
  vi.mocked(request).mockResolvedValue(view);
  fireEvent.change(screen.getByLabelText('Evidence package'), {
    target: {
      value: JSON.stringify({
        ...template,
        environmentId: 'local',
        executedBy: 'me',
        reviewers: [{ identity: 'reviewer', roles: ['independent-reviewer'], artifact: 'log' }],
        requirements: [{ requirement: 'QUALIFIED requirement', artifact: 'log' }],
        artifacts: [{ name: 'log', content: 'Passed.' }],
      }),
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Submit evidence for review' }));
  await waitFor(() =>
    expect(request, screen.queryByRole('alert')?.textContent ?? '').toHaveBeenCalled(),
  );
  expect(vi.mocked(request).mock.calls[0]![0]).toBe(`${base}/submit`);
});
