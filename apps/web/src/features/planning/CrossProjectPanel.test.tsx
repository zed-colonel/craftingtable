import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { asWorkItemId, asWorkspaceId, type Roadmap } from '@craftingtable/domain';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import {
  previewCrossProject,
  saveCrossProject,
  adoptCrossProject,
} from '../../lib/cross-project-api.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { phaseLabel } from './DependencyRequirements.js';
vi.mock('../../lib/cross-project-api.js', () => ({
  previewCrossProject: vi.fn(),
  saveCrossProject: vi.fn(),
  adoptCrossProject: vi.fn(),
}));
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
  vi.mocked(loadExecutionStatus).mockResolvedValue({
    backends: [{ kind: 'codex', label: 'Codex', available: true, models: [] }],
    git: { available: true },
  });
  vi.mocked(loadRunProfiles).mockResolvedValue({
    profiles: ['design', 'implement', 'review'].map((role) => ({
      role: role as 'design',
      backend: 'codex',
      permissionMode: 'auto',
      stored: true,
    })),
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
it('requires explicit target choice and adoption rationale, with a trace to the provider action', async () => {
  setup();
  expect((screen.getByLabelText('Planning target') as HTMLSelectElement).value).toBe('');
  expect(previewCrossProject).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  expect(adoptCrossProject).not.toHaveBeenCalled();
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
  vi.mocked(adoptCrossProject).mockResolvedValue({ adopted: true });
  fireEvent.click(adopt);
  await waitFor(() =>
    expect(adoptCrossProject).toHaveBeenCalledWith(
      ws,
      id,
      1,
      ['D1'],
      'Reviewed preserved obligations.',
      'csrf',
    ),
  );
  expect(saveCrossProject).not.toHaveBeenCalled();
});
it('saves a draft with manual parent acceptance and inherited profiles; creation never starts work', async () => {
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
  expect(sent.configuration.defaults.profiles.review.backend).toBe('codex');
  expect(sent.configuration.defaults.automation.integrationMerge).toBe('manual');
  expect(sent.expectedVersion).toBe(0);
  expect(adoptCrossProject).not.toHaveBeenCalled();
});

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
  await send('repository-registered', { workspaceId: ws, repositoryId: 'repo' });
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
  vi.mocked(adoptCrossProject).mockResolvedValue({ adopted: true });
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
  await waitFor(() => expect(adoptCrossProject).toHaveBeenCalled());
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
it("renders only the changed milestone's card when the map's preview is read again", async () => {
  const { store, wrap } = testQueryStore();
  setup(undefined, undefined, undefined, wrap);
  fireEvent.change(screen.getByLabelText('Planning target'), { target: { value: 'PROOF' } });
  await screen.findByText('2 selected milestones');
  const preview = await vi.mocked(previewCrossProject).mock.results[0]!.value;
  vi.mocked(phaseLabel).mockClear();
  // The same preview again: no card renders.
  store.refreshNow([['cross-project', ws, id]]);
  await waitFor(() => expect(previewCrossProject).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText('2 selected milestones')).toBeTruthy());
  expect(vi.mocked(phaseLabel)).toHaveBeenCalledTimes(0);
  // One milestone's status changes: its card alone renders.
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
