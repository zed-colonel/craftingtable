import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  type AgentSelections,
  CYCLE_STEPS,
  type CycleAction,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
} from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CycleDecision } from './CycleDecision.js';
import { CycleSettings, cycleSettingsKey } from './CycleSettings.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

/**
 * R-C17 part 4, decision 10: a stopped cycle's time limit and agents, the one poster of the
 * control's `change-settings`. It posts only what changed, and only where the daemon offers it.
 */

const backends = [
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
] as unknown as ExecutionStatusResponse['backends'];
const now = Object.fromEntries(
  CYCLE_STEPS.map((step) => [step, { backend: 'claude-code', model: 'opus' }]),
) as unknown as AgentSelections;
const cycle = {
  id: 'c1',
  workspaceId: 'ws',
  version: 7,
  status: 'needs-attention',
  policy: DEFAULT_COMPLETION_POLICY,
} as unknown as WorkCycle;
const view = (actions: readonly CycleAction[], c: WorkCycle = cycle) =>
  render(
    <CycleSettings
      cycle={c}
      projection={{ actions: [...actions], nextAgentSelections: now }}
      backends={backends}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
const posted = () =>
  vi.mocked(request).mock.calls.map(([url, , init]) => ({
    url: String(url),
    body: JSON.parse(String(init?.body)),
  }));
const save = () =>
  screen.getByRole('button', { name: 'Save time limit and agents' }) as HTMLButtonElement;

it('renders nothing where the daemon does not offer the change', () => {
  view(['pause', 'stop']);
  expect(screen.queryByRole('form', { name: 'Time limit and agents' })).toBeNull();
});

it('posts a changed time limit alone, and only once something changed', async () => {
  vi.mocked(request).mockResolvedValue({});
  view(['resume', 'change-settings', 'stop']);
  const minutes = screen.getByLabelText('Minutes per step') as HTMLInputElement;
  expect(minutes.value).toBe('120');
  expect(save().disabled).toBe(true);
  fireEvent.change(minutes, { target: { value: '0' } });
  expect(save().disabled).toBe(true);
  fireEvent.change(minutes, { target: { value: '300' } });
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()).toEqual([
    {
      url: '/api/workspaces/ws/cycles/c1/control',
      body: { action: 'change-settings', expectedVersion: 7, maxRunMinutes: 300 },
    },
  ]);
});

it('posts the changed agents alone, naming each', async () => {
  vi.mocked(request).mockResolvedValue({});
  view(['resume', 'change-settings', 'stop']);
  const implementation = screen.getByRole('group', { name: 'Implementation' });
  fireEvent.change(within(implementation).getByLabelText('Model'), {
    target: { value: 'sonnet' },
  });
  expect(screen.getByText('Changing: Implementation.')).toBeTruthy();
  fireEvent.click(save());
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]?.body).toEqual({
    action: 'change-settings',
    expectedVersion: 7,
    agents: { implement: { backend: 'claude-code', model: 'sonnet' } },
  });
});

it('shows the daemon’s refusal', async () => {
  vi.mocked(request).mockRejectedValue(
    new Error('Cycle changed; refresh before issuing this command'),
  );
  view(['resume', 'change-settings', 'stop']);
  fireEvent.change(screen.getByLabelText('Minutes per step'), { target: { value: '60' } });
  fireEvent.click(save());
  expect((await screen.findByRole('alert')).textContent).toContain('Cycle changed');
});

it('sits in the stop’s Needs-you item, collapsed, and not twice on the work item page', () => {
  const decision = (inInbox: boolean) =>
    render(
      <CycleDecision
        cycle={
          { ...cycle, step: 'implement', currentRunId: 'run-1', reason: 'Stopped.' } as WorkCycle
        }
        projection={{
          actions: ['resume', 'change-settings', 'stop'],
          nextAgentSelections: now,
        }}
        runs={[]}
        readOnly={false}
        backends={backends}
        csrfToken="csrf"
        canMutate
        busy={false}
        onChanged={vi.fn()}
        onOpenRun={vi.fn()}
        onOpenWorktree={vi.fn()}
        inInbox={inInbox}
      />,
    );
  const item = decision(true);
  expect(screen.getByText('Time limit and agents', { selector: 'summary' })).toBeTruthy();
  item.unmount();
  // On the work item page the cycle panel's settings hold it.
  decision(false);
  expect(screen.queryByText('Time limit and agents', { selector: 'summary' })).toBeNull();
});

// Increment 4 review L-6 (and M-1, L-1, L-2, L-4, L-5, N-2, N-5): the behaviours its mutants found
// unpinned.
it('refuses minutes out of bounds or not whole, saying why', () => {
  view(['resume', 'change-settings', 'stop']);
  const minutes = screen.getByLabelText('Minutes per step') as HTMLInputElement;
  for (const value of ['1441', '2000', '1.5']) {
    fireEvent.change(minutes, { target: { value } });
    expect(save().disabled, value).toBe(true);
    expect(screen.getByText('Between 1 and 1440 minutes.')).toBeTruthy();
  }
  fireEvent.change(minutes, { target: { value: '1440' } });
  expect(save().disabled).toBe(false);
  expect(screen.queryByText('Between 1 and 1440 minutes.')).toBeNull();
});

it('is locked while disabled, and posts once, then waits for the changed cycle', async () => {
  let resolve: (value: unknown) => void = () => {};
  vi.mocked(request).mockReturnValue(new Promise((done) => (resolve = done)) as never);
  const onChanged = vi.fn();
  const locked = render(
    <CycleSettings
      cycle={cycle}
      projection={{ actions: ['resume', 'change-settings', 'stop'], nextAgentSelections: now }}
      backends={backends}
      csrfToken="csrf"
      disabled
      onChanged={onChanged}
    />,
  );
  expect((screen.getByLabelText('Minutes per step') as HTMLInputElement).disabled).toBe(true);
  locked.unmount();
  render(
    <CycleSettings
      cycle={cycle}
      projection={{ actions: ['resume', 'change-settings', 'stop'], nextAgentSelections: now }}
      backends={backends}
      csrfToken="csrf"
      disabled={false}
      onChanged={onChanged}
    />,
  );
  fireEvent.change(screen.getByLabelText('Minutes per step'), { target: { value: '60' } });
  fireEvent.click(save());
  fireEvent.click(save());
  expect(posted()).toHaveLength(1);
  resolve({});
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  // Sent: it stays locked until the cycle's new version starts it afresh.
  expect(save().disabled).toBe(true);
});

it('counts an agent changed and changed back as no change, whatever its keys’ order', () => {
  const seeded = {
    ...now,
    implement: { reasoningEffort: 'high', backend: 'claude-code', model: 'opus' },
  } as unknown as AgentSelections;
  render(
    <CycleSettings
      cycle={cycle}
      projection={{ actions: ['resume', 'change-settings', 'stop'], nextAgentSelections: seeded }}
      backends={backends}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
  const implementation = screen.getByRole('group', { name: 'Implementation' });
  fireEvent.change(within(implementation).getByLabelText('Model'), { target: { value: 'sonnet' } });
  expect(screen.getByText('Changing: Implementation.')).toBeTruthy();
  fireEvent.change(within(implementation).getByLabelText('Model'), { target: { value: 'opus' } });
  expect(screen.queryByText(/Changing:/)).toBeNull();
  expect(save().disabled).toBe(true);
});

it('keeps a specialist override in effect: changed here, not removed', () => {
  render(
    <CycleSettings
      cycle={cycle}
      projection={{
        actions: ['resume', 'change-settings', 'stop'],
        nextAgentSelections: { ...now, security: { backend: 'claude-code', model: 'sonnet' } },
      }}
      backends={backends}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
  const security = screen.getByRole('group', { name: 'Security review' });
  expect((within(security).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  expect(
    within(security).getByText('This override can be changed here, not removed.'),
  ).toBeTruthy();
});

it('offers a review-only cycle its review agent alone', () => {
  render(
    <CycleSettings
      cycle={cycle}
      projection={{ actions: ['resume', 'change-settings', 'stop'], nextAgentSelections: now }}
      backends={backends}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
      readOnly
    />,
  );
  expect(screen.getByRole('group', { name: 'Review' })).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Implementation' })).toBeNull();
});

it('says a roadmap cycle’s agents go to its entry, by its owner or its agents’ source', () => {
  const sentence = /applied to its roadmap entry as an assignment/;
  const hand = view(['resume', 'change-settings', 'stop']);
  expect(screen.queryByText(sentence)).toBeNull();
  hand.unmount();
  const owned = view(['resume', 'change-settings', 'stop'], {
    ...cycle,
    owner: { roadmapId: 'r' },
  } as unknown as WorkCycle);
  expect(screen.getByText(sentence)).toBeTruthy();
  owned.unmount();
  render(
    <CycleSettings
      cycle={cycle}
      projection={{
        actions: ['resume', 'change-settings', 'stop'],
        nextAgentSelections: now,
        agents: {
          review: { selection: now.review, source: { layer: 'saved-definition', slot: 'review' } },
        } as never,
      }}
      backends={backends}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText(sentence)).toBeTruthy();
});

it('starts afresh when the cycle’s version or its agents change elsewhere', () => {
  const key = cycleSettingsKey(cycle, { nextAgentSelections: now });
  expect(cycleSettingsKey({ ...cycle, version: 8 }, { nextAgentSelections: now })).not.toBe(key);
  expect(
    cycleSettingsKey(cycle, {
      nextAgentSelections: { ...now, review: { backend: 'claude-code', model: 'sonnet' } },
    }),
  ).not.toBe(key);
});
