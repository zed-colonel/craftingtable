import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SourceRepositorySummary } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { RepositoryChecksPanel } from './RepositoryChecksPanel.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const repositoryId = '11111111-1111-4111-8111-111111111111';
const repository = {
  id: repositoryId,
  displayName: 'wi',
  rootPath: '/home/user/src/wi',
  defaultBranch: 'main',
  registeredHeadSha: 'a'.repeat(40),
  registeredAt: '2026-09-01T00:00:00.000Z',
  status: 'active',
} as unknown as SourceRepositorySummary;
const checks = [
  { id: 'tests', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] },
  { id: 'format', argv: ['cargo', 'fmt', '--check'], definitionPaths: [] },
];
const commit = 'b'.repeat(40);
const declaration = (version: number) => ({
  id: `2222222${version}-2222-4222-8222-222222222222`,
  workspaceId: 'ws-1',
  repositoryId,
  version,
  sourceCommit: commit,
  sourcePath: '.craftingtable/checks.json',
  checks,
  definitionDigests: { 'scripts/check.sh': 'c'.repeat(64) },
  rationale: 'The project suite.',
  adoptedByUserId: 'user-1',
  adoptedAt: '2026-09-29T00:00:00.000Z',
});

function renderPanel(editable = true) {
  return render(
    <RepositoryChecksPanel
      workspaceId={asWorkspaceId('ws-1')}
      repository={repository}
      csrfToken="csrf"
      editable={editable}
      refreshToken={0}
    />,
  );
}

it('says scoped reviews stop until checks are adopted, then reviews and adopts the file at the commit the daemon read (R-G13)', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({ repositoryId, declarations: [] })
    .mockResolvedValueOnce({
      ref: 'main',
      commitSha: commit,
      sourcePath: '.craftingtable/checks.json',
      checks,
      definitionDigests: {},
      definitions: [
        {
          path: 'scripts/check.sh',
          digest: 'c'.repeat(64),
          bytes: 26,
          text: '#!/bin/sh\ncargo test --all\n',
          truncated: false,
        },
      ],
      issues: [],
      warnings: ['Check format runs cargo from PATH and names no definition files.'],
    })
    .mockResolvedValueOnce({ repositoryId, declarations: [declaration(1)] });
  renderPanel();
  expect(
    await screen.findByText(/No adopted checks\. Scoped reviews in this repository stop/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review checks file' }));
  const proposed = await screen.findByRole('table', { name: 'Proposed checks for wi' });
  expect(proposed.textContent).toContain('cargo fmt --check');
  // What each definition file holds, and a warning that does not block adoption.
  expect(screen.getByText(/cargo test --all/)).toBeTruthy();
  expect(screen.getByText(/scripts\/check\.sh/, { selector: 'code' })).toBeTruthy();
  expect(screen.getByText(/\(26 bytes, new\)/)).toBeTruthy();
  expect(screen.getByRole('note').textContent).toContain('names no definition files');
  expect(vi.mocked(request).mock.calls[1]![0]).toBe(
    `/api/workspaces/ws-1/repositories/${repositoryId}/checks/preview`,
  );
  expect(JSON.parse(String(vi.mocked(request).mock.calls[1]![2]!.body))).toEqual({ ref: 'main' });
  const adopt = screen.getByRole('button', { name: 'Adopt checks at bbbbbbbbbb' });
  // Adoption records why.
  expect(adopt.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Why these checks'), {
    target: { value: 'The project suite.' },
  });
  fireEvent.click(adopt);
  await screen.findByRole('table', { name: 'Adopted checks for wi' });
  // The commit the operator reviewed is the one adopted; a moved ref is refused by the daemon.
  expect(JSON.parse(String(vi.mocked(request).mock.calls[2]![2]!.body))).toEqual({
    ref: 'main',
    expectedCommit: commit,
    rationale: 'The project suite.',
  });
  expect(screen.getByText(/Version 1, adopted from bbbbbbbbbb/)).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Proposed checks for wi' })).toBeNull();
});

it('shows why a proposal cannot be adopted and offers no adoption (R-G13)', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({ repositoryId, declarations: [declaration(2), declaration(1)] })
    .mockResolvedValueOnce({
      ref: 'agent',
      commitSha: commit,
      sourcePath: '.craftingtable/checks.json',
      checks: [],
      definitionDigests: {},
      definitions: [],
      issues: ['.craftingtable/checks.json is not JSON.'],
      warnings: [],
    });
  renderPanel();
  await screen.findByText(/Version 2, adopted from/);
  expect(screen.getByText('Earlier versions (1)')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Branch or commit/), { target: { value: 'agent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review checks file' }));
  expect(await screen.findByText('.craftingtable/checks.json is not JSON.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Adopt checks/ })).toBeNull();
});

it('lets a viewer read adopted checks without review controls (R-G13)', async () => {
  vi.mocked(request).mockResolvedValueOnce({ repositoryId, declarations: [declaration(1)] });
  renderPanel(false);
  await waitFor(() => screen.getByRole('table', { name: 'Adopted checks for wi' }));
  expect(screen.queryByRole('button', { name: 'Review checks file' })).toBeNull();
  expect(document.getElementById(`repository-checks-${repositoryId}`)).toBeTruthy();
});
