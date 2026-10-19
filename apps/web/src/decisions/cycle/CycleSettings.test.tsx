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
import { CycleSettings } from './CycleSettings.js';

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
