import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  AgentRunSummary,
  SourceRepositorySummary,
  WorktreeSummary,
} from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { DelegationPanel } from './DelegationPanel.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn(), ApiError: class extends Error {} }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const repository = {
  id: 'repo-1',
  displayName: 'wi',
  rootPath: '/home/user/src/wi',
  defaultBranch: 'main',
  registeredHeadSha: 'a'.repeat(40),
  registeredAt: '2026-09-01T00:00:00.000Z',
  status: 'active',
} as unknown as SourceRepositorySummary;
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

function renderPanel(onMergeWorktree = vi.fn()) {
  render(
    <DelegationPanel
      workspaceId={asWorkspaceId('ws-1')}
      repositories={[repository]}
      worktrees={[worktree]}
      runs={[]}
      mergeGates={{
        'wt-1': {
          mergeable: true,
          reason: 'check-adoption',
          reviewRunId: 'run-1' as AgentRunSummary['id'],
        },
      }}
      backends={[]}
      itemCompleted={false}
      canMutate={true}
      busy={false}
      onCreateWorktree={vi.fn()}
      onRemoveWorktree={vi.fn()}
      onMergeWorktree={onMergeWorktree}
      onLoadBranches={vi.fn()}
      onLaunch={vi.fn()}
      onOpenRun={vi.fn()}
      onOpenDiff={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
  return screen.getByRole('form', { name: 'Merge target' });
}

it('shows the definitions a merge adopts and merges only with a rationale, naming what was shown (R-G13 increment 5)', async () => {
  vi.mocked(request).mockResolvedValueOnce(diagnosis());
  const onMergeWorktree = vi.fn();
  const form = renderPanel(onMergeWorktree);
  expect(screen.getByText('Merging adopts the check definitions this slice changes')).toBeDefined();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(vi.mocked(request).mock.calls[0]![0]).toBe(
    '/api/workspaces/ws-1/worktrees/wt-1/check-definitions',
  );
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
  expect(onMergeWorktree).toHaveBeenCalledWith('wt-1', 'wi-fabric-2', {
    proposalDigest: digest,
    rationale: 'The slice adds its isolation check.',
  });
});

it('offers no merge when the daemon says the merge cannot adopt its checks', async () => {
  vi.mocked(request).mockResolvedValueOnce(diagnosis(['.craftingtable/checks.json is not JSON.']));
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
  vi.mocked(request).mockResolvedValueOnce({
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
  vi.mocked(request).mockResolvedValueOnce(shortened);
  renderPanel();
  const review = await screen.findByRole('region', { name: 'Check definitions this merge adopts' });
  expect(within(review).getByText(/Shown only in part/)).toBeDefined();
});
