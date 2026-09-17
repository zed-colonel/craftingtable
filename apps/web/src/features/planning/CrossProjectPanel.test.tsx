import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { asWorkItemId, asWorkspaceId } from '@craftingtable/domain';
import { CrossProjectPanel } from './CrossProjectPanel.js';
import {
  previewCrossProject,
  saveCrossProject,
  adoptCrossProject,
} from '../../lib/cross-project-api.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
vi.mock('../../lib/cross-project-api.js', () => ({
  previewCrossProject: vi.fn(),
  saveCrossProject: vi.fn(),
  adoptCrossProject: vi.fn(),
}));
vi.mock('../../lib/execution-api.js', () => ({
  loadExecutionStatus: vi.fn(),
  loadRunProfiles: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const id = '12345678-1234-4234-8234-123456789abc',
  ws = asWorkspaceId('workspace');
function setup() {
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
    reviewerRoles: [],
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
    setupRequirements: [{ kind: 'adoption', message: 'Review scheduling decisions.' }],
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
    <CrossProjectPanel
      workspaceId={ws}
      definitionId={id}
      bindingRevision={1}
      targets={[{ id: 'PROOF', scope: 'Native proof only' }]}
      csrfToken="csrf"
      canMutate
    />,
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
  const adopt = screen.getByRole('button', { name: 'Adopt map decisions' });
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
