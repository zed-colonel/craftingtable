import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import { UpstreamTransitions } from './UpstreamTransitions.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
// The live AQ/WI/EXO shape: wi→aq has one qualifying slice; EXO's links have none (ADR-069).
const view = {
  upstreamTransitions: {
    records: [],
    links: [
      { consumer: 'wi', upstream: 'aq', candidates: ['wi/WI-02/integration'] },
      { consumer: 'exo', upstream: 'aq', candidates: [] },
      { consumer: 'exo', upstream: 'wi', candidates: [] },
    ],
  },
} as unknown as RuntimeEvidenceView;

it('approves a chosen transition with the records the operator saw and a rationale', async () => {
  const saved = vi.fn();
  vi.mocked(request).mockResolvedValueOnce(view);
  render(
    <UpstreamTransitions base="/runtime" view={view} csrfToken="csrf" canMutate onSaved={saved} />,
  );
  const approve = screen.getByRole('button', { name: 'Approve transitions' }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('WI → AQ transition slice'), {
    target: { value: 'wi/WI-02/integration' },
  });
  fireEvent.change(screen.getByLabelText('Transition rationale'), {
    target: { value: 'WI-02/integration moved WI to AQ 0.2.0.' },
  });
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(approve);
  await waitFor(() => expect(saved).toHaveBeenCalledWith(view));
  const [url, , options] = vi.mocked(request).mock.calls[0]!;
  expect(url).toBe('/runtime/declare-transitions');
  expect(JSON.parse(options!.body as string)).toEqual({
    expectedRecordIds: [],
    transitions: [{ consumer: 'wi', upstream: 'aq', slice: 'wi/WI-02/integration' }],
    rationale: 'WI-02/integration moved WI to AQ 0.2.0.',
  });
});

it('sends a link with no qualifying slice to the next map revision', () => {
  render(
    <UpstreamTransitions
      base="/runtime"
      view={view}
      csrfToken="csrf"
      canMutate
      onSaved={() => {}}
    />,
  );
  expect(
    screen.getAllByText('not declared · no slice qualifies; declare it in the next map revision', {
      exact: false,
    }),
  ).toHaveLength(2);
  expect(screen.queryByLabelText('EXO → AQ transition slice')).toBeNull();
});

it('shows declared links and their source, with no form once every link is declared', () => {
  const declared = {
    upstreamTransitions: {
      records: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          workspaceId: 'ws',
          definitionId: 'map',
          transitions: [{ consumer: 'wi', upstream: 'aq', slice: 'wi/WI-02/integration' }],
          rationale: 'Moved at WI-02/integration.',
          createdAt: '2026-09-25T10:00:00.000Z',
          createdByUserId: 'user',
        },
      ],
      links: [
        {
          consumer: 'wi',
          upstream: 'aq',
          slice: 'wi/WI-02/integration',
          declaredBy: 'record',
          recordId: '00000000-0000-4000-8000-000000000001',
          candidates: [],
        },
      ],
    },
  } as unknown as RuntimeEvidenceView;
  render(
    <UpstreamTransitions
      base="/runtime"
      view={declared}
      csrfToken="csrf"
      canMutate
      onSaved={() => {}}
    />,
  );
  expect(screen.getByText('approved by the operator', { exact: false })).toBeTruthy();
  expect(screen.getByText('Approved transitions (1)')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve transitions' })).toBeNull();
});

it('does not offer approval to a read-only viewer', () => {
  render(
    <UpstreamTransitions
      base="/runtime"
      view={view}
      csrfToken="csrf"
      canMutate={false}
      onSaved={() => {}}
    />,
  );
  expect(
    (screen.getByRole('button', { name: 'Approve transitions' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((screen.getByLabelText('WI → AQ transition slice') as HTMLSelectElement).disabled).toBe(
    true,
  );
});
