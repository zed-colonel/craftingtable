import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapAdoption } from './MapAdoption.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const id = '12345678-1234-4234-8234-123456789abc';

it('adopts only with confirmation and a rationale, for the exact binding (R-A6 rest)', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ error: { code: 'conflict', message: 'Binding moved.' } }, 409))
    .mockResolvedValueOnce(json({ adopted: true }));
  vi.stubGlobal('fetch', fetch);
  const adopted = vi.fn();
  render(
    <MapAdoption
      workspaceId={asWorkspaceId('ws')}
      definitionId={id}
      bindingRevision={3}
      decisionIds={['CS-D01', 'CS-D02']}
      csrfToken="token"
      disabled={false}
      onAdopted={adopted}
    />,
  );
  const adopt = screen.getByRole('button', { name: 'Adopt scheduling proposals' });
  expect((adopt as HTMLButtonElement).disabled).toBe(true);
  // A rationale alone does not adopt: the confirmation is the operator's (review L4).
  fireEvent.change(screen.getByLabelText('Adoption rationale'), {
    target: { value: 'Reviewed the proposals.' },
  });
  expect((adopt as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I approve all listed/));
  expect((adopt as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(adopt);
  expect((await screen.findByRole('alert')).textContent).toBe('Binding moved.');
  expect(adopted).not.toHaveBeenCalled();
  // A refusal keeps the confirmation and rationale for another try.
  fireEvent.click(adopt);
  await waitFor(() => expect(adopted).toHaveBeenCalledTimes(1));
  const [url, init] = fetch.mock.calls[1]!;
  expect(url).toBe(`/api/workspaces/ws/concurrency-definitions/${id}/supervision/adopt`);
  expect(init.headers['x-craftingtable-csrf']).toBe('token');
  expect(JSON.parse(init.body)).toEqual({
    bindingRevision: 3,
    decisionIds: ['CS-D01', 'CS-D02'],
    rationale: 'Reviewed the proposals.',
  });
  // Once adopted, the form is cleared.
  expect((screen.getByLabelText('Adoption rationale') as HTMLTextAreaElement).value).toBe('');
});
