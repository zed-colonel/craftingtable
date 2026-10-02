import { asWorkspaceId, type RoadmapView } from '@craftingtable/domain';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/event-invalidations.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { loadRoadmaps } from '../../lib/roadmap-api.js';
import { entryStatusLabel } from './roadmap-entry-status.js';
import { RoadmapPage } from './RoadmapsPage.js';

// Each entry row names its status once, so the label's calls count the rows rendered.
vi.mock('./roadmap-entry-status.js', async (original) => {
  const actual = await original<typeof import('./roadmap-entry-status.js')>();
  return { ...actual, entryStatusLabel: vi.fn(actual.entryStatusLabel) };
});
vi.mock('./CrossProjectPanel.js', () => ({ CrossProjectPanel: () => null }));
vi.mock('./RuntimeEvidencePanel.js', () => ({ RuntimeEvidencePanel: () => null }));
vi.mock('./ScopeRecoveryPanel.js', () => ({ ScopeRecoveryPanel: () => null }));
vi.mock('./RoadmapStatusList.js', () => ({ RoadmapStatusList: () => null }));
vi.mock('../../lib/roadmap-api.js', () => ({
  loadRoadmaps: vi.fn(),
  loadRoadmapHistory: vi.fn(),
  controlRoadmap: vi.fn(),
  saveRoadmap: vi.fn(),
}));
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
it('renders only the changed entry when the roadmap is read again, and none for a new callback', async () => {
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
  // An unchanged read keeps every row; a changed entry renders that row alone.
  await act(async () => {
    store.set(queryKeys.roadmaps(ws), { roadmaps: [view()] });
  });
  expect(vi.mocked(entryStatusLabel)).toHaveBeenCalledTimes(0);
  await act(async () => {
    store.set(queryKeys.roadmaps(ws), { roadmaps: [view(7)] });
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
