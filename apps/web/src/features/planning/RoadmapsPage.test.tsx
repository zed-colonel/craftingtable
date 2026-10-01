import type { AttentionItemView, ConcurrencyDetail } from '@craftingtable/contracts';
import { asWorkspaceId, type RoadmapView } from '@craftingtable/domain';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { resetFallbackQueryStore } from '../../lib/query-store.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConcurrencyDefinition, loadConcurrencyImports } from '../../lib/package-import-api.js';
import { loadRoadmapHistory, loadRoadmaps } from '../../lib/roadmap-api.js';
import { ConcurrencyImports } from './ConcurrencyImports.js';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { AmendmentDecision } from '../../decisions/amendment/AmendmentDecision.js';
import { RoadmapPage, RoadmapsPage } from './RoadmapsPage.js';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import { SHOW_PART_EVENT } from '../../lib/reveal-element.js';

// The panels are tested on their own; here only where each page puts them matters (R-E2).
vi.mock('./CrossProjectPanel.js', () => ({
  CrossProjectPanel: vi.fn(() => <section aria-label="Cross-project supervision" />),
}));
vi.mock('./RuntimeEvidencePanel.js', () => ({
  RuntimeEvidencePanel: vi.fn(() => <section aria-label="Dependency environments and evidence" />),
}));
vi.mock('../../decisions/amendment/AmendmentDecision.js', () => ({
  AmendmentDecision: vi.fn(() => <section aria-label="Map amendments" />),
}));
vi.mock('./ScopeRecoveryPanel.js', () => ({
  ScopeRecoveryPanel: () => <section aria-label="Independent review recovery" />,
}));
vi.mock('./RoadmapStatusList.js', () => ({
  RoadmapStatusList: () => <section aria-label="Entry status" />,
}));
vi.mock('../../lib/roadmap-api.js', () => ({
  loadRoadmaps: vi.fn(),
  loadRoadmapHistory: vi.fn(),
  controlRoadmap: vi.fn(),
  saveRoadmap: vi.fn(),
}));
vi.mock('../../lib/package-import-api.js', () => ({
  loadConcurrencyImports: vi.fn(),
  loadConcurrencyDefinition: vi.fn(),
  importConcurrencyZip: vi.fn(),
  saveConcurrencyBindings: vi.fn(),
  archiveDownloadPath: () => '/api/download',
}));
vi.mock('../../lib/execution-api.js', () => ({
  loadExecutionStatus: vi.fn(async () => ({ backends: [], git: { available: true } })),
  loadRunProfiles: vi.fn(async () => ({ profiles: [] })),
}));
vi.mock('../../lib/planning-api.js', () => ({
  loadWorkspaceWorkItems: vi.fn(async () => ({ items: [] })),
}));

const ws = asWorkspaceId('workspace');
const profile = { backend: 'codex', permissionMode: 'auto' };
function roadmap(
  id: string,
  name: string,
  status: string,
  crossProject?: { definitionId: string; bindingRevision: number },
): RoadmapView {
  return {
    roadmap: {
      id,
      workspaceId: ws,
      status,
      version: 3,
      reason: `${name} scheduler reason.`,
      attempts: [],
      definition: {
        name,
        revision: 2,
        scheduling: { mode: 'parallel', maxInFlight: 2, maxPerRepository: 2 },
        ...(crossProject
          ? {
              crossProject: {
                ...crossProject,
                targetId: 'TARGET',
                selection: 'target-only',
              },
            }
          : {}),
        entries: [
          {
            id: `${id}-entry`,
            workItemId: 'item',
            sourceId: 'wi/WI-01/domain',
            title: 'First slice',
            executionScope: { kind: 'slice', sourceId: 'wi/WI-01/domain' },
            integrationBranch: 'wi-fabric-2',
            planVersionId: 'plan',
            profiles: { design: profile, implement: profile, review: profile, remediate: profile },
            policy: { maxNits: 3, maxRemediationRounds: 3, maxRunMinutes: 60 },
            instructions: '',
          },
        ],
      },
    },
    progress: [
      {
        entryId: `${id}-entry`,
        status: 'dependency-blocked',
        reason: 'Waiting for a reviewer.',
        blockers: [{ kind: 'review', message: 'Assign a reviewer.' }],
      },
    ],
  } as unknown as RoadmapView;
}

const active = roadmap('r-active', 'Cross-project roadmap', 'paused', {
  definitionId: 'def-1',
  bindingRevision: 4,
});
const finished = roadmap('r-done', 'Old roadmap', 'completed');

beforeEach(() => {
  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [active, finished] } as never);
  vi.mocked(loadRoadmapHistory).mockResolvedValue({
    definitions: [
      { revision: 1, name: 'Cross-project roadmap', createdAt: '2026-09-20T00:00:00.000Z' },
      { revision: 2, name: 'Cross-project roadmap', createdAt: '2026-09-21T00:00:00.000Z' },
    ],
  } as never);
  vi.mocked(loadConcurrencyImports).mockResolvedValue({
    definitions: [
      { id: 'def-1', mapId: 'STACK', revision: '0.3.0', parentCount: 3, sliceCount: 7 },
    ],
    attempts: [],
  } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const common = { workspaceId: ws, csrfToken: 'csrf', canMutate: true, onOpenWorkItem: vi.fn() };

it('lists roadmaps, active first and finished ones apart, and renders no roadmap body (R-E2)', async () => {
  render(<RoadmapsPage workspaceId={ws} csrfToken="csrf" canMutate />);
  const activeList = await screen.findByRole('region', { name: 'Active roadmaps' });
  expect(
    within(activeList).getByRole('link', { name: 'Cross-project roadmap' }).getAttribute('href'),
  ).toBe('/workspaces/workspace/roadmaps/r-active');
  const history = screen.getByRole('region', { name: 'Finished roadmaps' });
  expect(within(history).getByRole('link', { name: 'Old roadmap' })).toBeTruthy();
  expect(within(activeList).queryByText('Old roadmap')).toBeNull();
  // Each map links to its own page; the list never mounts a map's or a roadmap's panels.
  expect((await screen.findByRole('link', { name: /STACK · 0\.3\.0/ })).getAttribute('href')).toBe(
    '/workspaces/workspace/roadmaps/maps/def-1',
  );
  expect(screen.queryByRole('group', { name: 'Roadmap controls' })).toBeNull();
  expect(CrossProjectPanel).not.toHaveBeenCalled();
  expect(RuntimeEvidencePanel).not.toHaveBeenCalled();
});

it('shows the board with its controls and entries, and leaves setup and history to their pages', async () => {
  render(<RoadmapPage {...common} roadmapId="r-active" tab="board" />);
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Cross-project roadmap' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Resume roadmap' })).toBeTruthy();
  expect(screen.getByText('wi/WI-01/domain · slice · First slice')).toBeTruthy();
  // A setup element reached from the board is a link to the setup page, not a dead reveal.
  expect(
    screen
      .getByRole('link', { name: 'Assign independent reviewer responsibilities' })
      .getAttribute('href'),
  ).toBe('/workspaces/workspace/roadmaps/r-active/setup#map-reviewers-roadmap-r-active');
  const tabs = screen.getByRole('navigation', { name: 'Roadmap pages' });
  expect(within(tabs).getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(CrossProjectPanel).not.toHaveBeenCalled();
  expect(RuntimeEvidencePanel).not.toHaveBeenCalled();
  expect(AmendmentDecision).not.toHaveBeenCalled();
  expect(loadRoadmapHistory).not.toHaveBeenCalled();
});

it('puts every setup panel on the setup page once, after an ordered checklist', async () => {
  render(<RoadmapPage {...common} roadmapId="r-active" tab="setup" />);
  const checklist = await screen.findByRole('navigation', { name: 'Setup checklist' });
  expect(
    within(checklist)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual([
    'Plan and repository bindings',
    'Dependency environment',
    'Verification environments',
    'Reviewer responsibilities and delegation',
    'Automation and agents',
    'Plan acceptance',
    'Shared architecture decisions',
    'Submitted evidence and builds',
  ]);
  // One step at a time (R-E2): with nothing needing the operator, the bindings.
  expect(
    within(checklist).getByRole('button', { name: 'Plan and repository bindings' }).ariaCurrent,
  ).toBe('step');
  expect(screen.getAllByRole('region', { name: 'Cross-project supervision' })).toHaveLength(1);
  expect(
    screen.getAllByRole('region', { name: 'Dependency environments and evidence' }),
  ).toHaveLength(1);
  expect(vi.mocked(RuntimeEvidencePanel).mock.calls[0]?.[0]).toMatchObject({
    panelId: 'runtime-evidence-roadmap-r-active',
    definitionId: 'def-1',
    bindingRevision: 4,
  });
  expect(screen.queryByRole('button', { name: 'Resume roadmap' })).toBeNull();
  expect(AmendmentDecision).not.toHaveBeenCalled();
});

it('opens setup at the step an open item needs, marks it, and switches step when asked (R-E2)', async () => {
  const item = {
    id: 'item-native',
    subjectKey: 'roadmap:r-active:verification',
    code: 'verification-setup',
    kind: 'attention',
    title: 'Verification setup',
    message: 'Approve native verification.',
    path: '/workspaces/ws/roadmaps/r-active/setup#runtime-evidence-roadmap-r-active-native',
    inboxPath: '/workspaces/ws/inbox/item-native',
    refs: { roadmapId: 'r-active' },
    blocks: 1,
    openedAt: '2026-09-30T00:00:00.000Z',
    pushedAt: null,
  } as unknown as AttentionItemView;
  render(<RoadmapPage {...common} roadmapId="r-active" tab="setup" attention={[item]} />);
  const checklist = await screen.findByRole('navigation', { name: 'Setup checklist' });
  const verification = within(checklist).getByRole('button', { name: 'Verification environments' });
  expect(verification.ariaCurrent).toBe('step');
  expect(verification.parentElement?.textContent).toContain('Needs you');
  const decisions = within(checklist).getByRole('button', {
    name: 'Shared architecture decisions',
  });
  fireEvent.click(decisions);
  expect(decisions.ariaCurrent).toBe('step');
  expect(verification.ariaCurrent).toBeNull();
  // A reveal of an element in another step (a link, an item, a notification) shows that step.
  act(() => {
    window.dispatchEvent(
      new CustomEvent(SHOW_PART_EVENT, { detail: { id: 'map-reviewers-roadmap-r-active' } }),
    );
  });
  expect(
    within(checklist).getByRole('button', { name: 'Reviewer responsibilities and delegation' })
      .ariaCurrent,
  ).toBe('step');
});

it("gives a single-project roadmap of one map's slices that map's decisions on its setup (LIVE-18 review)", async () => {
  const slices = roadmap('r-slices', 'Slice roadmap', 'paused');
  const entry = slices.roadmap.definition.entries[0]!;
  const withScope = {
    ...slices,
    roadmap: {
      ...slices.roadmap,
      definition: {
        ...slices.roadmap.definition,
        entries: [
          {
            ...entry,
            executionScope: {
              kind: 'slice',
              definitionId: 'def-9',
              bindingRevision: 2,
              sourceId: 'wi/WI-01/domain',
            },
          },
        ],
      },
    },
  } as unknown as RoadmapView;
  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [withScope] } as never);
  render(<RoadmapPage {...common} roadmapId="r-slices" tab="setup" />);
  expect(
    await screen.findAllByRole('region', { name: 'Dependency environments and evidence' }),
  ).toHaveLength(1);
  expect(vi.mocked(RuntimeEvidencePanel).mock.calls[0]?.[0]).toMatchObject({
    panelId: 'runtime-evidence-roadmap-r-slices',
    definitionId: 'def-9',
    bindingRevision: 2,
    roadmapId: 'r-slices',
  });
  expect(CrossProjectPanel).not.toHaveBeenCalled();
});

it('loads revisions and amendments on the history page', async () => {
  render(<RoadmapPage {...common} roadmapId="r-active" tab="history" />);
  const revisions = await screen.findByRole('region', { name: 'Saved revisions' });
  await waitFor(() =>
    expect(within(revisions).getByText(/^Revision 2 · Cross-project roadmap/)).toBeTruthy(),
  );
  expect(screen.getByRole('region', { name: 'Map amendments' })).toBeTruthy();
  expect(CrossProjectPanel).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Resume roadmap' })).toBeNull();
});

it('keeps every part inside an inbox item, where the roadmap hosts its own controls', async () => {
  render(<RoadmapPage {...common} roadmapId="r-active" tab="all" />);
  expect(await screen.findByRole('region', { name: 'Cross-project roadmap' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Resume roadmap' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Cross-project supervision' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Map amendments' })).toBeTruthy();
  expect(screen.queryByRole('navigation', { name: 'Roadmap pages' })).toBeNull();
  // Inside the inbox the reviewer assignment is on the same page, so it is revealed in place.
  expect(
    screen.getByRole('button', { name: 'Assign independent reviewer responsibilities' }),
  ).toBeTruthy();
});

const detail = (bindingRevision: number) =>
  ({
    summary: {
      id: 'def-1',
      document: 'Stack map',
      mapId: 'STACK',
      revision: '0.3.0',
      bindingRevision,
      parentCount: 3,
      sliceCount: 7,
      checkpointCount: 2,
      graphNodeCount: 9,
      graphEdgeCount: 8,
      digest: 'digest',
    },
    archiveDigest: 'zip',
    archiveId: 'archive',
    blockers: [],
    repositories: [],
    sourceRepositories: [],
    history: [],
    targets: [],
    suggestedTarget: 'TARGET',
    decisions: [],
    resources: [],
    evidenceProfiles: [],
    nodes: [],
    limitations: [],
  }) as unknown as ConcurrencyDetail;

it("offers a map's supervisor once on its page, and links every roadmap on the map, ended ones too (R-E2 review)", async () => {
  const stopped = roadmap('r-stopped', 'Stopped roadmap', 'stopped', {
    definitionId: 'def-1',
    bindingRevision: 4,
  });
  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [active, stopped, finished] } as never);
  vi.mocked(loadConcurrencyDefinition).mockResolvedValue(detail(4));
  render(<ConcurrencyImports workspaceId={ws} csrfToken="csrf" canMutate definitionId="def-1" />);
  // A roadmap on this binding revision does not hide the creator: another target, or a retry
  // after a stop, starts here.
  expect(await screen.findAllByRole('region', { name: 'Cross-project supervision' })).toHaveLength(
    1,
  );
  expect(
    screen.getAllByRole('region', { name: 'Dependency environments and evidence' }),
  ).toHaveLength(1);
  expect(
    (await screen.findByRole('link', { name: 'Cross-project roadmap' })).getAttribute('href'),
  ).toBe('/workspaces/workspace/roadmaps/r-active/setup');
  expect(screen.getByRole('link', { name: 'Stopped roadmap' }).getAttribute('href')).toBe(
    '/workspaces/workspace/roadmaps/r-stopped/setup',
  );
  expect(screen.queryByRole('link', { name: 'Old roadmap' })).toBeNull();
  // The map's page creates a roadmap one step at a time too, starting with its scope (R-E2).
  const checklist = screen.getByRole('navigation', { name: 'Setup checklist' });
  expect(
    within(checklist).getByRole('button', { name: 'Plan and repository bindings' }).ariaCurrent,
  ).toBe('step');
});

it("renders only the part an inbox item is decided in: the held entry's controls, one setup step, or the amendments (R-A6 review M5)", async () => {
  const entryId = 'r-active-entry';
  const view = render(
    <RoadmapPage
      {...common}
      roadmapId="r-active"
      tab="all"
      part={{ kind: 'controls', entryId, heldOnly: true }}
    />,
  );
  // The paused roadmap: its controls and the held entry's row, and nothing else.
  expect(await screen.findByRole('button', { name: 'Resume roadmap' })).toBeTruthy();
  expect(document.getElementById(`roadmap-entry-r-active-${entryId}`)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Cross-project supervision' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Map amendments' })).toBeNull();
  // A setup element the part does not show is reached on the roadmap's page (review M4).
  expect(
    screen.getByRole('link', { name: 'Assign independent reviewer responsibilities' }),
  ).toBeTruthy();
  view.unmount();
  resetFallbackQueryStore();

  // A running roadmap whose entry is not held: a cycle's item shows none of it.
  const running = roadmap('r-run', 'Running roadmap', 'running');
  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [running] } as never);
  const empty = render(
    <RoadmapPage
      {...common}
      roadmapId="r-run"
      tab="all"
      part={{ kind: 'controls', entryId: 'r-run-entry', heldOnly: true }}
    />,
  );
  await waitFor(() => expect(loadRoadmaps).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(empty.container.textContent).toBe('');
  empty.unmount();
  resetFallbackQueryStore();

  vi.mocked(loadRoadmaps).mockResolvedValue({ roadmaps: [active] } as never);
  render(
    <RoadmapPage
      {...common}
      roadmapId="r-active"
      tab="all"
      part={{ kind: 'setup', step: 'reviewers' }}
    />,
  );
  const reviewers = await screen.findByRole('region', { name: 'Independent review recovery' });
  expect(reviewers.closest('[hidden]')).toBeNull();
  expect(
    document.getElementById('roadmap-setup-r-active-bindings')?.closest('[hidden]'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resume roadmap' })).toBeNull();
});

it('re-reads the roadmaps on their events, once for every view that lists them, and on no other event (R-D4)', async () => {
  const { wrap, send } = testQueryStore();
  render(wrap(<RoadmapsPage workspaceId={ws} csrfToken="csrf" canMutate />));
  await screen.findByRole('region', { name: 'Active roadmaps' });
  const reads = vi.mocked(loadRoadmaps).mock.calls.length;
  await send('repository-registered', { workspaceId: ws, repositoryId: 'repo' });
  await send('agent-run-status-changed', { workspaceId: ws, payload: { runId: 'run' } });
  expect(loadRoadmaps).toHaveBeenCalledTimes(reads);
  await send('roadmap-changed', { workspaceId: ws, payload: { roadmapId: 'r-active' } });
  await waitFor(() => expect(loadRoadmaps).toHaveBeenCalledTimes(reads + 1));
});
