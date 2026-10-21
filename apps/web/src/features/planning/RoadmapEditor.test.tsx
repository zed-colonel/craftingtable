import type { RoadmapAgentSettings, RunProfilesResponse } from '@craftingtable/contracts';
import {
  AGENT_PROFILE_PURPOSES,
  type AgentSelections,
  asAgentAssignmentId,
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
import { cycleDefaultMinutes } from '../../lib/cycle-defaults-api.js';
import { loadWorkspaceWorkItems } from '../../lib/planning-api.js';
import { applyRoadmapAgents, loadRoadmapAgents, saveRoadmap } from '../../lib/roadmap-api.js';
import { type Draft, draftOf, RoadmapEditor } from './RoadmapEditor.js';

vi.mock('../../lib/roadmap-api.js', async (actual) => ({
  ...(await actual<typeof import('../../lib/roadmap-api.js')>()),
  saveRoadmap: vi.fn(),
  loadRoadmapAgents: vi.fn(),
  applyRoadmapAgents: vi.fn(),
}));
vi.mock('../../lib/cycle-defaults-api.js', () => ({
  cycleDefaultMinutes: vi.fn(async () => 120),
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
      agents: agentsAt({
        layer: 'roadmap-assignment',
        slot: 'design',
        assignmentId: asAgentAssignmentId('a-1'),
      }),
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
    expect.any(Function),
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

/** A saved roadmap of two entries, each with its agents as the setup view reports them. */
const second = '00000000-0000-4000-8000-000000000012';
const twoEntries = {
  ...roadmap,
  definition: {
    ...roadmap.definition,
    entries: [
      roadmap.definition.entries[0]!,
      { ...roadmap.definition.entries[0]!, id: second, workItemId: 'item-2', sourceId: 'AQ-02' },
    ],
  },
} as unknown as Roadmap;
const twoSaved: RoadmapAgentSettings = {
  ...saved,
  entries: [saved.entries[0]!, { ...saved.entries[0]!, id: second, label: 'AQ-02' }],
};
/** Changes one entry's implementation model through its own Agents group. */
async function changeEntry(index: number, model: string) {
  const groups = await screen.findAllByRole('group', { name: 'Agents' });
  const entry = groups[index]!;
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
function openEntries() {
  for (const summary of screen.getAllByText('Agents, models, and completion policy'))
    fireEvent.click(summary);
}

it('keeps going from what took effect when a later agent set is refused (review LOW-1)', async () => {
  vi.mocked(loadRoadmapAgents).mockResolvedValue(twoSaved);
  const onSaved = vi.fn();
  vi.mocked(applyRoadmapAgents).mockImplementationOnce(
    async (_ws, _id, _version, groups, _csrf, onApplied) => {
      onApplied?.(groups[0]!, { ...twoSaved, version: 5 });
      throw new Error('Use the model id "sonnet".');
    },
  );
  render(<Editor current={twoEntries} initial={draftOf(twoEntries)} onSaved={onSaved} />);
  openEntries();
  await changeEntry(0, 'sonnet');
  await changeEntry(1, 'opus-next');
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Some agents were applied (1 entries); the rest were not: Use the model id "sonnet".',
  );
  // The applied set is not sent again, and the next save goes on from the version it left.
  vi.mocked(applyRoadmapAgents).mockResolvedValueOnce({ ...twoSaved, version: 6 });
  const save = screen.getByRole('button', { name: 'Save roadmap' }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(undefined, true));
  const [, , version, groups] = vi.mocked(applyRoadmapAgents).mock.calls[1]!;
  expect(version).toBe(5);
  expect(groups.map((g) => g.entryIds)).toEqual([[second]]);
  expect(saveRoadmap).not.toHaveBeenCalled();
});

it('drops the agent change of an entry removed before saving (W05)', async () => {
  vi.mocked(loadRoadmapAgents).mockResolvedValue(twoSaved);
  const onSaved = vi.fn();
  vi.mocked(saveRoadmap).mockResolvedValue({ roadmap: { ...twoEntries, version: 5 } } as never);
  render(<Editor current={twoEntries} initial={draftOf(twoEntries)} onSaved={onSaved} />);
  openEntries();
  await changeEntry(1, 'sonnet');
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove entry' })[1]!);
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(applyRoadmapAgents).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledWith(expect.anything(), false);
});

it('shows a saved entry’s agents as loading, not as the workspace defaults, until they are read (review LOW-2)', async () => {
  vi.mocked(loadRoadmapAgents).mockReturnValue(new Promise(() => undefined));
  render(<Editor current={roadmap} initial={draftOf(roadmap)} onSaved={vi.fn()} />);
  const entry = await screen.findByRole('group', { name: 'Agents' });
  await waitFor(() => expect(within(entry).getByText('Loading the current agents…')).toBeTruthy());
  expect(within(entry).queryByText(/Workspace default/)).toBeNull();
  expect(
    (within(entry).getByRole('button', { name: 'Change agents' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('after a save and a partly refused agent change, retries only the agents at the version they left (review N14)', async () => {
  vi.mocked(loadRoadmapAgents).mockResolvedValue(twoSaved);
  const onSaved = vi.fn();
  const view = {
    roadmap: {
      ...twoEntries,
      version: 5,
      definition: { ...twoEntries.definition, name: 'Renamed' },
    },
  } as unknown as RoadmapView;
  vi.mocked(saveRoadmap).mockResolvedValue(view as never);
  vi.mocked(applyRoadmapAgents).mockImplementationOnce(
    async (_ws, _id, version, groups, _csrf, onApplied) => {
      expect(version).toBe(5);
      onApplied?.(groups[0]!, { ...twoSaved, version: 6 });
      throw new Error('Refused.');
    },
  );
  render(<Editor current={twoEntries} initial={draftOf(twoEntries)} onSaved={onSaved} />);
  openEntries();
  await changeEntry(0, 'sonnet');
  await changeEntry(1, 'opus-next');
  fireEvent.change(screen.getByLabelText('Roadmap name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await screen.findByRole('alert');
  vi.mocked(applyRoadmapAgents).mockResolvedValueOnce({ ...twoSaved, version: 7 });
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(view, true));
  expect(saveRoadmap).toHaveBeenCalledTimes(1);
  const [, , version, groups] = vi.mocked(applyRoadmapAgents).mock.calls[1]!;
  expect(version).toBe(6);
  expect(groups.map((g) => g.entryIds)).toEqual([[second]]);
});

// R-C17 part 4: a new entry starts from the workspace's default step time limit (increment 5),
// 120 minutes per step while none is saved (increment 1 review M-4).
it.each([
  [120, 120],
  [45, 45],
])(
  'seeds a new entry with the workspace default (%s), %s minutes per step',
  async (saved, expected) => {
    vi.mocked(cycleDefaultMinutes).mockResolvedValueOnce(saved);
    vi.mocked(loadWorkspaceWorkItems).mockResolvedValueOnce({
      items: [
        {
          id: 'item-2',
          projectId: 'project-1',
          projectName: 'Project',
          planVersionId: 'version-1',
          sourceId: 'AQ-02',
          title: 'Continue the queue',
          status: 'pending',
        },
      ],
    } as never);
    const empty = { ...draftOf(roadmap), entries: [] };
    let latest: Draft | undefined;
    function Probe() {
      const [draft, setDraft] = useState<Draft>(empty);
      latest = draft;
      return (
        <RoadmapEditor
          workspaceId={workspaceId}
          csrfToken="csrf"
          draft={draft}
          setDraft={setDraft}
          current={undefined}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    }
    render(<Probe />);
    const select = screen.getByLabelText('Add work item') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: 'item-2' } });
    const add = screen.getByRole('button', { name: 'Add to sequence' }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() => expect(latest?.entries).toHaveLength(1));
    expect(latest?.entries[0]?.policy.maxRunMinutes).toBe(expected);
  },
);

it('edits a running roadmap’s queued entries, held to the revision it showed rather than the roadmap’s version (R-B6, decisions 5 and 10)', async () => {
  const running = { ...roadmap, status: 'running' } as Roadmap;
  const onSaved = vi.fn();
  vi.mocked(saveRoadmap).mockResolvedValue({ roadmap: running } as never);
  const { rerender } = render(
    <Editor current={running} initial={draftOf(running)} onSaved={onSaved} />,
  );
  expect(
    screen.getByText(
      'Started items keep their saved settings except their agents, which apply from each entry’s next step; steps running now keep theirs.',
    ),
  ).toBeTruthy();
  // The running roadmap writes itself as its items move: a newer version alone dates nothing.
  rerender(
    <Editor current={{ ...running, version: 9 }} initial={draftOf(running)} onSaved={onSaved} />,
  );
  expect(screen.queryByText(/This roadmap changed while you were editing/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Roadmap name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(vi.mocked(saveRoadmap).mock.calls[0]?.[2]).toMatchObject({
    expectedVersion: 4,
    expectedRevision: 2,
    name: 'Renamed',
  });
  // A new revision does date it.
  rerender(
    <Editor
      current={{ ...running, version: 10, definition: { ...running.definition, revision: 3 } }}
      initial={draftOf(running)}
      onSaved={onSaved}
    />,
  );
  expect(screen.getByText(/This roadmap changed while you were editing/)).toBeTruthy();
});

it('saves nothing for an unchanged draft of a running roadmap whose version moved on (R-B6, mutation round W1-editor-content-version)', async () => {
  const running = { ...roadmap, status: 'running' } as Roadmap;
  const onSaved = vi.fn();
  render(
    <Editor current={{ ...running, version: 9 }} initial={draftOf(running)} onSaved={onSaved} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(saveRoadmap).not.toHaveBeenCalled();
});
