import { asWorkspaceId, asWorktreeId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordScopeEvidence } from './RecordScopeEvidence.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('records the reviewed worktree at the version shown, and reports a refusal (R-A6 rest)', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ recorded: true, workItemCompleted: false }))
    .mockResolvedValueOnce(
      json({ error: { code: 'conflict', message: 'Integration branch advanced.' } }, 409),
    );
  vi.stubGlobal('fetch', fetch);
  const recorded = vi.fn();
  render(
    <RecordScopeEvidence
      workspaceId={asWorkspaceId('ws')}
      worktree={{ id: asWorktreeId('wt-1'), version: 7 }}
      parentAcceptance={false}
      csrfToken="token"
      disabled={false}
      onRecorded={recorded}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Record slice verification' }));
  await waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('/api/workspaces/ws/worktrees/wt-1/scope-evidence');
  expect(init.method).toBe('POST');
  expect(init.headers['x-craftingtable-csrf']).toBe('token');
  expect(JSON.parse(init.body)).toEqual({ expectedWorktreeVersion: 7 });
  fireEvent.click(screen.getByRole('button', { name: 'Record slice verification' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Integration branch advanced.');
  expect(recorded).toHaveBeenCalledTimes(1);
});

it('names a parent acceptance, and posts nothing while disabled', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(
    <RecordScopeEvidence
      workspaceId={asWorkspaceId('ws')}
      worktree={{ id: asWorktreeId('wt-1'), version: 1 }}
      parentAcceptance
      csrfToken="token"
      disabled
      onRecorded={vi.fn()}
    />,
  );
  const button = screen.getByRole('button', { name: 'Accept parent after review' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(fetch).not.toHaveBeenCalled();
});
