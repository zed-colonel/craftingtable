import type { RoadmapAgentSettings, RunProfilesResponse } from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  type AgentSelections,
  asWorkspaceId,
  CYCLE_STEPS,
  DEFAULT_COMPLETION_POLICY,
  type EffectiveAgent,
  type Roadmap,
  type RoadmapView,
} from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyRoadmapAgents, loadRoadmapAgents, saveRoadmap } from '../../lib/roadmap-api.js';
import { type Draft, draftOf, RoadmapEditor } from './RoadmapEditor.js';

vi.mock('../../lib/roadmap-api.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/roadmap-api.js')>()),
  saveRoadmap: vi.fn(),
  loadRoadmapAgents: vi.fn(),
  applyRoadmapAgents: vi.fn(),
}));
vi.mock('../../lib/planning-api.js', () => ({
  loadWorkspaceWorkItems: vi.fn(async () => ({ items: [] })),
}));
vi.mock('../../lib/execution-scope-api.js', () => ({
  loadExecutionScopes: vi.fn(async () => ({ choices: [] })),
}));
vi.mock('../../lib/execution-api.js', () => ({
  loadExecutionStatus: vi.fn(async () => ({
    backends: [
      {
        kind: 'claude-code',
        label: 'Claude Code',
        available: true,
        models: [
          { id: 'opus', label: 'Opus', section: 'main', hidden: false },
          { id: 'sonnet', label: 'Sonnet', section: 'main', hidden: false },
        ],
        catalog: { source: 'catalog' },
      },
    ],
  })),
  loadRunProfiles: vi.fn(async () => workspaceDefaults),
}));

afterEach(cleanup);

/**
 * R-E5b, E5-1 as amended: the roadmap editor shows each entry's agents as the daemon reports
 * them, saves the definition's step permissions, and applies changed agents as assignments.
 */
const workspaceId = asWorkspaceId('ws-1');
const roadmapId = '00000000-0000-4000-8000-000000000010';
const entryId = '00000000-0000-4000-8000-000000000011';
const agentsAt = (source: EffectiveAgent['source'], model = 'opus') =>
  Object.fromEntries(
    AGENT_PROFILE_PURPOSES.map((purpose) => [
      purpose,
      { selection: { backend: 'claude-code', model }, source, permissionMode: 'auto' },
    ]),
  ) as NonNullable<RunProfilesResponse['agents']>;
const selections = (model: string) =>
  Object.fromEntries(
    CYCLE_STEPS.map((step) => [step, { backend: 'claude-code', model }]),
  ) as unknown as AgentSelections;
const workspaceDefaults: RunProfilesResponse = {
  profiles: [],
  agents: agentsAt({ layer: 'workspace-default', slot: 'implement' }),
  selections: selections('opus'),
};
const profiles = Object.fromEntries(
  CYCLE_STEPS.map((step) => [
    step,
    { backend: 'claude-code', model: 'opus', permissionMode: 'auto' },
  ]),
) as unknown as Roadmap['definition']['entries'][number]['profiles'];
const roadmap = {
  id: roadmapId,
  workspaceId,
  version: 4,
  status: 'paused',
  attempts: [],
  definition: {
    roadmapId,
    revision: 2,
    name: 'Queue roadmap',
    scheduling: {
      mode: 'sequential',
      maxInFlight: 2,
      maxPerRepository: 2,
      maxIntegrationRefreshes: 3,
    },
    entries: [
      {
        id: entryId,
        workItemId: 'item-1',
        profiles,
        policy: DEFAULT_COMPLETION_POLICY,
        instructions: '',
        projectId: 'project-1',
        planVersionId: 'version-1',
        sourceId: 'AQ-01',
        title: 'Establish the queue',
        repositoryId: 'repo-1',
        integrationBranch: 'main',
      },
    ],
  },
} as unknown as Roadmap;
const saved: RoadmapAgentSettings = {
  id: roadmapId,
  name: 'Queue roadmap',
  version: 4,
  status: 'paused',
  editBlocker: null,
  entries: [
    {
      id: entryId,
      label: 'AQ-01',
      projectId: 'project-1' as never,
      projectName: 'Project',
      selections: selections('opus'),
      agents: agentsAt({ layer: 'roadmap-assignment', slot: 'design', assignmentId: 'a-1' }),
      permissions: { design: 'auto', implement: 'auto', review: 'auto', remediate: 'auto' },
      started: false,
    },
  ],
};

function Editor({
  current,
  initial,
  onSaved,
}: {
  current?: Roadmap;
  initial: Draft;
  onSaved: (view: RoadmapView | undefined, assigned: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <RoadmapEditor
      workspaceId={workspaceId}
      csrfToken="csrf"
      draft={draft}
      setDraft={setDraft}
      current={current}
      onSaved={onSaved}
      onCancel={vi.fn()}
    />
  );
}

/** Opens the entry's agents and picks another implementation model. */
async function changeImplementation(model: string) {
  const entry = await screen.findByRole('group', { name: 'Agents' });
  await waitFor(() =>
    expect(within(entry).getByRole('button', { name: 'Change agents' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  fireEvent.click(within(entry).getByRole('button', { name: 'Change agents' }));
  const implementation = within(entry).getByRole('group', { name: 'Implementation' });
  fireEvent.change(within(implementation).getByLabelText('Model'), { target: { value: model } });
}

beforeEach(() => {
  vi.mocked(saveRoadmap).mockReset();
  vi.mocked(applyRoadmapAgents).mockReset();
  vi.mocked(loadRoadmapAgents).mockReset().mockResolvedValue(saved);
});

it('shows a saved entry’s agents with their source, and applies a change as an assignment without saving the definition', async () => {
  const onSaved = vi.fn();
  vi.mocked(applyRoadmapAgents).mockResolvedValue({ ...saved, version: 5 });
  render(<Editor current={roadmap} initial={draftOf(roadmap)} onSaved={onSaved} />);
  const entry = await screen.findByRole('group', { name: 'Agents' });
  await waitFor(() =>
    expect(within(entry).getAllByText(/Roadmap assignment/).length).toBeGreaterThan(0),
  );
  await changeImplementation('sonnet');
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(undefined, true));
  expect(saveRoadmap).not.toHaveBeenCalled();
  expect(applyRoadmapAgents).toHaveBeenCalledWith(
    workspaceId,
    roadmapId,
    4,
    [
      {
        entryIds: [entryId],
        selections: {
          ...selections('opus'),
          implement: { backend: 'claude-code', model: 'sonnet' },
        },
      },
    ],
    'csrf',
  );
});

it('saves the permissions it changed, never an agent, then applies the agents at the saved version', async () => {
  const onSaved = vi.fn();
  const view = { roadmap: { ...roadmap, version: 5 } } as unknown as RoadmapView;
  vi.mocked(saveRoadmap).mockResolvedValue(view as never);
  vi.mocked(applyRoadmapAgents).mockResolvedValue({ ...saved, version: 6 });
  render(<Editor current={roadmap} initial={draftOf(roadmap)} onSaved={onSaved} />);
  await changeImplementation('sonnet');
  fireEvent.click(screen.getByText('Agents, models, and completion policy'));
  fireEvent.change(screen.getByLabelText('Review permissions'), {
    target: { value: 'edit-only' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(view, true));
  const sent = vi.mocked(saveRoadmap).mock.calls[0]?.[2];
  expect(sent?.entries[0]?.permissions.review).toBe('edit-only');
  expect(sent?.entries[0]).not.toHaveProperty('profiles');
  expect(vi.mocked(applyRoadmapAgents).mock.calls[0]?.[2]).toBe(5);
});

it('keeps the editor open when the agents fail after the save, and retries only the agents', async () => {
  const onSaved = vi.fn();
  // The save answers the renamed definition.
  const view = {
    roadmap: { ...roadmap, version: 5, definition: { ...roadmap.definition, name: 'Renamed' } },
  } as unknown as RoadmapView;
  vi.mocked(saveRoadmap).mockResolvedValue(view as never);
  vi.mocked(applyRoadmapAgents)
    .mockRejectedValueOnce(new Error('Use the model id "sonnet".'))
    .mockResolvedValueOnce({ ...saved, version: 6 });
  render(<Editor current={roadmap} initial={draftOf(roadmap)} onSaved={onSaved} />);
  await changeImplementation('sonnet');
  fireEvent.change(screen.getByLabelText('Roadmap name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The roadmap was saved, but its agents were not applied: Use the model id "sonnet".',
  );
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(view, true));
  expect(saveRoadmap).toHaveBeenCalledTimes(1);
  expect(vi.mocked(applyRoadmapAgents).mock.calls[1]?.[2]).toBe(5);
});

it('shows a new entry the workspace defaults the daemon will store', async () => {
  render(
    <Editor
      initial={{
        id: roadmapId,
        expectedVersion: 0,
        name: 'New',
        entries: [
          {
            id: entryId,
            workItemId: 'item-1' as never,
            permissions: { design: 'auto', implement: 'auto', review: 'auto', remediate: 'auto' },
            policy: DEFAULT_COMPLETION_POLICY,
            instructions: '',
          },
        ],
      }}
      onSaved={vi.fn()}
    />,
  );
  const entry = await screen.findByRole('group', { name: 'Agents' });
  await waitFor(() =>
    expect(within(entry).getAllByText(/Workspace default/).length).toBeGreaterThan(0),
  );
  expect(loadRoadmapAgents).not.toHaveBeenCalled();
});
