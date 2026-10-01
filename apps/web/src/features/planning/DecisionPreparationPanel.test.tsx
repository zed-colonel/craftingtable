import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Roadmap } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { DecisionPreparationPanel } from './DecisionPreparationPanel.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const roadmap = (status: Roadmap['status']) =>
  ({ id: 'r', workspaceId: 'ws', status, version: 3 }) as unknown as Roadmap;

it.each([
  ['running', false],
  ['paused', false],
  ['stopped', true],
] as const)('a %s roadmap leaves the decision form locked: %s (R-C3b)', async (status, locked) => {
  vi.mocked(request).mockResolvedValue({
    version: 3,
    status,
    decisions: [{ id: 'LOCAL-ADR-01', title: 'Boundary', profile: { backend: 'claude-code' } }],
  });
  render(
    <DecisionPreparationPanel
      roadmap={roadmap(status)}
      backends={[]}
      csrfToken="t"
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByText('Prepare architecture decision briefs'));
  const select = await screen.findByLabelText('Decision to prepare');
  await waitFor(() => expect(screen.getByRole('option', { name: /LOCAL-ADR-01/ })).toBeTruthy());
  expect((select as HTMLSelectElement).disabled).toBe(locked);
});

it('saves the standing grant while paused, and shows it while running (R-C3b)', async () => {
  vi.mocked(request).mockResolvedValue({ version: 3, status: 'paused', decisions: [] });
  const onChanged = vi.fn();
  const paused = roadmap('paused');
  const { unmount } = render(
    <DecisionPreparationPanel
      roadmap={paused}
      backends={[]}
      csrfToken="t"
      disabled={false}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByText('Prepare architecture decision briefs'));
  expect(screen.getByText('Standing preparation: off')).toBeTruthy();
  fireEvent.click(await screen.findByLabelText('Prepare needed decisions while the roadmap runs'));
  fireEvent.change(screen.getByLabelText('Preparations at once'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save standing preparation' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
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
  render(
    <DecisionPreparationPanel roadmap={running} backends={[]} csrfToken="t" disabled={false} />,
  );
  fireEvent.click(screen.getByText('Prepare architecture decision briefs'));
  expect(screen.getByText('Standing preparation: up to 2 at a time, 20 min each')).toBeTruthy();
  expect(
    (screen.getByLabelText('Prepare needed decisions while the roadmap runs') as HTMLInputElement)
      .disabled,
  ).toBe(true);
});

it('follows the saved grant when it changes, so a revoked grant is not re-enabled (R-C3b review)', async () => {
  vi.mocked(request).mockResolvedValue({ version: 3, status: 'paused', decisions: [] });
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
    <DecisionPreparationPanel
      roadmap={withGrant(true)}
      backends={[]}
      csrfToken="t"
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByText('Prepare architecture decision briefs'));
  const box = () =>
    screen.getByLabelText('Prepare needed decisions while the roadmap runs') as HTMLInputElement;
  expect(box().checked).toBe(true);
  // An applied amendment revoked it.
  rerender(
    <DecisionPreparationPanel
      roadmap={withGrant(false)}
      backends={[]}
      csrfToken="t"
      disabled={false}
    />,
  );
  expect(box().checked).toBe(false);
});

it("follows the panel's refreshed status, so a finished preparation can be prepared again (R-A6 review)", async () => {
  let latest = 'running';
  vi.mocked(request).mockImplementation(async () => ({
    version: 3,
    status: 'paused',
    decisions: [
      {
        id: 'LOCAL-ADR-01',
        title: 'Boundary',
        profile: { backend: 'claude-code' },
        latest: { status: latest, runId: 'run-1', startedAt: '2026-09-30T00:00:00.000Z' },
      },
    ],
  }));
  render(
    <DecisionPreparationPanel
      roadmap={roadmap('paused')}
      backends={[]}
      csrfToken="t"
      disabled={false}
    />,
  );
  fireEvent.click(screen.getByText('Prepare architecture decision briefs'));
  const select = await screen.findByLabelText('Decision to prepare');
  await waitFor(() => expect(screen.getByRole('option', { name: /LOCAL-ADR-01/ })).toBeTruthy());
  fireEvent.change(select, { target: { value: 'LOCAL-ADR-01' } });
  const prepare = await screen.findByRole('button', { name: 'Prepare decision brief' });
  await waitFor(() => expect(prepare.hasAttribute('disabled')).toBe(true));
  latest = 'finished';
  fireEvent.click(screen.getByRole('button', { name: 'Refresh preparation status and decisions' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Prepare decision brief' }).hasAttribute('disabled'),
    ).toBe(false),
  );
});

it("reads the map's supervision previews again after a refresh, as the window event did (R-D4 review M30)", async () => {
  vi.mocked(request).mockResolvedValue({ version: 3, status: 'paused', decisions: [] });
  const { store, wrap } = testQueryStore();
  const preview = vi.fn(async () => ({}));
  store.subscribe(
    ['cross-project', 'ws', 'def-1', '4', 'T', 'target-only'],
    preview,
    () => undefined,
  );
  const crossProjectRoadmap = {
    ...roadmap('paused'),
    definition: { crossProject: { definitionId: 'def-1' } },
  } as unknown as Roadmap;
  render(
    wrap(
      <DecisionPreparationPanel
        roadmap={crossProjectRoadmap}
        backends={[]}
        csrfToken="t"
        disabled={false}
      />,
    ),
  );
  fireEvent.click(screen.getByText('Prepare architecture decision briefs'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Refresh preparation status and decisions' }),
  );
  await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
});
