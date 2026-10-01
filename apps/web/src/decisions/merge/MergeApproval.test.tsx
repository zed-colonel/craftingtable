import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentRunSummary, MergeGate, WorktreeSummary } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { MergeApproval, RetryMergeCleanup } from './MergeApproval.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn(), ApiError: class extends Error {} }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const worktree = {
  id: 'wt-1',
  workspaceId: 'ws-1',
  repositoryId: 'repo-1',
  workItemId: 'item-1',
  branchName: 'ct/wi-03-domain',
  baseBranch: 'wi-fabric-2',
  baseSha: 'b'.repeat(40),
  integrationBranch: 'wi-fabric-2',
  path: '/tmp/wt-1',
  status: 'active',
  createdAt: '2026-09-30T00:00:00.000Z',
  version: 1,
} as unknown as WorktreeSummary;
const digest = 'd'.repeat(64);
const diagnosis = (issues: string[] = []) => ({
  repositoryId: 'repo-1',
  declaration: {
    id: '22222222-2222-4222-8222-222222222222',
    version: 2,
    sourceCommit: 'c'.repeat(40),
  },
  headSha: 'e'.repeat(40),
  targetBranch: 'wi-fabric-2',
  targetSha: 'f'.repeat(40),
  baseSha: 'f'.repeat(40),
  paths: [],
  sliceChanged: ['scripts/check.sh'],
  targetDiffers: [],
  merge: {
    tree: '1'.repeat(40),
    proposalDigest: digest,
    unchanged: false,
    proposedChecks: [
      { id: 'tests', argv: ['scripts/check.sh'], definitionPaths: ['scripts/check.sh'] },
      {
        id: 'isolation',
        argv: ['scripts/isolation.py'],
        definitionPaths: ['scripts/isolation.py'],
      },
    ],
    checks: [{ id: 'isolation', change: 'added' }],
    definitions: [
      {
        path: 'scripts/check.sh',
        adopted: {
          path: 'scripts/check.sh',
          digest: '3'.repeat(64),
          bytes: 10,
          text: 'run\nold\n',
        },
        proposed: {
          path: 'scripts/check.sh',
          digest: '4'.repeat(64),
          bytes: 10,
          text: 'run\nnew\n',
        },
      },
    ],
    issues,
  },
});

const adoptionGate: MergeGate = {
  mergeable: true,
  reason: 'check-adoption',
  reviewRunId: 'run-1' as AgentRunSummary['id'],
};
const merged = {
  worktree: { ...worktree, status: 'removed' },
  mergeSha: '5'.repeat(40),
  targetBranch: 'wi-fabric-2',
  createdTarget: false,
  workItemCompleted: false,
};

/**
 * The daemon's answers by route: the branches read, the definitions read, and the merge, whose
 * request bodies are kept.
 */
function respond(definitions: unknown) {
  vi.mocked(request).mockImplementation(async (url: string) => {
    if (url.endsWith('/branches')) return { branches: ['aq-cont-1', 'main'], checkedOut: 'main' };
    if (url.endsWith('/check-definitions')) return definitions;
    if (url.endsWith('/merge')) return merged;
    throw new Error(`unexpected ${url}`);
  });
}
const posted = () =>
  vi
    .mocked(request)
    .mock.calls.filter(([url]) => String(url).endsWith('/merge'))
    .map(([url, , init]) => ({ url, body: JSON.parse(String(init!.body)) }));

function renderPanel(onMerged = vi.fn(), gate: MergeGate = adoptionGate, tree = worktree) {
  render(
    <MergeApproval
      workspaceId={asWorkspaceId('ws-1')}
      worktree={tree}
      gate={gate}
      csrfToken="csrf"
      disabled={false}
      onMerged={onMerged}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
  return screen.getByRole('form', { name: 'Merge target' });
}

it('merges into a chosen target only when the daemon reports the gate open (R-A6)', async () => {
  respond(undefined);
  const onMerged = vi.fn();
  const manual = { ...worktree, integrationBranch: undefined } as unknown as WorktreeSummary;
  const { container } = render(
    <MergeApproval
      workspaceId={asWorkspaceId('ws-1')}
      worktree={manual}
      gate={{ mergeable: false, reason: 'no-review' }}
      csrfToken="csrf"
      disabled={false}
      onMerged={onMerged}
    />,
  );
  expect(container.textContent).toBe('');
  cleanup();
  const form = renderPanel(onMerged, { mergeable: true, reason: 'ready' }, manual);
  const input = within(form).getByLabelText('Merge into') as HTMLInputElement;
  expect(input.value).toBe('wi-fabric-2');
  fireEvent.change(input, { target: { value: 'aq-cont-1' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Merge' }));
  await waitFor(() => expect(onMerged).toHaveBeenCalledWith('wt-1'));
  expect(posted()).toEqual([
    { url: '/api/workspaces/ws-1/worktrees/wt-1/merge', body: { targetBranch: 'aq-cont-1' } },
  ]);
});

it('retries a failed cleanup with the same command', async () => {
  respond(undefined);
  const onDone = vi.fn();
  render(
    <RetryMergeCleanup
      workspaceId={asWorkspaceId('ws-1')}
      worktree={{ ...worktree, mergeCleanupError: 'busy' } as WorktreeSummary}
      csrfToken="csrf"
      disabled={false}
      onDone={onDone}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry worktree cleanup' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('wt-1'));
  expect(posted()[0]!.body).toEqual({ targetBranch: 'wi-fabric-2' });
});

it('shows the definitions a merge adopts and merges only with a rationale, naming what was shown (R-G13 increment 5)', async () => {
  respond(diagnosis());
  const onMerged = vi.fn();
  const form = renderPanel(onMerged);
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(within(review).getByText(/adopts these checks as version 3/)).toBeDefined();
  expect(
    within(review).getByRole('group', { name: 'Check isolation added' }).textContent,
  ).toContain('["scripts/isolation.py"]');
  const diff = within(review).getByLabelText('Changes to scripts/check.sh');
  expect(diff.textContent).toBe('  run\n- old\n+ new\n  \n');
  const submit = within(form).getByRole('button', { name: 'Merge and adopt checks' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(review).getByLabelText('Why adopt these definitions'), {
    target: { value: 'The slice adds its isolation check.' },
  });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(onMerged).toHaveBeenCalledWith('wt-1'));
  expect(posted()[0]!.body).toEqual({
    targetBranch: 'wi-fabric-2',
    adoptChecks: {
      proposalDigest: digest,
      rationale: 'The slice adds its isolation check.',
      declarationId: '22222222-2222-4222-8222-222222222222',
    },
  });
});

it('offers no merge when the daemon says the merge cannot adopt its checks', async () => {
  respond(diagnosis(['.craftingtable/checks.json is not JSON.']));
  const form = renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(within(review).getByText('.craftingtable/checks.json is not JSON.')).toBeDefined();
  expect(within(review).queryByLabelText('Why adopt these definitions')).toBeNull();
  expect(
    (within(form).getByRole('button', { name: 'Merge and adopt checks' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it('shows a changed check as it is adopted and as the merge adopts it, exactly (review F2)', async () => {
  const strict = ['sh', '-c', 'scripts/check.sh --strict'];
  const weakened = ['sh', '-c', 'scripts/check.sh', '--strict'];
  respond({
    ...diagnosis(),
    merge: {
      ...diagnosis().merge,
      adoptedChecks: [{ id: 'tests', argv: strict, definitionPaths: ['scripts/check.sh'] }],
      proposedChecks: [{ id: 'tests', argv: weakened, definitionPaths: [] }],
      checks: [{ id: 'tests', change: 'changed' }],
      definitions: [],
    },
  });
  renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  const change = within(review).getByRole('group', { name: 'Check tests changed' });
  expect(change.textContent).toContain(JSON.stringify(strict));
  expect(change.textContent).toContain(JSON.stringify(weakened));
  expect(change.textContent).toContain('scripts/check.sh');
  expect(change.textContent).toContain('none');
});

it('says when a definition is shown only in part (review F1)', async () => {
  const shortened = diagnosis([
    'scripts/check.sh is not short UTF-8 text, so it cannot be shown in full',
  ]);
  shortened.merge.definitions[0]!.proposed = {
    ...shortened.merge.definitions[0]!.proposed,
    truncated: true,
  } as never;
  respond(shortened);
  renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(within(review).getByText(/Shown only in part/)).toBeDefined();
  // A part is never diffed against a whole: the diff would show the cut as a change.
  expect(within(review).queryByLabelText('Changes to scripts/check.sh')).toBeNull();
});

it('shows characters that render as nothing, paths exactly, and when the adopted text is gone (verification)', async () => {
  const base = diagnosis();
  respond({
    ...base,
    merge: {
      ...base.merge,
      adoptedChecks: [
        { id: 'tests', argv: ['make'], definitionPaths: ['Makefile', 'mk/rules.mk'] },
      ],
      proposedChecks: [{ id: 'tests', argv: ['make'], definitionPaths: ['Makefile, mk/rules.mk'] }],
      checks: [{ id: 'tests', change: 'changed' }],
      definitions: [
        {
          path: 'scripts/check.sh',
          adopted: {
            path: 'scripts/check.sh',
            digest: '3'.repeat(64),
            bytes: 20,
            text: '#!/bin/sh -e\nfalse\n',
          },
          proposed: {
            path: 'scripts/check.sh',
            digest: '4'.repeat(64),
            bytes: 23,
            text: '\uFEFF#!/bin/sh -e\nfalse\n',
          },
        },
        {
          path: 'scripts/gone.sh',
          adopted: { path: 'scripts/gone.sh', digest: '5'.repeat(64), bytes: 0 },
          proposed: { path: 'scripts/gone.sh', digest: '6'.repeat(64), bytes: 4, text: 'new\n' },
        },
      ],
    },
  });
  renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(within(review).getByLabelText('Changes to scripts/check.sh').textContent).toContain(
    '+ ⟦U+FEFF⟧#!/bin/sh -e',
  );
  expect(within(review).getByText(/holds characters outside plain ASCII/)).toBeDefined();
  const change = within(review).getByRole('group', { name: 'Check tests changed' });
  expect(change.textContent).toContain('["Makefile","mk/rules.mk"]');
  expect(change.textContent).toContain('["Makefile, mk/rules.mk"]');
  expect(within(review).getByText(/The adopted text cannot be shown/)).toBeDefined();
});

it('marks characters outside plain ASCII in commands, paths and whole texts, and shows the warnings (second verification)', async () => {
  const base = diagnosis();
  respond({
    ...base,
    merge: {
      ...base.merge,
      adoptedChecks: [{ id: 'tests', argv: ['grep', 'TODO'], definitionPaths: [] }],
      proposedChecks: [{ id: 'tests', argv: ['grep', 'TODO\u{E0020}'], definitionPaths: [] }],
      checks: [{ id: 'tests', change: 'changed' }],
      definitions: [
        {
          path: 'scripts/tеst.sh',
          adopted: { path: 'scripts/tеst.sh', digest: '7'.repeat(64), bytes: 0 },
          proposed: {
            path: 'scripts/tеst.sh',
            digest: '8'.repeat(64),
            bytes: 9,
            text: 'exit 0\n',
          },
        },
        {
          path: 'scripts/long.sh',
          adopted: {
            path: 'scripts/long.sh',
            digest: '1'.repeat(64),
            bytes: 9,
            text: 'set​-e\n',
            truncated: true,
          },
          proposed: { path: 'scripts/long.sh', digest: '2'.repeat(64), bytes: 9, text: 'set -e\n' },
        },
      ],
      warnings: ['Check tests runs grep from PATH and names no definition files.'],
    },
  });
  renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  const text = review.textContent ?? '';
  expect(text).toContain('["grep","TODO⟦U+E0020⟧"]');
  expect(text).toContain('scripts/t⟦U+0435⟧st.sh');
  expect(text).toContain('exit⟦U+00A0⟧0');
  expect(text).toContain('set⟦U+200B⟧-e');
  expect(within(review).getByRole('note').textContent).toContain('names no definition files');
});

it('shows tabs, trailing spaces and spacing in commands, says when only whitespace differs, and when the diff was skipped (third verification)', async () => {
  const base = diagnosis();
  const long = (tag: string) => Array.from({ length: 2100 }, (_, i) => `${tag} ${i}`).join('\n');
  respond({
    ...base,
    merge: {
      ...base.merge,
      adoptedChecks: [{ id: 'tests', argv: ['grep', 'TODO FIXME'], definitionPaths: [] }],
      proposedChecks: [{ id: 'tests', argv: ['grep', 'TODO  FIXME'], definitionPaths: [] }],
      checks: [{ id: 'tests', change: 'changed' }],
      definitions: [
        {
          path: 'scripts/heredoc.sh',
          adopted: {
            path: 'scripts/heredoc.sh',
            digest: '1'.repeat(64),
            bytes: 9,
            text: 'cat <<-EOF\n\tEOF\n',
          },
          proposed: {
            path: 'scripts/heredoc.sh',
            digest: '2'.repeat(64),
            bytes: 9,
            text: 'cat <<-EOF\n      EOF\n',
          },
        },
        {
          path: 'Makefile',
          adopted: { path: 'Makefile', digest: '3'.repeat(64), bytes: 9, text: long('old') },
          proposed: { path: 'Makefile', digest: '4'.repeat(64), bytes: 9, text: long('new') },
        },
      ],
      issues: ['defs/bеd.sh holds U+0435'],
    },
  });
  renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(within(review).getByLabelText('Changes to scripts/heredoc.sh').textContent).toBe(
    '  cat <<-EOF\n- →\tEOF\n+       EOF\n  \n',
  );
  expect(within(review).getByText(/differ only in spaces, tabs or line ends/)).toBeDefined();
  expect(within(review).getByText(/Too long to compare line by line here/)).toBeDefined();
  const change = within(review).getByRole('group', { name: 'Check tests changed' });
  for (const code of change.querySelectorAll('dd code'))
    expect(code.className).toContain('exact-text');
  expect(review.textContent).toContain('defs/b⟦U+0435⟧d.sh holds U+0435');
});
