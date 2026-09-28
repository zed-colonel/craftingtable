import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Roadmap } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
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
