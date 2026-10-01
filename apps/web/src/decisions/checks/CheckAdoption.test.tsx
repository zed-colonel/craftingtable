import type { SourceRepositorySummary } from '@craftingtable/contracts';
import { asWorkspaceId, type WorktreeId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CheckAdoption } from './CheckAdoption.js';

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
const adopted = 'c'.repeat(64);
const declaration = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'ws-1',
  repositoryId,
  version: 2,
  sourceCommit: 'b'.repeat(40),
  sourcePath: '.craftingtable/checks.json',
  checks: [
    { id: 'isolation', argv: ['scripts/isolation.py'], definitionPaths: ['scripts/isolation.py'] },
  ],
  definitionDigests: { 'scripts/isolation.py': adopted },
  rationale: 'The project suite.',
  adoptedByUserId: 'user-1',
  adoptedAt: '2026-09-30T07:12:00.000Z',
};
const diagnosis = (sliceChanged: string[], head: string) => ({
  repositoryId,
  declaration: { id: declaration.id, version: 2, sourceCommit: declaration.sourceCommit },
  headSha: 'e'.repeat(40),
  targetBranch: 'wi-fabric-2',
  targetSha: 'f'.repeat(40),
  baseSha: 'f'.repeat(40),
  paths: [
    {
      path: '.craftingtable/checks.json',
      adopted: 'd'.repeat(64),
      head: 'd'.repeat(64),
      base: 'd'.repeat(64),
      target: 'd'.repeat(64),
    },
    {
      path: 'scripts/isolation.py',
      adopted,
      head,
      base: sliceChanged.length ? '9'.repeat(64) : head,
      target: '9'.repeat(64) === head ? head : sliceChanged.length ? '9'.repeat(64) : head,
    },
  ],
  sliceChanged,
  targetDiffers: sliceChanged.length ? [] : ['scripts/isolation.py'],
});

function respond(answers: Record<string, unknown>) {
  vi.mocked(request).mockImplementation(async (url: string, _schema, init) => {
    for (const [suffix, answer] of Object.entries(answers))
      if (url.endsWith(suffix)) return typeof answer === 'function' ? answer(init) : answer;
    throw new Error(`unexpected ${url}`);
  });
}

it('says the slice did not change a definition behind its adoption, and adopts from the integration branch in the item (LIVE-30)', async () => {
  const onAdopted = vi.fn();
  respond({
    '/checks': { repositoryId, declarations: [declaration] },
    '/check-definitions': diagnosis([], '8'.repeat(64)),
    '/checks/preview': {
      ref: 'wi-fabric-2',
      commitSha: '7'.repeat(40),
      sourcePath: '.craftingtable/checks.json',
      checks: declaration.checks,
      definitionDigests: { 'scripts/isolation.py': '8'.repeat(64) },
      definitions: [
        {
          path: 'scripts/isolation.py',
          digest: '8'.repeat(64),
          bytes: 12,
          text: '\uFEFFcheck()\n',
          previous: { path: 'scripts/isolation.py', digest: adopted, bytes: 8, text: 'check()\n' },
        },
      ],
      issues: [],
      warnings: [],
      branches: [],
    },
    '/checks/adopt': { repositoryId, declarations: [{ ...declaration, version: 3 }, declaration] },
  });
  render(
    <CheckAdoption
      workspaceId={asWorkspaceId('ws-1')}
      repository={repository}
      worktreeId={'wt-1' as WorktreeId}
      csrfToken="csrf"
      editable
      onAdopted={onAdopted}
    />,
  );
  const table = await screen.findByRole('table', {
    name: 'Definitions that differ from the adoption',
  });
  expect(within(table).getByText('scripts/isolation.py')).toBeDefined();
  expect(table.textContent).toContain('wi-fabric-2, before this slice: the adoption is behind it');
  const ref = screen.getByLabelText(
    'Branch or commit to read the checks file from',
  ) as HTMLInputElement;
  expect(ref.value).toBe('wi-fabric-2');
  fireEvent.click(screen.getByRole('button', { name: 'Review checks file' }));
  // The page shows each changed definition against the adopted text, and commands exactly.
  expect((await screen.findByLabelText('Changes to scripts/isolation.py')).textContent).toBe(
    '- check()\n+ ⟦U+FEFF⟧check()\n  \n',
  );
  expect(screen.getByRole('table', { name: 'Proposed checks for wi' }).textContent).toContain(
    '["scripts/isolation.py"]',
  );
  fireEvent.change(await screen.findByLabelText('Why these checks'), {
    target: { value: 'WI-05 extended the isolation check.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Adopt checks at 7777777777' }));
  await vi.waitFor(() => expect(onAdopted).toHaveBeenCalled());
  const adopt = vi
    .mocked(request)
    .mock.calls.find(([url]) => String(url).endsWith('/checks/adopt'))!;
  expect(JSON.parse(String(adopt[2]!.body))).toEqual({
    ref: 'wi-fabric-2',
    expectedCommit: '7'.repeat(40),
    rationale: 'WI-05 extended the isolation check.',
  });
});

it("offers the slice's own commit when only the slice changed a definition", async () => {
  respond({
    '/checks': { repositoryId, declarations: [declaration] },
    '/check-definitions': diagnosis(['scripts/isolation.py'], '6'.repeat(64)),
  });
  render(
    <CheckAdoption
      workspaceId={asWorkspaceId('ws-1')}
      repository={repository}
      worktreeId={'wt-1' as WorktreeId}
      csrfToken="csrf"
      editable
      onAdopted={vi.fn()}
    />,
  );
  const table = await screen.findByRole('table', {
    name: 'Definitions that differ from the adoption',
  });
  expect(table.textContent).toContain('this slice');
  expect(
    (screen.getByLabelText('Branch or commit to read the checks file from') as HTMLInputElement)
      .value,
  ).toBe('e'.repeat(40));
});

it('adopts first checks from the integration branch for an undeclared repository', async () => {
  respond({ '/checks': { repositoryId, declarations: [] } });
  render(
    <CheckAdoption
      workspaceId={asWorkspaceId('ws-1')}
      repository={repository}
      integrationBranch="wi-fabric-2"
      csrfToken="csrf"
      editable
      onAdopted={vi.fn()}
    />,
  );
  expect(await screen.findByText('No adopted checks yet.')).toBeDefined();
  expect(
    (screen.getByLabelText('Branch or commit to read the checks file from') as HTMLInputElement)
      .value,
  ).toBe('wi-fabric-2');
});
