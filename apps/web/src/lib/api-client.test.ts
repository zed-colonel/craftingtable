import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from './api-client.js';
import { importConcurrencyZip } from './package-import-api.js';
import { importPlanBundle } from './planning-api.js';

const refuses = {
  parse(value: unknown): { ok: true } {
    if ((value as { ok?: unknown } | undefined)?.ok !== true)
      throw new Error('contract: ok must be true');
    return { ok: true };
  },
};

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('says in the console when a successful answer breaks its contract, and still fails the read (TS-M15)', async () => {
  vi.stubGlobal('fetch', answer(200, { ok: 'yes' }));
  await expect(request('/api/example', refuses)).rejects.toThrow('contract: ok must be true');
  expect(consoleError).toHaveBeenCalledTimes(1);
  expect(String(consoleError.mock.calls[0]?.[0])).toContain('/api/example');
});

it('says nothing when a successful answer could not be read, as when a navigation abandons it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok": tr', { status: 200 })),
  );
  await expect(request('/api/example', refuses)).rejects.toThrow('contract: ok must be true');
  expect(consoleError).not.toHaveBeenCalled();
});

it('says nothing when the answer keeps its contract, or when the daemon refuses the request', async () => {
  vi.stubGlobal('fetch', answer(200, { ok: true }));
  await expect(request('/api/example', refuses)).resolves.toEqual({ ok: true });
  vi.stubGlobal(
    'fetch',
    answer(409, { error: { code: 'conflict', message: 'The record changed.' } }),
  );
  await expect(request('/api/example', refuses)).rejects.toThrow('The record changed.');
  expect(consoleError).not.toHaveBeenCalled();
});

it('says so for the plan and package uploads too, which read their answers themselves', async () => {
  vi.stubGlobal('fetch', answer(200, { unexpected: true }));
  const file = new File(['x'], 'plan.zip');
  await expect(importPlanBundle(asWorkspaceId('ws'), { files: [] }, 'csrf')).rejects.toThrow();
  await expect(importConcurrencyZip(asWorkspaceId('ws'), file, 'csrf')).rejects.toThrow();
  expect(consoleError).toHaveBeenCalledTimes(2);
  expect(String(consoleError.mock.calls[0]?.[0])).toContain('/plan-imports');
  expect(String(consoleError.mock.calls[1]?.[0])).toContain('/concurrency');
});
