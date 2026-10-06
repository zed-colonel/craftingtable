import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetValidators, login, logout, request, setStepUpPrompt } from './api-client.js';
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

it('revalidates a read in memory: an unchanged answer is the same value, without a body (R-D5, PERF-16)', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    new Headers(init?.headers).get('if-none-match') === 'W/"one"'
      ? new Response(null, { status: 304, headers: { etag: 'W/"one"' } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { etag: 'W/"one"' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const first = await request('/api/example', refuses);
  const second = await request('/api/example', refuses);
  expect(second).toBe(first);
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('if-none-match')).toBeNull();
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('if-none-match')).toBe('W/"one"');
  // Another read has a validator of its own; a command never sends one.
  await request('/api/other', refuses);
  expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('if-none-match')).toBeNull();
  await request('/api/example', refuses, { method: 'POST', body: '{}' });
  expect(new Headers(fetch.mock.calls[3]?.[1]?.headers).get('if-none-match')).toBeNull();
  // Signing in or out forgets every validator.
  forgetValidators();
  await request('/api/example', refuses);
  expect(new Headers(fetch.mock.calls[4]?.[1]?.headers).get('if-none-match')).toBeNull();
});

it('forgets a validator when an answer comes without one', async () => {
  let tagged = true;
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: tagged ? { etag: 'W/"two"' } : {},
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await request('/api/forget', refuses);
  tagged = false;
  await request('/api/forget', refuses);
  await request('/api/forget', refuses);
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('if-none-match')).toBe('W/"two"');
  expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('if-none-match')).toBeNull();
});

it('forgets every validator on signing in and on signing out, even a sign-out that fails (R-D5 review)', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/login')
      return new Response(
        JSON.stringify({
          user: { id: 'u', username: 'keith', status: 'active' },
          session: {
            id: 's',
            createdAt: '2026-10-06T00:00:00.000Z',
            lastSeenAt: '2026-10-06T00:00:00.000Z',
            expiresAt: '2026-11-06T00:00:00.000Z',
            status: 'active',
            current: true,
          },
          csrfToken: 'c'.repeat(43),
        }),
        { status: 200 },
      );
    if (url === '/api/auth/logout')
      return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No.' } }), {
        status: 403,
      });
    return new Headers(init?.headers).get('if-none-match')
      ? new Response(null, { status: 304, headers: { etag: 'W/"v"' } })
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { etag: 'W/"v"' } });
  });
  vi.stubGlobal('fetch', fetch);
  const sentValidator = () =>
    new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('if-none-match');
  await request('/api/held', refuses);
  await request('/api/held', refuses);
  expect(sentValidator()).toBe('W/"v"');
  await login({ username: 'keith', password: 'a correct password' });
  await request('/api/held', refuses);
  expect(sentValidator()).toBeNull();
  await request('/api/held', refuses);
  expect(sentValidator()).toBe('W/"v"');
  await expect(logout('csrf')).rejects.toThrow();
  await request('/api/held', refuses);
  expect(sentValidator()).toBeNull();
});

it('keeps the validators of the newest 64 reads', async () => {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { etag: 'W/"v"' } }),
  );
  vi.stubGlobal('fetch', fetch);
  for (let index = 0; index <= 64; index++) await request(`/api/bound/${index}`, refuses);
  const sent = (url: string) =>
    new Headers(fetch.mock.calls.findLast(([called]) => called === url)?.[1]?.headers).get(
      'if-none-match',
    );
  await request('/api/bound/0', refuses);
  expect(sent('/api/bound/0')).toBeNull();
  await request('/api/bound/64', refuses);
  expect(sent('/api/bound/64')).toBe('W/"v"');
});

describe('step-up (R-G9)', () => {
  const stepUpRequired = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'forbidden',
          message: 'Enter your password again',
          reason: 'step-up-required',
        },
      }),
      { status: 403 },
    );
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const command = () =>
    request('/api/command', refuses, {
      method: 'POST',
      headers: { 'x-craftingtable-csrf': 'csrf' },
      body: JSON.stringify({ permissionMode: 'unrestricted' }),
    });
  afterEach(() => setStepUpPrompt(undefined));

  it('asks for the password, steps up and sends the command again', async () => {
    let refused = 0;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/auth/step-up')
        return new Response(JSON.stringify({ steppedUpUntil: '2026-10-05T10:10:00.000Z' }), {
          status: 200,
        });
      return refused++ === 0 ? stepUpRequired() : ok();
    });
    vi.stubGlobal('fetch', fetch);
    const prompt = vi.fn(async () => 'the password');
    setStepUpPrompt(prompt);
    await expect(command()).resolves.toEqual({ ok: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    const stepUp = fetch.mock.calls.find(([url]) => url === '/api/auth/step-up');
    expect(JSON.parse(String(stepUp?.[1]?.body))).toEqual({ password: 'the password' });
    expect(new Headers(stepUp?.[1]?.headers).get('x-craftingtable-csrf')).toBe('csrf');
    expect(fetch.mock.calls.filter(([url]) => url === '/api/command')).toHaveLength(2);
  });

  it('asks again after a wrong password, and gives up when the operator cancels', async () => {
    const fetch = vi.fn(async (url: string) =>
      url === '/api/auth/step-up'
        ? new Response(
            JSON.stringify({
              error: { code: 'forbidden', message: 'No.', reason: 'step-up-failed' },
            }),
            { status: 403 },
          )
        : stepUpRequired(),
    );
    vi.stubGlobal('fetch', fetch);
    const prompt = vi
      .fn<(failed: boolean) => Promise<string | undefined>>()
      .mockResolvedValueOnce('wrong')
      .mockResolvedValueOnce(undefined);
    setStepUpPrompt(prompt);
    await expect(command()).rejects.toMatchObject({
      status: 403,
      detail: { reason: 'step-up-required' },
    });
    expect(prompt.mock.calls).toEqual([[false], [true]]);
    expect(fetch.mock.calls.filter(([url]) => url === '/api/command')).toHaveLength(1);
  });

  it('gives up when the step-up itself is refused for anything but the password (R-G9 review)', async () => {
    for (const refusal of [
      { status: 403, error: { code: 'forbidden', message: 'Request forbidden' } },
      {
        status: 429,
        error: { code: 'rate-limited', message: 'Wait.', reason: 'login-rate-limited' },
      },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url === '/api/auth/step-up'
            ? new Response(JSON.stringify({ error: refusal.error }), { status: refusal.status })
            : stepUpRequired(),
        ),
      );
      const prompt = vi.fn(async () => 'the password');
      setStepUpPrompt(prompt);
      await expect(command()).rejects.toMatchObject({ status: refusal.status });
      expect(prompt).toHaveBeenCalledTimes(1);
    }
  });

  it('never asks about a read, another refusal, or without a prompt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => stepUpRequired()),
    );
    await expect(command()).rejects.toMatchObject({ detail: { reason: 'step-up-required' } });
    const prompt = vi.fn(async () => 'x');
    setStepUpPrompt(prompt);
    await expect(request('/api/read', refuses)).rejects.toMatchObject({ status: 403 });
    // Nor about a command refused for any other reason.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No.' } }), {
            status: 403,
          }),
      ),
    );
    await expect(command()).rejects.toMatchObject({ status: 403 });
    expect(prompt).not.toHaveBeenCalled();
  });
});
