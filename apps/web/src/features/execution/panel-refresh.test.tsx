import type { SourceRepositorySummary, WorktreeSummary } from '@craftingtable/contracts';
import type { PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  loadPlanBranchSettings,
  loadRepositoryPolicy,
  loadWorktreeBranchStatus,
} from '../../lib/branch-api.js';
import {
  loadRepositories,
  loadRepositoryCheckReceipts,
  loadRepositoryChecks,
} from '../../lib/execution-api.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { PlanBranchPanel } from './PlanBranchPanel.js';
import { RepositoryChecksPanel } from './RepositoryChecksPanel.js';
import { WorktreeBranchPanel } from './WorktreeBranchPanel.js';

vi.mock('../../lib/branch-api.js', () => ({
  loadPlanBranchSettings: vi.fn(),
  loadRepositoryPolicy: vi.fn(),
  loadWorktreeBranchStatus: vi.fn(),
  changeWorktreeBranch: vi.fn(),
  recordIntegrationEvidence: vi.fn(),
  savePlanBranchSettings: vi.fn(),
  saveRepositoryPolicy: vi.fn(),
}));
vi.mock('../../lib/execution-api.js', () => ({
  loadRepositories: vi.fn(),
  loadRepositoryBranches: vi.fn(),
  loadRepositoryChecks: vi.fn(),
  loadRepositoryCheckReceipts: vi.fn(),
}));

const ws = 'ws' as WorkspaceId;
const worktree = {
  id: 'tree-1',
  repositoryId: 'repo-1',
  integrationBranch: 'main',
  version: 1,
} as unknown as WorktreeSummary;
const repository = {
  id: 'repo-1',
  displayName: 'wi',
  status: 'active',
} as unknown as SourceRepositorySummary;

beforeEach(() => {
  vi.mocked(loadWorktreeBranchStatus).mockResolvedValue({
    worktree,
    reviewCurrent: false,
    issues: [],
  } as never);
  vi.mocked(loadPlanBranchSettings).mockResolvedValue({
    settings: { repositoryId: 'repo-1', integrationBranch: 'main', version: 1 },
    issues: [],
    missingEvidence: [],
  } as never);
  vi.mocked(loadRepositories).mockResolvedValue({ repositories: [repository] } as never);
  vi.mocked(loadRepositoryPolicy).mockResolvedValue({
    kind: 'repository-policy-evidence-v1',
    observedAt: '2026-10-02T00:00:00.000Z',
    settingsVersion: 1,
    issues: [],
    manualApprovalBranches: [],
    controls: [],
    limitations: [],
  } as never);
  vi.mocked(loadRepositoryChecks).mockResolvedValue({
    repositoryId: 'repo-1',
    declarations: [],
  } as never);
  vi.mocked(loadRepositoryCheckReceipts).mockResolvedValue({
    repositoryId: 'repo-1',
    runs: [],
  } as never);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// R-D4 increment 4b: these panels re-read on the events that change them, not on every event.
it("re-reads a worktree's branch on worktree, branch, cycle and run events, not on others", async () => {
  const { wrap, send } = testQueryStore();
  render(
    wrap(
      <WorktreeBranchPanel
        workspaceId={ws}
        worktree={worktree}
        csrfToken="csrf"
        canMutate={false}
        onChanged={vi.fn()}
      />,
    ),
  );
  await screen.findByText('Check branch status');
  await send('notifications-changed', { workspaceId: ws });
  await send('repository-registered', { workspaceId: ws, repositoryId: 'repo-1' });
  await send('roadmap-changed', { workspaceId: ws, payload: { roadmapId: 'r' } });
  expect(loadWorktreeBranchStatus).toHaveBeenCalledTimes(1);
  await send('branches-changed', { workspaceId: ws });
  expect(loadWorktreeBranchStatus).toHaveBeenCalledTimes(2);
  await send('agent-run-status-changed', { workspaceId: ws });
  expect(loadWorktreeBranchStatus).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button', { name: 'Check branch status' }));
  await waitFor(() => expect(loadWorktreeBranchStatus).toHaveBeenCalledTimes(4));
});

it("re-reads a plan's branch settings, repositories and policy each on their own events", async () => {
  const { wrap, send } = testQueryStore();
  render(
    wrap(
      <PlanBranchPanel
        workspaceId={ws}
        planVersionId={'plan-1' as PlanVersionId}
        csrfToken="csrf"
        editable={false}
        onChanged={vi.fn()}
      />,
    ),
  );
  await screen.findByText('wi → main');
  await screen.findByRole('button', { name: 'Refresh branches' });
  await send('notifications-changed', { workspaceId: ws });
  await send('roadmap-changed', { workspaceId: ws, payload: { roadmapId: 'r' } });
  expect(loadPlanBranchSettings).toHaveBeenCalledTimes(1);
  expect(loadRepositories).toHaveBeenCalledTimes(1);
  expect(loadRepositoryPolicy).toHaveBeenCalledTimes(1);
  // Another plan's branches move: not this plan's settings.
  await send('branches-changed', { workspaceId: ws, payload: { planVersionId: 'plan-2' } });
  expect(loadPlanBranchSettings).toHaveBeenCalledTimes(1);
  await send('branches-changed', { workspaceId: ws, payload: { planVersionId: 'plan-1' } });
  expect(loadPlanBranchSettings).toHaveBeenCalledTimes(2);
  expect(loadRepositoryPolicy).toHaveBeenCalledTimes(3);
  expect(loadRepositories).toHaveBeenCalledTimes(1);
  await send('repository-registered', { workspaceId: ws, repositoryId: 'repo-2' });
  expect(loadRepositories).toHaveBeenCalledTimes(2);
  // Refresh branches reads all three now.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh branches' }));
  await waitFor(() => expect(loadRepositoryPolicy).toHaveBeenCalledTimes(4));
  expect(loadPlanBranchSettings).toHaveBeenCalledTimes(3);
  expect(loadRepositories).toHaveBeenCalledTimes(3);
});

it("re-reads a repository's checks and receipts on repository and run events, not on others", async () => {
  const { wrap, send } = testQueryStore();
  render(
    wrap(
      <RepositoryChecksPanel
        workspaceId={ws}
        repository={repository}
        csrfToken="csrf"
        editable={false}
      />,
    ),
  );
  await screen.findByText(/No adopted checks/);
  await send('notifications-changed', { workspaceId: ws });
  await send('branches-changed', { workspaceId: ws, payload: { planVersionId: 'plan-1' } });
  expect(loadRepositoryChecks).toHaveBeenCalledTimes(1);
  expect(loadRepositoryCheckReceipts).toHaveBeenCalledTimes(1);
  await send('agent-run-status-changed', { workspaceId: ws });
  expect(loadRepositoryChecks).toHaveBeenCalledTimes(2);
  expect(loadRepositoryCheckReceipts).toHaveBeenCalledTimes(2);
});
