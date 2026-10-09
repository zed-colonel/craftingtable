import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AcknowledgeMoves } from './AcknowledgeMoves.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('acknowledges exactly the moves the item showed, and reports a refusal (R-G5)', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ acknowledged: 2 }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'conflict', message: 'These moves changed.' } }),
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const done = vi.fn();
  render(
    <AcknowledgeMoves
      workspaceId={asWorkspaceId('ws')}
      moveIds={['m-1', 'm-2']}
      csrfToken="token"
      canMutate
      onDone={done}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge 2 moves' }));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('/api/workspaces/ws/protected-ref-moves/acknowledge');
  expect(init.method).toBe('POST');
  expect(init.headers['x-craftingtable-csrf']).toBe('token');
  expect(JSON.parse(init.body)).toEqual({ moveIds: ['m-1', 'm-2'] });
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge 2 moves' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'These moves changed.');
  expect(done).toHaveBeenCalledTimes(1);
});

it('acknowledges a large item in requests the daemon accepts (R-G5 review)', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ acknowledged: 1 }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetch);
  const done = vi.fn();
  const ids = Array.from({ length: 2300 }, (_, i) => `m-${i}`);
  render(
    <AcknowledgeMoves
      workspaceId={asWorkspaceId('ws')}
      moveIds={ids}
      csrfToken="token"
      canMutate
      onDone={done}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge 2300 moves' }));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  const sent = fetch.mock.calls.map(
    (call) => JSON.parse((call as unknown as [string, { body: string }])[1].body).moveIds,
  );
  expect(sent.map((batch: string[]) => batch.length)).toEqual([1000, 1000, 300]);
  expect(sent.flat()).toEqual(ids);
});

it('offers nothing to a viewer', () => {
  render(
    <AcknowledgeMoves
      workspaceId={asWorkspaceId('ws')}
      moveIds={['m-1']}
      csrfToken="token"
      canMutate={false}
      onDone={vi.fn()}
    />,
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Acknowledge 1 move' }).disabled,
  ).toBe(true);
});
