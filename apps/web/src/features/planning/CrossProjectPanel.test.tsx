import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import { afterEach, it, expect, vi } from 'vitest';
import type { RunProfilesResponse } from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  asWorkItemId,
  asWorkspaceId,
  type Roadmap,
} from '@craftingtable/domain';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { previewCrossProject, saveCrossProject } from '../../lib/cross-project-api.js';
import { request } from '../../lib/api-client.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { applyRoadmapAgents, loadRoadmapAgents } from '../../lib/roadmap-api.js';
import { phaseLabel } from './DependencyRequirements.js';
import { cycleDefaultMinutes } from '../../lib/cycle-defaults-api.js';
vi.mock('../../lib/roadmap-api.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/roadmap-api.js')>()),
  loadRoadmapAgents: vi.fn(),
  applyRoadmapAgents: vi.fn(),
}));
vi.mock('../../lib/cross-project-api.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/cross-project-api.js')>()),
  previewCrossProject: vi.fn(),
  saveCrossProject: vi.fn(),
}));
// Map adoption is MapAdoption's own command (R-A6 rest, A1).
vi.mock('../../lib/cycle-defaults-api.js', () => ({
  cycleDefaultMinutes: vi.fn(async () => 120),
}));
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
const adoptions = () =>
  vi.mocked(request).mock.calls.filter(([url]) => String(url).endsWith('/supervision/adopt'));
vi.mock('../../lib/execution-api.js', () => ({
  loadExecutionStatus: vi.fn(),
  loadRunProfiles: vi.fn(),
}));
// Each node card names its phase once, so the label's calls count the cards rendered (R-D4 4c).
vi.mock('./DependencyRequirements.js', async (original) => {
  const actual = await original<typeof import('./DependencyRequirements.js')>();
  return { ...actual, phaseLabel: vi.fn(actual.phaseLabel) };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const id = '12345678-1234-4234-8234-123456789abc',
  ws = asWorkspaceId('workspace');
function setup(
  roadmap?: Roadmap,
  runtimeView?: import('@craftingtable/contracts').RuntimeEvidenceView,
  onDraftChange?: (id: string, dirty: boolean) => void,
  wrap: (ui: import('react').ReactElement) => import('react').ReactElement = (ui) => ui,
) {
  // A roadmap's agents, unless the test reads its own (R-E5b).
  if (!vi.mocked(loadRoadmapAgents).getMockImplementation())
    vi.mocked(loadRoadmapAgents).mockResolvedValue(agentView([]));
  vi.mocked(loadExecutionStatus).mockResolvedValue({
    backends: [
      {
        kind: 'codex',
        label: 'Codex',
        available: true,
        models: [],
        catalog: { source: 'catalog' as const },
      },
    ],
    git: { available: true },
    outsideSources: [],
    toolchains: { limits: { memoryMax: '8G', tasksMax: 1024 }, tools: [] },
  });
  vi.mocked(loadRunProfiles).mockResolvedValue({
    profiles: ['design', 'implement', 'review'].map((role) => ({
      role: role as 'design',
      backend: 'codex',
      permissionMode: 'auto',
      stored: true,
    })),
    // The daemon's workspace defaults; review's permissions differ, for the save below.
    agents: Object.fromEntries(
      AGENT_PROFILE_PURPOSES.map((purpose) => [
        purpose,
        {
          selection: { backend: 'codex' },
          source: { layer: 'workspace-default', slot: purpose },
          permissionMode: purpose === 'review' ? 'edit-only' : 'auto',
        },
      ]),
    ) as NonNullable<RunProfilesResponse['agents']>,
    selections: Object.fromEntries(
      ['design', 'implement', 'review', 'remediate'].map((step) => [step, { backend: 'codex' }]),
    ) as NonNullable<RunProfilesResponse['selections']>,
  });
  vi.mocked(previewCrossProject).mockResolvedValue({
    definitionId: id,
    bindingRevision: 1,
    reviewerRoles: ['repository-maintainer', 'independent-integration-reviewer'],
    targets: [
      { id: 'PROOF', checkpoint: 'WI-PROOF', scope: 'Native proof only', isRelease: false },
    ],
    suggestedTarget: 'PROOF',
    decisions: [
      {
        id: 'D1',
        title: 'Partial development',
        proposal: 'Retain original parent requirements.',
        adopted: false,
      },
    ],
    adoptions: [],
    blockers: ['Adopt exact decisions before Start.'],
    setupRequirements: [{ kind: 'adoption', message: 'Review scheduling proposals.' }],
    targetReached: false,
    selectedScopeComplete: false,
    fullPlanAccepted: false,
    finalized: false,
    published: false,
    nodes: [
      {
        key: 'checkpoint:WI-PROOF:passed',
        kind: 'checkpoint',
        sourceId: 'WI-PROOF',
        state: 'passed',
        title: 'Native proof',
        repository: 'wi',
        included: true,
        priority: true,
        satisfied: false,
        status: 'Waiting for requirements',
        requirements: ['slice:wi/WI-01/core:verified'],
        blockers: ['WI core must be verified.'],
        action: 'evidence',
      },
      {
        key: 'slice:wi/WI-01/core:verified',
        kind: 'slice',
        sourceId: 'wi/WI-01/core',
        state: 'verified',
        parentId: 'wi/WI-01',
        reviewerRoles: ['repository-maintainer'],
        title: 'Core provider',
        repository: 'wi',
        workItemId: asWorkItemId('item'),
        included: true,
        priority: true,
        satisfied: false,
        status: 'Waiting for review',
        requirements: [],
        blockers: [],
        action: 'work-item',
      },
      {
        key: 'work_item:wi/WI-14:accepted',
        kind: 'work_item',
        sourceId: 'wi/WI-14',
        state: 'accepted',
        title: 'Full release',
        repository: 'wi',
        included: false,
        priority: false,
        satisfied: false,
        status: 'Excluded',
        requirements: [],
        blockers: [],
        action: 'work-item',
      },
    ],
  });
  render(
    wrap(
      <CrossProjectPanel
        roadmap={roadmap}
        runtimeView={runtimeView}
        onDraftChange={onDraftChange}
        workspaceId={ws}
        definitionId={id}
        bindingRevision={1}
        targets={[{ id: 'PROOF', scope: 'Native proof only' }]}
        csrfToken="csrf"
        canMutate
      />,
    ),
  );
}
// R-C17 part 4 (increment 1 review M-4): new map settings start from 120 minutes per step.
it.each([
  [120, '120'],
  [45, '45'],
])('seeds new map settings with the workspace default (%s)', async (saved, shown) => {
  vi.mocked(cycleDefaultMinutes).mockResolvedValueOnce(saved);
  setup();
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await waitFor(() =>
    expect(screen.queryAllByLabelText('Minutes per step').length).toBeGreaterThan(0),
  );
  for (const field of screen.getAllByLabelText('Minutes per step') as HTMLInputElement[])
    expect(field.value).toBe(shown);
});
it('requires explicit target choice and adoption rationale, with a trace to the provider action', async () => {
  setup();
  expect((screen.getByLabelText('Planning target') as HTMLSelectElement).value).toBe('');
  expect(previewCrossProject).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  expect(adoptions()).toEqual([]);
  expect(saveCrossProject).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Focused dependency view'), {
    target: { value: 'checkpoint:WI-PROOF:passed' },
  });
  expect(
    screen
      .getAllByRole('link', { name: 'Open work item / advance scope' })[0]
      ?.getAttribute('href'),
  ).toBe('/workspaces/workspace/work-items/item');
  const adopt = screen.getByRole('button', { name: 'Adopt scheduling proposals' });
  expect((adopt as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I approve all listed/));
  expect((adopt as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Adoption rationale'), {
    target: { value: 'Reviewed preserved obligations.' },
  });
  vi.mocked(request).mockResolvedValue({ adopted: true });
  fireEvent.click(adopt);
  await waitFor(() => expect(adoptions()).toHaveLength(1));
  const [url, , init] = adoptions()[0]!;
  expect(url).toBe(`/api/workspaces/${ws}/concurrency-definitions/${id}/supervision/adopt`);
  expect(JSON.parse(String(init!.body))).toEqual({
    bindingRevision: 1,
    decisionIds: ['D1'],
    rationale: 'Reviewed preserved obligations.',
  });
  expect((init!.headers as Record<string, string>)['x-craftingtable-csrf']).toBe('csrf');
  expect(saveCrossProject).not.toHaveBeenCalled();
});
it('saves a draft with manual parent acceptance and the defaults’ permissions, never an agent; creation never starts work', async () => {
  setup();
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  vi.mocked(saveCrossProject).mockResolvedValue({
    roadmap: { definition: { name: 'Cross-project roadmap' } },
  } as Awaited<ReturnType<typeof saveCrossProject>>);
  const create = screen.getByRole('button', { name: 'Create cross-project roadmap' });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  await waitFor(() => expect(saveCrossProject).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(saveCrossProject).mock.calls[0]![1];
  expect(sent.configuration.selection).toBe('target-only');
  expect(sent.configuration.parentAcceptance).toBe('manual');
  expect(sent.configuration.defaults.permissions.review).toBe('edit-only');
  expect(sent.configuration.defaults).not.toHaveProperty('profiles');
  expect(sent.configuration.defaults.automation.integrationMerge).toBe('manual');
  expect(sent.expectedVersion).toBe(0);
  expect(adoptions()).toEqual([]);
});

/** The roadmap's agents as its setup view reports them, each entry with its settings level. */
function agentView(
  levels: readonly import('@craftingtable/contracts').RoadmapAgentSettings['entries'][number]['settingsLevel'][],
): import('@craftingtable/contracts').RoadmapAgentSettings {
  const agent = {
    selection: { backend: 'codex' as const, model: 'assigned' },
    source: { layer: 'roadmap-assignment' as const, slot: 'design' as const, assignmentId: 'a-1' },
    permissionMode: 'auto' as const,
  };
  return {
    id,
    name: 'Stack roadmap',
    version: 3,
    status: 'needs-attention',
    editBlocker: null,
    entries: levels.map((settingsLevel, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      label: `E-${index}`,
      projectId: 'p' as never,
      projectName: 'P',
      selections: Object.fromEntries(
        ['design', 'implement', 'review', 'remediate'].map((s) => [
          s,
          { backend: 'codex', model: 'assigned' },
        ]),
      ) as never,
      agents: Object.fromEntries(
        AGENT_PROFILE_PURPOSES.map((purpose) => [purpose, agent]),
      ) as never,
      permissions: { design: 'auto', implement: 'auto', review: 'auto', remediate: 'auto' },
      activity: 'development',
      ...(settingsLevel === undefined ? {} : { settingsLevel }),
      started: false,
    })),
  };
}
function savedRoadmap() {
  return {
    id,
    status: 'needs-attention',
    version: 3,
    attempts: [],
    definition: {
      entries: [],
      revision: 2,
      name: 'Stack roadmap',
      scheduling: { maxInFlight: 2, maxPerRepository: 2, maxIntegrationRefreshes: 3 },
      crossProject: {
        definitionId: id,
        bindingRevision: 1,
        targetId: 'PROOF',
        selection: 'target-only',
        parentAcceptance: 'manual',
        overrides: [],
        defaults: {
          reviewerRoles: ['independent-integration-reviewer'],
          profiles: Object.fromEntries(
            ['design', 'implement', 'review', 'remediate'].map((step) => [
              step,
              { backend: 'codex', permissionMode: 'auto' },
            ]),
          ),
          policy: { maxNits: 0, maxRemediationRounds: 3, maxRunMinutes: 60 },
          instructions: '',
          automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
        },
      },
    },
  } as unknown as Roadmap;
}
it('opens the exact reviewer checkboxes, retains other assignments, and saves changes only once', async () => {
  const roadmap = savedRoadmap(),
    changed = vi.fn();
  setup(
    roadmap,
    {
      planAcceptance: {
        roadmaps: [
          { roadmapId: id, definitionRevision: 2, state: 'accepted', submissionId: 'facts' },
        ],
      },
    } as import('@craftingtable/contracts').RuntimeEvidenceView,
    changed,
  );
  await screen.findByText(/Accepted for saved revision 2/);
  const save = screen.getByRole('button', { name: 'Save queued roadmap settings' });
  expect(save.hasAttribute('disabled')).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Assign independent reviewer responsibilities' }),
  );
  expect(document.activeElement?.id).toBe(`map-reviewers-roadmap-${id}`);
  expect((document.getElementById(`map-settings-roadmap-${id}`) as HTMLDetailsElement).open).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'repository-maintainer' }));
  expect(
    (screen.getByRole('checkbox', { name: 'independent-integration-reviewer' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(screen.getByText(/Unsaved changes. Save these settings/)).toBeTruthy();
  // R-C6: the save carries the accepted plan forward.
  screen.getByText(
    'Save first. Acceptance covers saved settings only; your save carries the accepted plan forward.',
  );
  expect(screen.getByRole('button', { name: 'View accepted plan' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(changed).toHaveBeenLastCalledWith(id, true);
  vi.mocked(saveCrossProject).mockResolvedValue({
    roadmap: { ...roadmap, definition: { ...roadmap.definition, revision: 3 } },
  } as Awaited<ReturnType<typeof saveCrossProject>>);
  fireEvent.click(screen.getByRole('button', { name: 'Save reviewer and queued settings' }));
  await waitFor(() => expect(saveCrossProject).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(saveCrossProject).mock.calls[0]![1].configuration.defaults.reviewerRoles,
  ).toEqual(['independent-integration-reviewer', 'repository-maintainer']);
  await screen.findByText(/Saved · revision 3. No settings save needed/);
  expect(save.hasAttribute('disabled')).toBe(true);
  expect(changed).toHaveBeenLastCalledWith(id, false);
  expect(screen.queryByText(/Accepted for saved revision 2/)).toBeNull();
});

// R-C6 review L2: with no accepted plan there is nothing a save could carry.
it('promises no carried acceptance for unsaved settings when no plan is accepted', async () => {
  setup(savedRoadmap(), {
    planAcceptance: {
      roadmaps: [{ roadmapId: id, definitionRevision: 2, state: 'ready-to-generate' }],
    },
  } as import('@craftingtable/contracts').RuntimeEvidenceView);
  await screen.findByText(/Saved settings need a new acceptance review/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Assign independent reviewer responsibilities' }),
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'repository-maintainer' }));
  screen.getByText('Save first. Acceptance covers saved settings only.');
});

it("re-reads the target's prerequisites on its map's evidence and roadmap events, and when the environment is saved (R-D4)", async () => {
  const { store, wrap, send } = testQueryStore();
  setup(undefined, undefined, undefined, wrap);
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  expect(previewCrossProject).toHaveBeenCalledTimes(1);
  await send('runtime-evidence-changed', {
    workspaceId: ws,
    payload: { definitionId: '00000000-0000-4000-8000-000000000000', message: 'x' },
  });
  await send('source-repository-registered', { workspaceId: ws });
  expect(previewCrossProject).toHaveBeenCalledTimes(1);
  await send('runtime-evidence-changed', {
    workspaceId: ws,
    payload: { definitionId: id, message: 'x' },
  });
  await waitFor(() => expect(previewCrossProject).toHaveBeenCalledTimes(2));
  await send('roadmap-changed', { workspaceId: ws, payload: { roadmapId: 'r' } });
  await waitFor(() => expect(previewCrossProject).toHaveBeenCalledTimes(3));
  // The environment's panel saved setup: its map's previews are read again (was a window event).
  store.refreshNow([['cross-project', ws, id]]);
  await waitFor(() => expect(previewCrossProject).toHaveBeenCalledTimes(4));
});

it("reads the map's environment again after adopting, and re-offers the controls only with the preview read again (R-D4 review M22, F8)", async () => {
  const { store, wrap } = testQueryStore();
  // The environment's panel, watching its key in the same store.
  const environment = vi.fn(async () => ({ generation: 1 }));
  store.subscribe(['runtime', ws, id], environment, () => undefined);
  setup(undefined, undefined, undefined, wrap);
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  const adopt = screen.getByRole('button', { name: 'Adopt scheduling proposals' });
  fireEvent.click(screen.getByLabelText(/I approve all listed/));
  fireEvent.change(screen.getByLabelText('Adoption rationale'), {
    target: { value: 'Reviewed preserved obligations.' },
  });
  vi.mocked(request).mockResolvedValue({ adopted: true });
  // The preview read after the command answers only when told.
  let answer: () => void = () => undefined;
  const previewed = vi.mocked(previewCrossProject).getMockImplementation()!;
  vi.mocked(previewCrossProject).mockImplementationOnce(
    (...args) =>
      new Promise((resolve) => {
        answer = () => resolve(previewed(...args));
      }),
  );
  const before = environment.mock.calls.length;
  fireEvent.click(adopt);
  await waitFor(() => expect(adoptions()).toHaveLength(1));
  await waitFor(() => expect(environment.mock.calls.length).toBe(before + 1));
  // Busy until the preview is read again: no second adoption from a stale list.
  expect(
    (screen.getByRole('button', { name: 'Refresh scope and evidence' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  answer();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Refresh scope and evidence' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

// R-D4 increment 4c (PERF-10): a map read again renders only the milestones that changed.
it("renders only the changed milestone's card when the map's preview changes", async () => {
  const { store, wrap } = testQueryStore();
  setup(undefined, undefined, undefined, wrap);
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  const preview = await vi.mocked(previewCrossProject).mock.results[0]!.value;
  vi.mocked(phaseLabel).mockClear();
  // One milestone's status changes: its card alone renders, the others keep theirs.
  vi.mocked(previewCrossProject).mockResolvedValue({
    ...preview,
    nodes: preview.nodes.map((node: { key: string }) =>
      node.key === 'slice:wi/WI-01/core:verified' ? { ...node, status: 'Under review' } : node,
    ),
  });
  store.refreshNow([['cross-project', ws, id]]);
  await screen.findByText('Under review');
  expect(vi.mocked(phaseLabel)).toHaveBeenCalledTimes(1);
});

it('shows a settings level’s agents from its entries and applies a change to them alone, without a settings save (R-E5b)', async () => {
  const roadmap = savedRoadmap();
  const view = agentView(['defaults', 'defaults', { level: 'activity', key: 'development' }]);
  vi.mocked(loadRoadmapAgents).mockResolvedValue(view);
  vi.mocked(applyRoadmapAgents).mockResolvedValue({ ...view, version: 4 });
  setup(roadmap);
  fireEvent.click(await screen.findByText('Queued settings and overrides'));
  const agents = await screen.findByRole('group', { name: 'Default agents' });
  await waitFor(() =>
    expect(within(agents).getAllByText(/Roadmap assignment/).length).toBeGreaterThan(0),
  );
  fireEvent.click(within(agents).getByRole('button', { name: 'Change agents' }));
  const implementation = within(agents).getByRole('group', { name: 'Implementation' });
  fireEvent.change(within(implementation).getByLabelText('Reasoning effort'), {
    target: { value: 'high' },
  });
  const save = screen.getByRole('button', { name: 'Save queued roadmap settings' });
  await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(applyRoadmapAgents).toHaveBeenCalledTimes(1));
  expect(saveCrossProject).not.toHaveBeenCalled();
  const [, roadmapId, version, groups] = vi.mocked(applyRoadmapAgents).mock.calls[0]!;
  expect([roadmapId, version]).toEqual([id, 3]);
  expect(groups).toEqual([
    {
      entryIds: [view.entries[0]!.id, view.entries[1]!.id],
      selections: {
        ...view.entries[0]!.selections,
        implement: { backend: 'codex', model: 'assigned', reasoningEffort: 'high' },
      },
    },
  ]);
  await screen.findByText('Agents applied to future runs. Plan acceptance is unaffected.');
});

it('keeps a roadmap it created when its agents are refused, and retries only the agents (review MEDIUM-2)', async () => {
  const onCreated = vi.fn();
  setup(undefined, undefined, undefined, (ui) =>
    cloneElement(ui as ReactElement<{ onCreated?: (id: string) => void }>, { onCreated }),
  );
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  fireEvent.click(screen.getByText('Roadmap agent and automation settings'));
  const agents = await screen.findByRole('group', { name: 'Default agents' });
  fireEvent.click(within(agents).getByRole('button', { name: 'Change agents' }));
  fireEvent.change(
    within(within(agents).getByRole('group', { name: 'Design' })).getByLabelText(
      'Reasoning effort',
    ),
    { target: { value: 'high' } },
  );
  vi.mocked(saveCrossProject).mockResolvedValue({
    roadmap: { id: 'new-roadmap', version: 1, definition: { name: 'Cross-project roadmap' } },
  } as Awaited<ReturnType<typeof saveCrossProject>>);
  const view = agentView(['defaults']);
  vi.mocked(loadRoadmapAgents).mockResolvedValue({ ...view, id: 'new-roadmap', version: 1 });
  vi.mocked(applyRoadmapAgents).mockRejectedValueOnce(new Error('Use a model id.'));
  const create = screen.getByRole('button', { name: 'Create cross-project roadmap' });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'The roadmap was created, but its agents were not applied',
  );
  expect(onCreated).not.toHaveBeenCalled();
  vi.mocked(applyRoadmapAgents).mockResolvedValueOnce({ ...view, version: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Create cross-project roadmap' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-roadmap'));
  // One roadmap: the retry did not save a second one.
  expect(saveCrossProject).toHaveBeenCalledTimes(1);
  expect(vi.mocked(applyRoadmapAgents).mock.calls[1]?.[1]).toBe('new-roadmap');
});

/** A saved map roadmap with an activity override for development entries. */
function savedWithOverride() {
  const roadmap = savedRoadmap();
  const cp = roadmap.definition.crossProject!;
  return {
    ...roadmap,
    definition: {
      ...roadmap.definition,
      crossProject: {
        ...cp,
        overrides: [{ level: 'activity', key: 'development', settings: cp.defaults }],
      },
    },
  } as unknown as Roadmap;
}
/** Changes one settings level's design effort through its own agents group. */
function changeLevel(group: HTMLElement, effort: string) {
  fireEvent.click(within(group).getByRole('button', { name: 'Change agents' }));
  fireEvent.change(
    within(within(group).getByRole('group', { name: 'Design' })).getByLabelText('Reasoning effort'),
    { target: { value: effort } },
  );
}

it('does not send a level’s applied agents again after a later level is refused (review N08)', async () => {
  const view = agentView(['defaults', { level: 'activity', key: 'development' }]);
  vi.mocked(loadRoadmapAgents).mockResolvedValue(view);
  vi.mocked(applyRoadmapAgents).mockImplementationOnce(
    async (_ws, _id, _version, groups, _csrf, onApplied) => {
      onApplied?.(groups[0]!, { ...view, version: 4 });
      throw new Error('Refused.');
    },
  );
  setup(savedWithOverride());
  fireEvent.click(await screen.findByText('Queued settings and overrides'));
  const defaults = await screen.findByRole('group', { name: 'Default agents' });
  await waitFor(() =>
    expect(within(defaults).getAllByText(/Roadmap assignment/).length).toBeGreaterThan(0),
  );
  changeLevel(defaults, 'high');
  changeLevel(screen.getByRole('group', { name: 'Agents for this override' }), 'low');
  const save = screen.getByRole('button', { name: 'Save queued roadmap settings' });
  fireEvent.click(save);
  await screen.findByText(/Refused\./);
  vi.mocked(applyRoadmapAgents).mockResolvedValueOnce({ ...view, version: 5 });
  fireEvent.click(save);
  await waitFor(() => expect(applyRoadmapAgents).toHaveBeenCalledTimes(2));
  expect(vi.mocked(applyRoadmapAgents).mock.calls[1]?.[3].map((g) => g.entryIds)).toEqual([
    [view.entries[1]!.id],
  ]);
  expect(saveCrossProject).not.toHaveBeenCalled();
});

it('shows a new, unsaved override the default agents it starts from (review N10)', async () => {
  vi.mocked(loadRoadmapAgents).mockResolvedValue(agentView(['defaults', 'defaults']));
  setup(savedRoadmap());
  fireEvent.click(await screen.findByText('Queued settings and overrides'));
  await screen.findByRole('group', { name: 'Default agents' });
  fireEvent.change(screen.getByLabelText('Override level'), { target: { value: 'activity' } });
  fireEvent.change(screen.getByLabelText('Override scope'), { target: { value: 'development' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add settings override' }));
  expect(screen.getByText(/A new override starts from the default agents below/)).toBeTruthy();
  const agents = screen.getByRole('group', { name: 'Agents for this override' });
  expect(within(agents).getAllByText(/Roadmap assignment/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/No entry takes these settings/)).toBeNull();
});
