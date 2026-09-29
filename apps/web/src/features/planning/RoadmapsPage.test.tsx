import type { ConcurrencyDetail } from '@craftingtable/contracts';
import { asWorkspaceId, type RoadmapView } from '@craftingtable/domain';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConcurrencyDefinition, loadConcurrencyImports } from '../../lib/package-import-api.js';
import { loadRoadmapHistory, loadRoadmaps } from '../../lib/roadmap-api.js';
import { ConcurrencyImports } from './ConcurrencyImports.js';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { MapAmendmentPanel } from './MapAmendmentPanel.js';
import { RoadmapPage, RoadmapsPage } from './RoadmapsPage.js';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';

// The panels are tested on their own; here only where each page puts them matters (R-E2).
vi.mock('./CrossProjectPanel.js', () => ({
  CrossProjectPanel: vi.fn(() => <section aria-label="Cross-project supervision" />),
}));
vi.mock('./RuntimeEvidencePanel.js', () => ({
  RuntimeEvidencePanel: vi.fn(() => <section aria-label="Dependency environments and evidence" />),
}));
vi.mock('./MapAmendmentPanel.js', () => ({
  MapAmendmentPanel: vi.fn(() => <section aria-label="Map amendments" />),
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
  expect(MapAmendmentPanel).not.toHaveBeenCalled();
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
  ]);
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
  expect(MapAmendmentPanel).not.toHaveBeenCalled();
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
});
