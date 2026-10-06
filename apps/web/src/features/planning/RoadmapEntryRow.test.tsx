import { asWorkspaceId, type RoadmapView } from '@craftingtable/domain';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/event-invalidations.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { revealElement } from '../../lib/reveal-element.js';
import { controlRoadmap, loadRoadmaps } from '../../lib/roadmap-api.js';
import { roadmapPageOf } from './roadmap-api-testing.js';
import { entryStatusLabel } from './roadmap-entry-status.js';
import { RoadmapEntryRow } from './RoadmapEntryRow.js';
import { RoadmapPage } from './RoadmapsPage.js';

// Each entry row names its status once, so the label's calls count the rows rendered.
vi.mock('./roadmap-entry-status.js', async (original) => {
  const actual = await original<typeof import('./roadmap-entry-status.js')>();
  return { ...actual, entryStatusLabel: vi.fn(actual.entryStatusLabel) };
});
vi.mock('../../lib/reveal-element.js', async (original) => {
  const actual = await original<typeof import('../../lib/reveal-element.js')>();
  return { ...actual, revealElement: vi.fn() };
});
vi.mock('./CrossProjectPanel.js', () => ({ CrossProjectPanel: () => null }));
vi.mock('./RuntimeEvidencePanel.js', () => ({ RuntimeEvidencePanel: () => null }));
vi.mock('./ScopeRecoveryPanel.js', () => ({ ScopeRecoveryPanel: () => null }));
vi.mock('./RoadmapStatusList.js', () => ({ RoadmapStatusList: () => null }));
vi.mock('../../lib/roadmap-api.js', async () => {
  const { roadmapApiFromList } = await import('./roadmap-api-testing.js');
  return {
    ...roadmapApiFromList(),
    loadRoadmapHistory: vi.fn(),
    controlRoadmap: vi.fn(),
    saveRoadmap: vi.fn(),
  };
});
vi.mock('../../lib/execution-api.js', () => ({
  loadExecutionStatus: vi.fn(async () => ({ backends: [], git: { available: true } })),
  loadRunProfiles: vi.fn(async () => ({ profiles: [] })),
}));

const ws = asWorkspaceId('workspace');
const profile = { backend: 'codex', permissionMode: 'auto' };
const ENTRIES = 40;
/** A roadmap of many entries, the `changed` one in another state. */
function view(changed?: number): RoadmapView {
  const ids = Array.from({ length: ENTRIES }, (_, index) => `entry-${index}`);
  return {
    roadmap: {
      id: 'r',
      workspaceId: ws,
      status: 'running',
      version: 3,
      reason: 'Scheduling.',
      attempts: [],
      definition: {
        name: 'Big roadmap',
        revision: 2,
        scheduling: { mode: 'parallel', maxInFlight: 2, maxPerRepository: 2 },
        entries: ids.map((id, index) => ({
          id,
          workItemId: `item-${index}`,
          sourceId: `AQ-${index}`,
          title: `Item ${index}`,
          integrationBranch: 'main',
          planVersionId: 'plan',
          profiles: { design: profile, implement: profile, review: profile, remediate: profile },
          policy: { maxNits: 3, maxRemediationRounds: 3, maxRunMinutes: 60 },
          instructions: '',
        })),
      },
    },
    progress: ids.map((id, index) => ({
      entryId: id,
      status: index === changed ? 'running' : 'queued',
      reason: index === changed ? 'Running now.' : 'Waiting its turn.',
    })),
  } as unknown as RoadmapView;
}

beforeEach(() => {
  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [view()] } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// R-D4 increment 4c (PERF-10): a roadmap read again renders only the entries that changed.
it('renders only the changed entry when the roadmap changes, and none for a new parent callback', async () => {
  const { store, wrap } = testQueryStore();
  const page = (onOpenWorkItem: () => void) =>
    wrap(
      <RoadmapPage
        workspaceId={ws}
        roadmapId="r"
        tab="board"
        csrfToken="csrf"
        canMutate
        onOpenWorkItem={onOpenWorkItem}
      />,
    );
  const { rerender } = render(page(vi.fn()));
  await screen.findByText('AQ-0 · Item 0');
  vi.mocked(entryStatusLabel).mockClear();
  // A changed entry renders its row alone (an unchanged read renders nothing at all: the store
  // keeps the data's identity, which the store's own tests cover).
  await act(async () => {
    store.set(queryKeys.roadmapPage(ws, 'r'), roadmapPageOf(view(7)));
  });
  expect(vi.mocked(entryStatusLabel)).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Running now.')).toBeTruthy();
  vi.mocked(entryStatusLabel).mockClear();
  // The page's parent passes a new callback on each render: no row renders for it, and a row
  // still calls the newest one.
  const latest = vi.fn();
  rerender(page(latest));
  expect(vi.mocked(entryStatusLabel)).toHaveBeenCalledTimes(0);
  fireEvent.click(screen.getByText('AQ-3 · Item 3'));
  expect(latest).toHaveBeenCalledWith('item-3');
});

// R-D4 4c review F4: a row not rendered again still commands the roadmap as last read.
it("sends an entry's command with the roadmap's latest version", async () => {
  vi.mocked(controlRoadmap).mockReturnValue(new Promise(() => {}));
  const { store, wrap } = testQueryStore();
  render(
    wrap(
      <RoadmapPage
        workspaceId={ws}
        roadmapId="r"
        tab="board"
        csrfToken="csrf"
        canMutate
        onOpenWorkItem={vi.fn()}
      />,
    ),
  );
  await screen.findByText('AQ-0 · Item 0');
  const next = view(7);
  await act(async () => {
    store.set(
      queryKeys.roadmapPage(ws, 'r'),
      roadmapPageOf({ ...next, roadmap: { ...next.roadmap, version: 4 } }),
    );
  });
  fireEvent.click(screen.getAllByRole('button', { name: 'Pause item' })[2]!);
  expect(controlRoadmap).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'r', version: 4 }),
    'pause',
    'csrf',
    'entry-2',
  );
});

// R-D4 4c review F5: an entry's recovery rounds append attempts under its id; the row names
// the first, as the page did before its rows were extracted.
it("names the revision of an entry's first attempt", async () => {
  const base = view();
  vi.mocked(loadRoadmaps).mockResolvedValue({
    roadmaps: [
      {
        ...base,
        roadmap: {
          ...base.roadmap,
          attempts: [
            { entryId: 'entry-0', definitionRevision: 1 },
            { entryId: 'entry-0', definitionRevision: 2, recovery: {} },
          ],
        },
      },
    ],
  } as never);
  const { wrap } = testQueryStore();
  render(
    wrap(
      <RoadmapPage
        workspaceId={ws}
        roadmapId="r"
        tab="board"
        csrfToken="csrf"
        canMutate
        onOpenWorkItem={vi.fn()}
      />,
    ),
  );
  expect(await screen.findByText(/Execution revision 1/)).toBeTruthy();
  expect(screen.queryByText(/Execution revision 2/)).toBeNull();
});

// R-D4 4c review F4: what the extracted row shows and does, prop by prop.
const entry = view().roadmap.definition.entries[0]!;
function row(props: Partial<Parameters<typeof RoadmapEntryRow>[0]> = {}) {
  const onCommand = vi.fn();
  const onOpenWorkItem = vi.fn();
  render(
    <ol>
      <RoadmapEntryRow
        entry={entry}
        state={undefined}
        attempt={undefined}
        workspaceId={ws}
        roadmapId="r"
        roadmapStatus="running"
        automation={undefined}
        parallel
        canMutate
        busy={false}
        setupInline
        runtimePanelId="runtime-r"
        onOpenWorkItem={onOpenWorkItem}
        onCommand={onCommand}
        {...props}
      />
    </ol>,
  );
  return { onCommand, onOpenWorkItem };
}
const progress = (fields: Record<string, unknown>) =>
  ({ entryId: entry.id, reason: '', ...fields }) as never;

it.each([
  ['queued', 'Queued'],
  ['running', 'Running'],
  ['completed', 'Completed'],
  ['paused', 'Item paused'],
  ['capacity-blocked', 'Waiting for capacity'],
  ['exclusion-blocked', 'Waiting for exclusion group'],
  ['dependency-blocked', 'Waiting on prerequisites'],
  ['needs-attention', 'Needs attention'],
  ['awaiting-merge', 'Awaiting merge approval'],
])('names the %s state %j', (status, label) => {
  row({ state: progress({ status }) });
  expect(screen.getByText(label)).toBeTruthy();
});

it('names a scope acceptance awaiting its merge, and holds its commands while busy', () => {
  row({
    entry: { ...entry, executionScope: { kind: 'parent-acceptance' } } as never,
    state: progress({ status: 'awaiting-merge', reverifiable: true }),
    busy: true,
  });
  expect(screen.getByText('Ready for scope acceptance')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Pause item' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole('button', { name: 'Re-verify' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it('resumes a paused entry, pauses a running one, and offers neither in serial scheduling', () => {
  const paused = row({ state: progress({ status: 'paused' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Resume item' }));
  expect(paused.onCommand).toHaveBeenCalledWith('resume', entry.id);
  cleanup();
  const running = row({ state: progress({ status: 'running' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Pause item' }));
  expect(running.onCommand).toHaveBeenCalledWith('pause', entry.id);
  cleanup();
  row({ state: progress({ status: 'running' }), parallel: false });
  expect(screen.queryByRole('button', { name: 'Pause item' })).toBeNull();
});

it("takes the progress's automation over the entry's, and the entry's over the roadmap's", () => {
  const automatic = { integrationMerge: 'automatic', integrationConflicts: 'automatic' } as never;
  const manual = { integrationMerge: 'manual', integrationConflicts: 'ask' } as never;
  row({ automation: automatic });
  expect(screen.getByText('Automatic when reviewed and ready')).toBeTruthy();
  expect(screen.getByText('Automatic delegation')).toBeTruthy();
  cleanup();
  row({ automation: automatic, entry: { ...entry, automation: manual } as never });
  expect(screen.getByText('Your approval required')).toBeTruthy();
  cleanup();
  row({
    entry: { ...entry, automation: manual } as never,
    state: progress({ status: 'queued', effectiveAutomation: automatic }),
  });
  expect(screen.getByText('Automatic when reviewed and ready')).toBeTruthy();
});

it("shows the attempt's revision and reveals the environment setup in place", () => {
  row({
    entry: { ...entry, executionScope: { kind: 'slice' } } as never,
    state: progress({
      status: 'dependency-blocked',
      blockers: [{ kind: 'resource', code: 'environment-approval', message: 'Approve it.' }],
    }),
    attempt: { entryId: entry.id, definitionRevision: 3 } as never,
  });
  expect(screen.getByText(/Execution revision 3/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Set up verification environment' }));
  expect(revealElement).toHaveBeenCalledWith('runtime-r-native');
});
