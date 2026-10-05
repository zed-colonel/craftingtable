import type { AttentionItemView, WorkspaceOverview } from '@craftingtable/contracts';
import type { AgentRunId, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InboxHost } from '../decisions/InboxHost.js';
import { useWorkItem } from '../features/execution/WorkItemControls.js';
import { queryKeys } from '../lib/event-invalidations.js';
import { loadRun, refreshModels } from '../lib/execution-api.js';
import { NavigationProvider } from '../lib/navigation.js';
import { createQueryStore, type QueryStore, QueryStoreProvider } from '../lib/query-store.js';
import { AccountRoute, HomeRoute } from './pages/AccountRoutes.js';
import { ImportRoute } from './pages/ImportRoute.js';
import { RepositoriesRoute } from './pages/RepositoriesRoute.js';
import { RunRoute } from './pages/RunRoute.js';
import { SettingsRoute } from './pages/SettingsRoute.js';
import { WorkItemRoute } from './pages/WorkItemRoute.js';
import { CycleFocusProvider, SessionProvider, WorkspaceProvider } from './session.js';

/** What each mocked page or decision was last rendered with: the commands under test. */
const { props, capture, stream } = vi.hoisted(() => {
  const props: Record<string, Record<string, (...args: never[]) => unknown>> = {};
  return {
    props,
    capture:
      (name: string) =>
      (given: Record<string, (...args: never[]) => unknown>): null => {
        props[name] = given;
        return null;
      },
    stream: {} as { onEvent?: (event: unknown) => void; handlers?: Set<unknown> },
  };
});
vi.mock('../features/workspace/SettingsPage.js', () => ({ SettingsPage: capture('settings') }));
vi.mock('../features/execution/RepositoriesPage.js', () => ({
  RepositoriesPage: capture('repositories'),
}));
vi.mock('../features/planning/ImportPlanPage.js', () => ({ ImportPlanPage: capture('import') }));
vi.mock('../features/account/AccountPage.js', () => ({ AccountPage: capture('account') }));
vi.mock('../features/home/WorkspacesPage.js', () => ({ WorkspacesPage: capture('home') }));
vi.mock('../features/execution/RunPage.js', () => ({ RunPage: capture('run') }));
vi.mock('../decisions/checks/CheckAdoption.js', () => ({ CheckAdoption: capture('checks') }));
vi.mock('../decisions/finalization/FinalizationDecision.js', () => ({
  FinalizationDecision: capture('finalization'),
}));
vi.mock('../features/inbox/AcknowledgeMoves.js', () => ({ AcknowledgeMoves: capture('moves') }));
vi.mock('../features/planning/WorkItemPage.js', () => ({ WorkItemPage: capture('workItem') }));
vi.mock('../features/execution/PlanBranchPanel.js', () => ({ PlanBranchPanel: () => null }));
vi.mock('../features/execution/WorkItemControls.js', async (original) => ({
  ...(await original<typeof import('../features/execution/WorkItemControls.js')>()),
  CycleControls: () => null,
  DelegationControls: () => null,
  ScopeControls: () => null,
}));
vi.mock('../lib/use-run-event-stream.js', () => ({
  useRunEventStream: (
    ws: unknown,
    _run: unknown,
    _after: unknown,
    callbacks: { onEvent: (event: unknown) => void },
  ) => {
    Object.assign(stream, callbacks);
    // The handlers the open stream was given; a new one reconnects it.
    if (ws === undefined) return;
    stream.handlers ??= new Set();
    stream.handlers.add(callbacks.onEvent);
  },
}));
vi.mock('../lib/api-client.js', async (original) => ({
  ...(await original<typeof import('../lib/api-client.js')>()),
  renameWorkspace: vi.fn(async () => undefined),
  createWorkspace: vi.fn(async () => ({ workspace: { id: 'ws-new' } })),
  revokeSession: vi.fn(async () => false),
  changePassword: vi.fn(async () => ({ revokedSessionCount: 0 })),
  loadSessions: vi.fn(async () => ({ sessions: [] })),
  loadWorkspaces: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('../lib/execution-api.js', async (original) => ({
  ...(await original<typeof import('../lib/execution-api.js')>()),
  loadRepositories: vi.fn(async () => ({
    repositories: [{ id: 'repo', displayName: 'repo', status: 'active' }],
  })),
  loadExecutionStatus: vi.fn(async () => ({ git: { available: true }, backends: [] })),
  loadRunProfiles: vi.fn(async () => ({ profiles: [] })),
  saveRunProfiles: vi.fn(async () => ({ profiles: [] })),
  registerRepository: vi.fn(async () => undefined),
  refreshModels: vi.fn(async () => ({ git: { available: true }, backends: [], refreshed: true })),
  loadWorkItemExecution: vi.fn(async (_ws: string, workItemId: string) => ({
    workItemId,
    worktrees: [{ id: 'tree-1', repositoryId: 'repo' }],
    runs: [],
    mergeGates: {},
  })),
  loadRun: vi.fn(async () => ({
    run: { id: 'run-1', workItemId: 'item-1' },
    worktree: { id: 'tree-1', status: 'active' },
  })),
  loadRunEvents: vi.fn(async () => ({ events: [], nextAfter: 0 })),
  endRun: vi.fn(async () => undefined),
}));
vi.mock('../lib/planning-api.js', async (original) => ({
  ...(await original<typeof import('../lib/planning-api.js')>()),
  loadWorkItem: vi.fn(async () => ({
    workItem: { id: 'item-1', status: 'proposed', planVersionId: 'plan-1', projectId: 'p1' },
  })),
  admitWorkItem: vi.fn(async () => undefined),
}));
vi.mock('../lib/work-cycle-api.js', async (original) => ({
  ...(await original<typeof import('../lib/work-cycle-api.js')>()),
  loadWorkCycles: vi.fn(async () => ({ cycles: [] })),
}));

const ws = 'ws' as WorkspaceId;
let store: QueryStore;
beforeEach(() => {
  store = createQueryStore({ debounceMs: 0, maxWaitMs: 0 });
  for (const key of Object.keys(props)) delete props[key];
  stream.handlers = undefined;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Renders inside the app's providers, as a page is. */
function inApp(ui: ReactNode) {
  return render(
    <QueryStoreProvider value={store}>
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
/** The keys a command refreshed at once. */
const refreshed = () =>
  vi.mocked(store.refreshNow).mock.calls.flatMap(([keys]) => keys.map((key) => key.join('/')));
const named = (...keys: readonly (readonly string[])[]) => keys.map((key) => key.join('/'));
async function run(command: () => unknown): Promise<void> {
  await act(async () => {
    await command();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

// R-D4 4b review F5: each command refreshes what it changed, and the operator sees it at once.
it("refreshes a work item's own reads, the workspace's cycles and attention", async () => {
  let item!: ReturnType<typeof useWorkItem>;
  function Probe() {
    item = useWorkItem('item-1' as WorkItemId);
    return null;
  }
  inApp(<Probe />);
  vi.spyOn(store, 'refreshNow');
  await run(() => item.refresh());
  expect(refreshed()).toEqual(
    named(queryKeys.workItem(ws, 'item-1'), queryKeys.cycles(ws), queryKeys.attention(ws)),
  );
  vi.mocked(store.refreshNow).mockClear();
  await run(() => item.merged('tree-1' as never));
  expect(refreshed()).toContain(named(queryKeys.cycles(ws))[0]);
});

it("refreshes a run, its work item and the cycles after a run command and the run's end", async () => {
  // The run's detail arrives after its stream opened (F4).
  let answer!: (detail: unknown) => void;
  vi.mocked(loadRun).mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }) as never,
  );
  inApp(<RunRoute runId={'run-1' as AgentRunId} cycles={[]} />);
  await waitFor(() => expect(stream.handlers?.size).toBe(1));
  await act(async () => {
    answer({ run: { id: 'run-1', workItemId: 'item-1' }, worktree: { id: 'tree-1' } });
  });
  await waitFor(() => expect(props.run).toBeDefined());
  vi.spyOn(store, 'refreshNow');
  vi.spyOn(store, 'invalidate');
  await run(() => props.run!.onEnd!());
  const keys = named(
    queryKeys.run(ws, 'run-1'),
    queryKeys.cycles(ws),
    queryKeys.workItem(ws, 'item-1'),
  );
  expect(refreshed()).toEqual(keys);
  // The run's work item became known after the stream opened, without reconnecting it (F4).
  expect(stream.handlers?.size).toBe(1);
  await run(() => stream.onEvent!({ kind: 'turn-completed', sequence: 1 }));
  expect(
    vi.mocked(store.invalidate).mock.calls.flatMap(([given]) => given.map((k) => k.join('/'))),
  ).toEqual(keys);
});

it('reads the workspace list and snapshot after a rename, and keeps saved profiles', async () => {
  inApp(<SettingsRoute />);
  await waitFor(() => expect(props.settings).toBeDefined());
  vi.spyOn(store, 'refreshNow');
  vi.spyOn(store, 'refetch');
  vi.spyOn(store, 'set');
  await run(() => (props.settings!.onRename as (name: string) => void)('Renamed'));
  expect(vi.mocked(store.refetch).mock.calls.map(([key]) => key.join('/'))).toEqual(
    named(queryKeys.workspaces()),
  );
  expect(refreshed()).toEqual(named(queryKeys.snapshot(ws)));
  await run(() => (props.settings!.onSaveProfiles as (p: never[]) => void)([]));
  expect(vi.mocked(store.set).mock.calls.map(([key]) => key.join('/'))).toEqual(
    named(queryKeys.runProfiles(ws)),
  );
});

it('reads the repositories after registering one', async () => {
  inApp(<RepositoriesRoute />);
  await waitFor(() => expect(props.repositories).toBeDefined());
  vi.spyOn(store, 'refreshNow');
  await run(() =>
    (props.repositories!.onRegister as (input: { rootPath: string }) => void)({ rootPath: '/r' }),
  );
  expect(refreshed()).toEqual(named(queryKeys.repositories(ws)));
});

it('sets the execution status the refresh answered with after "Refresh models" (R-G15)', async () => {
  inApp(<RepositoriesRoute />);
  await waitFor(() => expect(props.repositories).toBeDefined());
  vi.spyOn(store, 'set');
  await run(() => (props.repositories!.onRefreshModels as () => void)());
  expect(vi.mocked(refreshModels)).toHaveBeenCalledWith('csrf');
  expect(vi.mocked(store.set).mock.calls).toEqual([
    [queryKeys.executionStatus(), { git: { available: true }, backends: [], refreshed: true }],
  ]);
});

it('reads the snapshot, projects and agenda after an import', async () => {
  inApp(<ImportRoute projects={[]} />);
  await waitFor(() => expect(props.import).toBeDefined());
  vi.spyOn(store, 'refreshNow');
  await run(() => props.import!.onZipImported!());
  expect(refreshed()).toEqual(named(queryKeys.snapshot(ws), ['project', ws], ['agenda', ws]));
});

it('reads the sessions after a revoke or a password change, and the list after a new workspace', async () => {
  inApp(<AccountRoute />);
  await waitFor(() => expect(props.account).toBeDefined());
  vi.spyOn(store, 'refetch');
  await run(() => (props.account!.onRevoke as (id: string) => void)('session-2'));
  await run(() =>
    (props.account!.onChangePassword as (input: object) => void)({
      currentPassword: 'a',
      newPassword: 'b',
    }),
  );
  expect(vi.mocked(store.refetch).mock.calls.map(([key]) => key.join('/'))).toEqual(
    named(queryKeys.sessions(), queryKeys.sessions()),
  );
  cleanup();
  const onOpen = vi.fn();
  inApp(<HomeRoute workspaces={[]} onOpen={onOpen} />);
  await waitFor(() => expect(props.home).toBeDefined());
  vi.mocked(store.refetch).mockClear();
  await run(() => (props.home!.onCreate as (name: string) => void)('New'));
  expect(vi.mocked(store.refetch).mock.calls.map(([key]) => key.join('/'))).toEqual(
    named(queryKeys.workspaces()),
  );
  expect(onOpen).toHaveBeenCalledWith('ws-new');
});

const item = (fields: Partial<AttentionItemView>) =>
  ({ id: 'i', kind: 'attention', refs: {}, ...fields }) as AttentionItemView;

it("reads what an inbox decision changed: checks, a finalization's state, the attention", async () => {
  inApp(
    <InboxHost
      item={item({
        code: 'check-definition-changed',
        subjectKey: 'cycle:c1',
        refs: { workItemId: 'item-1', worktreeId: 'tree-1', cycleId: 'c1' } as never,
      })}
      attention={[]}
      workspaceCycles={[]}
    />,
  );
  await waitFor(() => expect(props.checks).toBeDefined());
  vi.spyOn(store, 'refreshNow');
  await run(() => props.checks!.onAdopted!());
  expect(refreshed()).toEqual([
    ...named(queryKeys.repositoryChecks(ws, 'repo')),
    ...named(queryKeys.workItem(ws, 'item-1'), queryKeys.cycles(ws), queryKeys.attention(ws)),
  ]);
  cleanup();
  inApp(
    <InboxHost
      item={item({
        code: 'final-promotion',
        subjectKey: 'cycle:c2',
        refs: { planVersionId: 'plan-1', cycleId: 'c2' } as never,
      })}
      attention={[]}
      workspaceCycles={[]}
    />,
  );
  await waitFor(() => expect(props.finalization).toBeDefined());
  vi.mocked(store.refreshNow).mockClear();
  await run(() => props.finalization!.onChanged!());
  expect(refreshed()).toEqual(
    named(queryKeys.attention(ws), queryKeys.cycles(ws), queryKeys.finalizations(ws, 'plan-1')),
  );
  cleanup();
  inApp(
    <InboxHost
      item={item({ code: 'protected-ref-moved', subjectKey: 'protected-refs:repo' })}
      attention={[]}
      workspaceCycles={[]}
    />,
  );
  await waitFor(() => expect(props.moves).toBeDefined());
  vi.mocked(store.refreshNow).mockClear();
  await run(() => props.moves!.onDone!());
  expect(refreshed()).toEqual(named(queryKeys.attention(ws)));
});

it('reads the item, snapshot, agenda and cycles after admitting, completing or removing it', async () => {
  inApp(
    <WorkItemRoute
      workItemId={'item-1' as WorkItemId}
      attention={[]}
      cycles={[]}
      workspaceCyclesFailed={false}
    />,
  );
  await waitFor(() => expect(props.workItem).toBeDefined());
  vi.spyOn(store, 'refreshNow');
  await run(() => props.workItem!.onAdmit!());
  expect(refreshed()).toEqual(
    named(
      queryKeys.workItem(ws, 'item-1'),
      queryKeys.snapshot(ws),
      ['agenda', ws],
      queryKeys.cycles(ws),
    ),
  );
});
