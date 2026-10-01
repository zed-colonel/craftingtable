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

/**
 * The daemon's answers in order, with the receipts read (made beside the checks read) answered
 * on its own.
 */
function respond(answers: unknown[], receipts: unknown = { repositoryId, runs: [] }) {
  vi.mocked(request).mockImplementation(async (url: string) =>
    url.endsWith('/checks/receipts') ? receipts : answers.shift(),
  );
}
/** The requests other than the receipts read. */
const calls = () =>
  vi.mocked(request).mock.calls.filter(([url]) => !String(url).endsWith('/checks/receipts'));

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
  respond([
    { repositoryId, declarations: [] },
    {
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
      branches: [],
    },
    { repositoryId, declarations: [declaration(1)] },
  ]);
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
  expect(calls()[1]![0]).toBe(`/api/workspaces/ws-1/repositories/${repositoryId}/checks/preview`);
  expect(JSON.parse(String(calls()[1]![2]!.body))).toEqual({ ref: 'main' });
  const adopt = screen.getByRole('button', { name: 'Adopt checks at bbbbbbbbbb' });
  // Adoption records why.
  expect(adopt.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Why these checks'), {
    target: { value: 'The project suite.' },
  });
  fireEvent.click(adopt);
  await screen.findByRole('table', { name: 'Adopted checks for wi' });
  // The commit the operator reviewed is the one adopted; a moved ref is refused by the daemon.
  expect(JSON.parse(String(calls()[2]![2]!.body))).toEqual({
    ref: 'main',
    expectedCommit: commit,
    rationale: 'The project suite.',
  });
  expect(screen.getByText(/Version 1, adopted from bbbbbbbbbb/)).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Proposed checks for wi' })).toBeNull();
});

it('shows why a proposal cannot be adopted and offers no adoption (R-G13)', async () => {
  respond([
    { repositoryId, declarations: [declaration(2), declaration(1)] },
    {
      ref: 'agent',
      commitSha: commit,
      sourcePath: '.craftingtable/checks.json',
      checks: [],
      definitionDigests: {},
      definitions: [],
      issues: ['.craftingtable/checks.json is not JSON.'],
      warnings: [],
      branches: [],
    },
  ]);
  renderPanel();
  await screen.findByText(/Version 2, adopted from/);
  expect(screen.getByText('Adoption history (2)')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Branch or commit/), { target: { value: 'agent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review checks file' }));
  expect(await screen.findByText('.craftingtable/checks.json is not JSON.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Adopt checks/ })).toBeNull();
});

it('lets a viewer read adopted checks without review controls (R-G13)', async () => {
  respond([{ repositoryId, declarations: [declaration(1)] }]);
  renderPanel(false);
  await waitFor(() => screen.getByRole('table', { name: 'Adopted checks for wi' }));
  expect(screen.queryByRole('button', { name: 'Review checks file' })).toBeNull();
  expect(document.getElementById(`repository-checks-${repositoryId}`)).toBeTruthy();
});

it('shows each adoption and how it was made, and the recent check runs with who asked (R-G13 increment 5)', async () => {
  const atMerge = {
    ...declaration(2),
    sourceCommit: 'd'.repeat(40),
    checks: [
      ...checks,
      {
        id: 'isolation',
        argv: ['scripts/isolation.py'],
        definitionPaths: ['scripts/isolation.py'],
      },
    ],
    definitionDigests: {
      'scripts/check.sh': 'c'.repeat(64),
      'scripts/isolation.py': 'e'.repeat(64),
    },
    rationale: 'The slice adds its isolation check.',
    adoptedAtMerge: {
      operationId: '33333333-3333-4333-8333-333333333333',
      worktreeId: 'wt-1',
      reviewRunId: 'run-1',
    },
  };
  const receipt = {
    success: true,
    clean: true,
    headSha: 'f'.repeat(40),
  };
  respond([{ repositoryId, declarations: [atMerge, declaration(1)] }], {
    repositoryId,
    runs: [
      {
        runId: 'run-1',
        role: 'review',
        worktreeId: 'wt-1',
        status: 'finished',
        createdAt: '2026-09-30T00:00:00.000Z',
        recordedBy: 'daemon',
        declarationVersion: 1,
        receipts: [
          {
            ...receipt,
            kind: 'declared',
            checkId: 'tests',
            declarationVersion: 1,
            command: 'ct-check --declared tests',
            requestedBy: 'daemon',
            definitions: 'differ',
          },
          {
            ...receipt,
            kind: 'supplemental',
            command: 'cargo test -p one',
            requestedBy: 'agent',
            success: false,
          },
        ],
      },
      {
        runId: 'run-0',
        role: 'review',
        worktreeId: 'wt-0',
        status: 'finished',
        createdAt: '2026-09-20T00:00:00.000Z',
        recordedBy: 'run',
        receipts: [{ ...receipt, kind: 'supplemental', command: 'true', requestedBy: 'unknown' }],
      },
    ],
  });
  renderPanel(false);
  const history = (await screen.findByText('Adoption history (2)')).closest('details')!;
  expect(history.textContent).toContain(
    'from dddddddddd, adopted by approving the merge that changed them: added isolation, new scripts/isolation.py. Why: The slice adds its isolation check.',
  );
  expect(history.textContent).toContain('adopted on this page: first adoption.');
  const table = await screen.findByRole('table', { name: 'Recent check runs' });
  const rows = table.querySelectorAll('tbody tr');
  expect(rows[0]!.textContent).toContain('Adopted check tests (version 1)');
  expect(rows[0]!.textContent).toContain('CraftingTable');
  expect(rows[0]!.textContent).toContain('Passed, with other definitions');
  expect(rows[1]!.textContent).toContain('Supplemental cargo test -p one');
  expect(rows[1]!.textContent).toContain('The agent');
  expect(rows[1]!.textContent).toContain('Failed');
  expect(rows[2]!.textContent).toContain('Unknown: the run wrote its own receipts');
});

it('labels a receipt a run wrote itself as self-reported (review F4)', async () => {
  respond([{ repositoryId, declarations: [declaration(1)] }], {
    repositoryId,
    runs: [
      {
        runId: 'run-0',
        role: 'review',
        worktreeId: 'wt-0',
        status: 'finished',
        createdAt: '2026-09-20T00:00:00.000Z',
        recordedBy: 'run',
        receipts: [
          {
            kind: 'self-reported',
            command: 'true',
            requestedBy: 'unknown',
            success: true,
            clean: true,
            headSha: 'f'.repeat(40),
          },
        ],
      },
    ],
  });
  renderPanel(false);
  const table = await screen.findByRole('table', { name: 'Recent check runs' });
  expect(table.textContent).toContain('Self-reported true');
});
