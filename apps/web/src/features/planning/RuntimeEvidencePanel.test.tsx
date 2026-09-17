import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { asWorkspaceId } from '@craftingtable/domain';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const runtimeId = '12345678-1234-4234-8234-123456789abc';
const current = {
  id: runtimeId,
  generation: 1,
  pins: [],
  consumers: [],
  environments: [
    {
      id: 'kata-host',
      kind: 'external-kata',
      identityDigest: 'a'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      toolchainDigest: 'c'.repeat(64),
      authorization: 'Operator authorized.',
    },
  ],
};
const submission = {
  id: 'evidence-1',
  subject: { kind: 'checkpoint', sourceId: 'QUALIFIED' },
  environmentId: 'kata-host',
  executedAt: '2026-09-16T00:00:00Z',
  executedBy: 'author',
  reviewers: [{ identity: 'reviewer', roles: ['independent-reviewer'] }],
  subjectCommit: 'd'.repeat(40),
  artifacts: [{ name: 'log', digest: 'e'.repeat(64), content: 'Actual Kata verification passed.' }],
};
function view(issues: string[] = []) {
  return {
    issues: [],
    builds: [],
    bindingRevision: 1,
    current,
    history: [],
    repositories: [],
    subjects: [
      {
        subject: submission.subject,
        title: 'Qualification',
        profile: 'qualified',
        requirements: ['Tests passed'],
        reviewerRoles: ['independent-reviewer'],
        testedRepositories: ['consumer'],
        cases: [{ id: 'CASE-1', sourceRecordDigest: 'f'.repeat(64), requiresKata: true }],
        issues: [],
      },
    ],
    upstreamHistory: [],
    submissions: [{ submission, issues }],
  };
}
it('renders readable artifacts and requires a rationale before accepting evidence', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce({
      ...view(),
      submissions: [
        {
          submission,
          issues: [],
          decision: { outcome: 'accepted', rationale: 'Inspected independent logs.' },
        },
      ],
    });
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  await screen.findByText('Actual Kata verification passed.');
  const accept = screen.getByRole('button', { name: 'Accept evidence', hidden: true });
  expect(accept.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Review decision rationale'), {
    target: { value: 'Inspected independent logs.' },
  });
  fireEvent.click(accept);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const init = vi.mocked(request).mock.calls[1]?.[2];
  expect(JSON.parse(String(init?.body))).toEqual({
    submissionId: 'evidence-1',
    outcome: 'accepted',
    rationale: 'Inspected independent logs.',
  });
  expect(init?.headers).toEqual({ 'x-craftingtable-csrf': 'csrf' });
});
it('shows stale evidence as blocked and generates a case-specific actual-Kata template', async () => {
  vi.mocked(request).mockResolvedValue(view(['The upstream pin changed.']));
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  await screen.findByText('The upstream pin changed.');
  fireEvent.change(screen.getByLabelText('Review decision rationale'), {
    target: { value: 'Still stale.' },
  });
  expect(
    screen.getByRole('button', { name: 'Accept evidence', hidden: true }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Evidence subject'), {
    target: { value: 'checkpoint:QUALIFIED' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare evidence template', hidden: true }));
  const text = screen.getByLabelText('Evidence package') as HTMLTextAreaElement;
  const template = JSON.parse(text.value);
  expect(template.runtimeId).toBe(runtimeId);
  expect(template.cases[0]).toMatchObject({ id: 'CASE-1', sourceRecordDigest: 'f'.repeat(64) });
  expect(template.kata.noNativeFallback).toBe(true);
});

it('discovers an editable draft, opens setup, and only persists after explicit save', async () => {
  const configuration = {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [
      {
        alias: 'aq',
        ref: 'main',
        expectedCommitSha: 'd'.repeat(40),
        conformanceRevision: '16',
        packages: [{ name: 'queue', path: '' }],
      },
    ],
    consumers: [{ alias: 'wi', upstreams: ['aq'] }],
    environments: [
      {
        ...current.environments[0],
        id: 'local',
        kind: 'local-development',
        discovery: {
          kind: 'local-discovery-v1',
          environment: 'Captured workstation',
          fixtures: 'Imported sources',
          toolchains: 'Observed Rust',
        },
      },
    ],
  };
  const initial = {
    ...view(),
    current: undefined,
    submissions: [],
    repositories: [
      {
        alias: 'aq',
        role: 'implemented_upstream',
        configured: true,
        integrationBranch: 'main',
        requiredUpstreams: [],
        conformanceRevision: '16',
      },
      {
        alias: 'wi',
        role: 'planned_application',
        configured: true,
        integrationBranch: 'revision',
        requiredUpstreams: ['aq'],
      },
    ],
  };
  vi.mocked(request)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ configuration, notes: ['Review this draft.'] })
    .mockResolvedValueOnce(view());
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set up dependencies' }));
  expect(
    screen.getByText('Configure pinned dependencies and environments').closest('details')?.open,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Discover local setup' }));
  await screen.findByText('Review this draft.');
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(request).mock.calls[1]?.[0]).toMatch(/\/discover$/);
  fireEvent.click(screen.getByText('Captured local fingerprint inputs'));
  expect(screen.getByText('Captured workstation')).toBeTruthy();
  expect((screen.getByLabelText('Environment SHA-256') as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText('aq · branch or commit'), {
    target: { value: 'other-branch' },
  });
  expect(
    screen.getByRole('button', { name: 'Save dependency environment' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText('Inspect or rediscover the changed refs before saving.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('aq · branch or commit'), { target: { value: 'main' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dependency environment' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(vi.mocked(request).mock.calls[2]?.[0]).toMatch(/\/configure$/);
});
