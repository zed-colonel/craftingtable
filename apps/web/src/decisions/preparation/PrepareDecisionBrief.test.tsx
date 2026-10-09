import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Roadmap } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { PrepareDecisionBrief, StandingPreparation } from './PrepareDecisionBrief.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const roadmap = (status: Roadmap['status']) =>
  ({ id: 'r', workspaceId: 'ws', status, version: 3 }) as unknown as Roadmap;
/** The roadmap's preparation settings for one decision; the execution status lists no agent. */
function settings(status: Roadmap['status'], latest?: string) {
  vi.mocked(request).mockImplementation(async (url) =>
    String(url).endsWith('/decision-preparations')
      ? {
          version: 3,
          status,
          decisions: [
            {
              id: 'LOCAL-ADR-01',
              title: 'Boundary',
              profile: { backend: 'claude-code', model: 'decision-model' },
              ...(latest
                ? {
                    latest: {
                      status: latest,
                      runId: 'run-1',
                      summary: '',
                      createdAt: '2026-09-30T00:00:00.000Z',
                    },
                  }
                : {}),
            },
          ],
        }
      : String(url).endsWith('/prepare-decision')
        ? {}
        : { backends: [] },
  );
}
const brief = (refreshOn?: unknown) => (
  <PrepareDecisionBrief
    workspaceId="ws"
    roadmapId="r"
    csrfToken="t"
    checkpointId="LOCAL-ADR-01"
    refreshOn={refreshOn}
  />
);
const prepareButton = () =>
  screen.getByRole('button', { name: 'Prepare decision brief' }) as HTMLButtonElement;

it.each([
  ['running', false],
  ['paused', false],
  ['stopped', true],
] as const)('a %s roadmap leaves preparation locked: %s (R-C3b)', async (status, locked) => {
  settings(status);
  render(brief());
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Preparation time limit (minutes)') as HTMLInputElement).disabled,
    ).toBe(locked),
  );
  expect(prepareButton().disabled).toBe(locked);
});

it("prepares with the decision's agent unless another is chosen, against the roadmap's version now", async () => {
  settings('paused');
  render(brief());
  await waitFor(() => expect(prepareButton().disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Preparation time limit (minutes)'), {
    target: { value: '20' },
  });
  fireEvent.change(screen.getByLabelText('Optional decision guidance'), {
    target: { value: 'Compare both transports.' },
  });
  fireEvent.click(prepareButton());
  await screen.findByText(/Preparation started/);
  const call = vi
    .mocked(request)
    .mock.calls.find(([url]) => String(url).endsWith('/prepare-decision'))!;
  expect(call[0]).toBe('/api/workspaces/ws/roadmaps/r/prepare-decision');
  expect(JSON.parse(String((call[2] as RequestInit).body))).toEqual({
    expectedVersion: 3,
    checkpointId: 'LOCAL-ADR-01',
    profile: { backend: 'claude-code', model: 'decision-model' },
    minutes: 20,
    instructions: 'Compare both transports.',
  });
});

it('refuses a time limit outside 5 to 60 minutes', async () => {
  settings('paused');
  render(brief());
  await waitFor(() => expect(prepareButton().disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Preparation time limit (minutes)'), {
    target: { value: '61' },
  });
  expect(prepareButton().disabled).toBe(true);
});

it('waits while a preparation runs, links it, and is offered again once a new view shows it ended (R-A6 review)', async () => {
  settings('paused', 'running');
  const { rerender } = render(brief(1));
  await screen.findByText('Preparing · running');
  expect(prepareButton().disabled).toBe(true);
  expect(screen.getByRole('link', { name: 'Open preparation run' }).getAttribute('href')).toBe(
    '/workspaces/ws/runs/run-1',
  );
  settings('paused', 'finished');
  rerender(brief(2));
  await waitFor(() => expect(prepareButton().disabled).toBe(false));
});

it('saves the standing grant while paused, and shows it while running (R-C3b)', async () => {
  vi.mocked(request).mockResolvedValue({});
  const onSaved = vi.fn();
  const { unmount } = render(
    <StandingPreparation
      roadmap={roadmap('paused')}
      csrfToken="t"
      disabled={false}
      onSaved={onSaved}
    />,
  );
  expect(screen.getByText('Standing preparation: off')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Prepare needed decisions while the roadmap runs'));
  fireEvent.change(screen.getByLabelText('Preparations at once'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save standing preparation' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const call = vi
    .mocked(request)
    .mock.calls.find(([url]) => String(url).endsWith('/decision-preparation-grant'));
  expect(JSON.parse(String((call![2] as RequestInit).body))).toEqual({
    expectedVersion: 3,
    enabled: true,
    minutes: 30,
    maxConcurrent: 2,
  });
  unmount();
  const running = {
    ...roadmap('running'),
    decisionPreparationGrant: {
      enabled: true,
      minutes: 20,
      maxConcurrent: 2,
      grantedByUserId: 'u',
      grantedAt: '2026-09-28T00:00:00Z',
    },
  } as unknown as Roadmap;
  render(<StandingPreparation roadmap={running} csrfToken="t" disabled={false} />);
  expect(screen.getByText('Standing preparation: up to 2 at a time, 20 min each')).toBeTruthy();
  expect(
    (screen.getByLabelText('Prepare needed decisions while the roadmap runs') as HTMLInputElement)
      .disabled,
  ).toBe(true);
});

it('follows the saved grant when it changes, so a revoked grant is not re-enabled (R-C3b review)', () => {
  const withGrant = (enabled: boolean) =>
    ({
      ...roadmap('paused'),
      decisionPreparationGrant: {
        enabled,
        minutes: 20,
        maxConcurrent: 2,
        grantedByUserId: 'u',
        grantedAt: '2026-09-28T00:00:00Z',
      },
    }) as unknown as Roadmap;
  const { rerender } = render(
    <StandingPreparation roadmap={withGrant(true)} csrfToken="t" disabled={false} />,
  );
  const box = () =>
    screen.getByLabelText('Prepare needed decisions while the roadmap runs') as HTMLInputElement;
  expect(box().checked).toBe(true);
  // An applied amendment revoked it.
  rerender(<StandingPreparation roadmap={withGrant(false)} csrfToken="t" disabled={false} />);
  expect(box().checked).toBe(false);
});
