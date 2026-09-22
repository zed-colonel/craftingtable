import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { RoadmapAgentProfilesPanel } from './RoadmapAgentProfilesPanel.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const selection = { backend: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
const entry = {
  id: 'entry',
  label: 'exo/EXO-02/domain · slice',
  projectId: 'exo',
  projectName: 'Exoskeleton',
  started: true,
  selections: { design: selection, implement: selection, review: selection, remediate: selection },
};
const initial = {
  roadmaps: [
    {
      id: 'roadmap',
      name: 'Stack',
      version: 3,
      status: 'paused',
      editBlocker: null,
      entries: [entry],
    },
  ],
};
const backends = [
  {
    kind: 'codex' as const,
    label: 'Codex',
    available: true,
    models: [
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    ],
  },
];
function show() {
  render(
    <RoadmapAgentProfilesPanel
      workspaceId="workspace"
      csrfToken="csrf"
      canEdit
      backends={backends}
      profiles={[]}
    />,
  );
}
it('applies reviewed future selections with the original version, no permissions and no plan-evidence request', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, roadmaps: [{ ...initial.roadmaps[0], version: 4 }] });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit future run profiles' }));
  const remediate = screen.getByRole('group', { name: 'Remediation' });
  fireEvent.change(within(remediate).getByLabelText('Model'), { target: { value: 'gpt-6-sol' } });
  fireEvent.change(within(remediate).getByLabelText('Reasoning effort'), {
    target: { value: 'medium' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to future runs' }));
  await screen.findByText(/Applied to future runs/);
  const call = vi.mocked(request).mock.calls[1]!;
  expect(call[0]).toBe('/api/workspaces/workspace/roadmaps/roadmap/agent-profiles');
  expect(JSON.parse(String(call[2]!.body))).toEqual({
    expectedVersion: 3,
    entryIds: ['entry'],
    selections: {
      ...entry.selections,
      remediate: { backend: 'codex', model: 'gpt-6-sol', reasoningEffort: 'medium' },
    },
  });
  expect(vi.mocked(request)).toHaveBeenCalledTimes(2);
});
it('retains edited choices across refresh and disables a stale apply', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, roadmaps: [{ ...initial.roadmaps[0], version: 4 }] });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit future run profiles' }));
  const implement = screen.getByRole('group', { name: 'Implementation' });
  fireEvent.change(within(implement).getByLabelText('Model'), { target: { value: 'gpt-6-sol' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh agent settings' }));
  await screen.findByText(/roadmap changed while you were editing/i);
  expect((within(implement).getByLabelText('Model') as HTMLSelectElement).value).toBe('gpt-6-sol');
  expect(
    (screen.getByRole('button', { name: 'Apply to future runs' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('requires scheduling to pause without demanding that current runs be cancelled', async () => {
  vi.mocked(request).mockResolvedValue({
    ...initial,
    roadmaps: [
      {
        ...initial.roadmaps[0],
        status: 'running',
        editBlocker:
          'Pause scheduling before applying agent profiles. Running agents may finish normally.',
      },
    ],
  });
  show();
  expect(
    ((await screen.findByRole('button', { name: 'Edit future run profiles' })) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/Running agents may finish normally/)).toBeTruthy();
});
