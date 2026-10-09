import { asWorkItemId, asWorkspaceId, type ExecutionScope } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthorizeEarlyDevelopment } from './AuthorizeEarlyDevelopment.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('authorizes exactly the slice binding shown, and reports a refusal (R-A6 rest)', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ choices: [] }))
    .mockResolvedValueOnce(json({ error: { code: 'conflict', message: 'Binding changed.' } }, 409));
  vi.stubGlobal('fetch', fetch);
  const authorized = vi.fn();
  const scope = {
    kind: 'slice',
    definitionId: '12345678-1234-4234-8234-123456789abc',
    bindingRevision: 2,
    sourceId: 'wi/WI-01/domain',
  } as ExecutionScope;
  render(
    <AuthorizeEarlyDevelopment
      workspaceId={asWorkspaceId('ws')}
      workItemId={asWorkItemId('item')}
      scope={scope}
      csrfToken="token"
      disabled={false}
      onAuthorized={authorized}
    />,
  );
  const button = screen.getByRole('button', {
    name: 'Authorize this slice’s early-development rule',
  });
  fireEvent.click(button);
  await waitFor(() => expect(authorized).toHaveBeenCalledTimes(1));
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('/api/workspaces/ws/work-items/item/scope-scheduling');
  expect(init.headers['x-craftingtable-csrf']).toBe('token');
  expect(JSON.parse(init.body)).toEqual({ scope });
  fireEvent.click(button);
  expect((await screen.findByRole('alert')).textContent).toBe('Binding changed.');
  expect(authorized).toHaveBeenCalledTimes(1);
});
