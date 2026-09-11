import { describe, expect, it, vi } from 'vitest';
import { PushoverTransport } from './notification-transport.js';
const message = {
  applicationToken: 'a'.repeat(30),
  userKey: 'u'.repeat(30),
  device: '',
  title: 'Title',
  message: '😀'.repeat(1100),
  url: 'https://craft.example/workspaces/test',
};
const signal = new AbortController().signal;
describe('Pushover transport', () => {
  it('uses the fixed endpoint with bounded Unicode, normal priority and a supplementary link', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"status":1}', { status: 200 }));
    expect(await new PushoverTransport(fetcher).send(message, signal)).toEqual({
      status: 'accepted',
    });
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(options?.redirect).toBe('error');
    const body = options?.body as URLSearchParams;
    expect(Array.from(body.get('message') ?? '')).toHaveLength(1024);
    expect(body.get('priority')).toBe('0');
    expect(body.get('url')).toBe(message.url);
  });
  it.each([400, 401, 403])(
    'blocks unchanged rejected requests (%s) without leaking provider error content',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ errors: [message.applicationToken] }), { status }),
        );
      const result = await new PushoverTransport(fetcher).send(message, signal);
      expect(result.status).toBe('blocked');
      expect(JSON.stringify(result)).not.toContain(message.applicationToken);
    },
  );
  it('requires status 1 as well as HTTP 200', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"status":0}'));
    expect((await new PushoverTransport(fetcher).send(message, signal)).status).toBe('blocked');
  });
  it('retries network errors, oversized responses, malformed responses, and server failures', async () => {
    for (const response of [
      new Response('bad json'),
      new Response('x'.repeat(17_000)),
      new Response('', { status: 503 }),
    ]) {
      expect(
        (
          await new PushoverTransport(vi.fn<typeof fetch>().mockResolvedValue(response)).send(
            message,
            signal,
          )
        ).status,
      ).toBe('retry');
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(message.userKey));
    expect(await new PushoverTransport(fetcher).send(message, signal)).toEqual({
      status: 'retry',
      reason: 'Pushover delivery could not be confirmed; it will retry.',
    });
  });
  it('honors Pushover quota resets and Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', {
        status: 429,
        headers: {
          'x-limit-app-reset': String(Date.parse('2026-10-01T00:00:00Z') / 1000),
          'retry-after': '120',
        },
      }),
    );
    expect(
      await new PushoverTransport(fetcher, () => new Date('2026-09-10T00:00:00Z')).send(
        message,
        signal,
      ),
    ).toMatchObject({ status: 'retry', retryAt: '2026-10-01T00:00:00.000Z' });
  });
});
