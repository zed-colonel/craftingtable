import type { AttentionItemView, WorkspaceOverview } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { CycleFocusProvider, SessionProvider, WorkspaceProvider } from '../app/session.js';
import { request } from '../lib/api-client.js';
import { NavigationProvider } from '../lib/navigation.js';
import { createQueryStore, QueryStoreProvider } from '../lib/query-store.js';
import { InboxHost } from './InboxHost.js';

/**
 * An architecture, checkpoint or plan item renders only its own decision (R-A6 rest, A2), not
 * the roadmap's whole setup step with its other decisions and its batch approval.
 */
vi.mock('../lib/api-client.js', () => ({ request: vi.fn() }));
let work: Record<string, unknown> = {};
vi.mock('../features/execution/WorkItemControls.js', () => ({
  useWorkItem: () => work,
  DelegationControls: () => null,
  ScopeControls: () => null,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  work = {};
});

const ws = asWorkspaceId('ws');
const definitionId = '00000000-0000-4000-8000-000000000001';
const card = (checkpointId: string, proposal?: string) => ({
  checkpointId,
  title: `${checkpointId} title`,
  requirements: [],
  blockers: [],
  sourceReferences: 'plan §4',
  consumers: [{ sliceId: 'local/AQ-01/a', phase: 'start' }],
  records: proposal
    ? [
        {
          id: `00000000-0000-4000-8000-0000000000${checkpointId.endsWith('1') ? '11' : '12'}`,
          applicable: true,
          issues: [],
          proposal: {
            kind: 'architecture-decision-v1',
            bindingDigest: 'b'.repeat(64),
            coverage: 'full',
            proposal,
            sourceReferences: 'plan §4',
            consumers: [],
            retainedObligations: '',
          },
        },
      ]
    : [],
});
const runtime = {
  issues: [],
  builds: [],
  bindingRevision: 1,
  current: { id: definitionId, generation: 1, pins: [], consumers: [], environments: [] },
  history: [],
  repositories: [],
  upstreamHistory: [],
  subjects: [
    {
      subject: { kind: 'checkpoint', sourceId: 'QUALIFIED' },
      title: 'Qualified',
      profile: 'qualified',
      requirements: ['Qualified requirement'],
      reviewerRoles: ['independent-reviewer'],
      testedRepositories: [],
      cases: [],
      issues: [],
    },
  ],
  submissions: [],
  decisionInbox: {
    workspaceId: 'ws',
    definitionId,
    bindingRevision: 1,
    blockers: [],
    // Two saved proposals: setup would offer to approve them together.
    decisions: [card('LOCAL-ADR-01', 'Use a queue.'), card('LOCAL-ADR-02', 'Use a log.')],
  },
  planAcceptance: {
    checkpoint: 'PLAN-OK',
    roadmaps: [
      {
        roadmapId: 'r',
        name: 'Cross-project',
        definitionRevision: 5,
        snapshotDigest: 'a'.repeat(64),
        issues: [],
        state: 'accepted',
        carried: { reviewedAt: '2026-10-01T21:26:54.681Z', changedInputs: ['reviewerRoles'] },
      },
    ],
  },
};
function serve() {
  vi.mocked(request).mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/runtime')) return runtime;
    if (path === '/api/workspaces/ws/roadmaps')
      return {
        roadmaps: [
          {
            roadmap: {
              id: 'r',
              workspaceId: 'ws',
              status: 'paused',
              version: 1,
              definition: { crossProject: { definitionId, bindingRevision: 1 }, entries: [] },
            },
          },
        ],
      };
    if (path.endsWith('/decision-preparations'))
      return { version: 1, status: 'paused', decisions: [] };
    return { backends: [] };
  });
}
function inApp(ui: ReactNode) {
  return render(
    <QueryStoreProvider value={createQueryStore({ debounceMs: 0, maxWaitMs: 0 })}>
      <SessionProvider
        value={{ user: { username: 'operator' } as never, csrfToken: 'csrf', expire: vi.fn() }}
      >
        <CycleFocusProvider value={{ worktreeId: undefined, focus: vi.fn() }}>
          <NavigationProvider value={{ route: { name: 'home' }, navigate: vi.fn() }}>
            <WorkspaceProvider
              value={{
                workspaceId: ws,
                workspace: { id: ws, name: 'W', role: 'owner' } as WorkspaceOverview,
                canMutate: true,
                isOwner: true,
              }}
            >
              {ui}
            </WorkspaceProvider>
          </NavigationProvider>
        </CycleFocusProvider>
      </SessionProvider>
    </QueryStoreProvider>,
  );
}
const item = (fields: Partial<AttentionItemView>) =>
  ({ id: 'i', kind: 'attention', refs: {}, ...fields }) as AttentionItemView;
const host = (fields: Partial<AttentionItemView>) =>
  inApp(<InboxHost item={item(fields)} attention={[]} workspaceCycles={[]} />);

it("renders an architecture item's own card, not the step's other cards or batch approval", async () => {
  serve();
  host({
    code: 'architecture-decision',
    subjectKey: 'roadmap:r:checkpoint:LOCAL-ADR-02',
    refs: { roadmapId: 'r' },
    checkpointId: 'LOCAL-ADR-02',
  });
  await screen.findByRole('region', { name: 'LOCAL-ADR-02' });
  expect(screen.queryByRole('region', { name: 'LOCAL-ADR-01' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Approve saved decisions' })).toBeNull();
  expect(screen.queryByText('Shared architecture decisions')).toBeNull();
  // No unsaved setup sits beside it, so nothing holds its review.
  expect(
    (screen.getByRole('button', { name: 'Review saved proposal' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("renders a shared-decision stop's unsettled decisions, from the cycle's own map", async () => {
  serve();
  work = {
    cycles: [
      {
        cycle: {
          id: 'c1',
          worktreeId: 't1',
          executionScope: { definitionId, kind: 'slice', sourceId: 'local/AQ-01/a' },
        },
        projection: { unsettledDecisions: ['LOCAL-ADR-01'], actions: [] },
      },
    ],
    execution: { worktrees: [], runs: [] },
    repositories: [],
    commands: { busy: false },
  };
  host({
    code: 'shared-decision-required',
    subjectKey: 'cycle:c1',
    refs: { cycleId: 'c1', worktreeId: 't1', workItemId: 'w1' },
  });
  await screen.findByRole('region', { name: 'LOCAL-ADR-01' });
  expect(screen.queryByRole('region', { name: 'LOCAL-ADR-02' })).toBeNull();
  expect(vi.mocked(request).mock.calls.map(([url]) => String(url))).toContain(
    `/api/workspaces/ws/concurrency-definitions/${definitionId}/runtime`,
  );
});

it("renders a plan-acceptance item's plan, keeping R-C6's carried text", async () => {
  serve();
  host({
    code: 'plan-acceptance',
    subjectKey: 'roadmap:r:checkpoint:PLAN-OK',
    refs: { roadmapId: 'r' },
  });
  const status = await screen.findByText(/^Accepted, carried from your review of /);
  expect(status.textContent).toMatch(
    /; changed: reviewer roles\. Start or Resume remains your action\.$/,
  );
  expect(screen.queryByRole('region', { name: 'LOCAL-ADR-01' })).toBeNull();
});

it("renders a checkpoint-evidence item's own evidence", async () => {
  serve();
  host({
    code: 'checkpoint-evidence',
    subjectKey: 'roadmap:r:checkpoint:QUALIFIED',
    refs: { roadmapId: 'r' },
    checkpointId: 'QUALIFIED',
  });
  await screen.findByRole('region', { name: 'QUALIFIED evidence' });
  await waitFor(() =>
    expect(screen.getAllByText('Qualified requirement').length).toBeGreaterThan(0),
  );
  expect(screen.queryByText(/Saved plan acceptance/)).toBeNull();
});
