import { randomUUID } from 'node:crypto';
import {
  SSE_AUTHENTICATION_EXPIRED_EVENT_NAME,
  SSE_WORKSPACE_EVENT_NAME,
  workspaceEventEnvelopeSchema,
} from '@craftingtable/contracts';
import { asEventId, asUserId } from '@craftingtable/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  FastTestPasswordHasher,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from './test-support.js';
import { selectEventCursor } from './services/workspace-event-stream-service.js';

interface SseFrame {
  readonly event?: string;
  readonly id?: string;
  readonly data?: string;
}

function listeningPort(app: FastifyInstance): number {
  const address = app.addresses()[0];
  if (address === undefined) {
    throw new Error('Test server did not expose a listening address');
  }
  return address.port;
}

function responseReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (response.body === null) {
    throw new Error('SSE response did not include a body');
  }
  return response.body.getReader();
}

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  matchingEvent: string,
): Promise<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error('SSE stream ended before expected frame');
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const parsed = {
        ...(frame.match(/^event: (.+)$/m)?.[1] === undefined
          ? {}
          : { event: frame.match(/^event: (.+)$/m)?.[1] }),
        ...(frame.match(/^id: (.+)$/m)?.[1] === undefined
          ? {}
          : { id: frame.match(/^id: (.+)$/m)?.[1] }),
        ...(frame.match(/^data: (.+)$/m)?.[1] === undefined
          ? {}
          : { data: frame.match(/^data: (.+)$/m)?.[1] }),
      };
      if (parsed.event === matchingEvent) {
        return parsed;
      }
    }
  }
}

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe('workspace SSE route', () => {
  it('selects the greater valid query or Last-Event-ID cursor', () => {
    expect(selectEventCursor('2', '5')).toBe(5);
    expect(selectEventCursor('7', '5')).toBe(7);
    expect(() => selectEventCursor('-1', undefined)).toThrow(/nonnegative/);
    expect(() => selectEventCursor('1.5', undefined)).toThrow(/integer/);
    expect(() => selectEventCursor(String(Number.MAX_SAFE_INTEGER + 1), undefined)).toThrow(/safe/);
  });

  it('rejects an unauthenticated stream before hijacking', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bootstrap.workspace.id}/events?after=0`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('authenticates before cursor/id validation and rejects cross-site browser streams', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const unauthenticated = await context.app.inject({
      method: 'GET',
      url: '/api/workspaces/%20/events?after=invalid',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    const crossSite = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bootstrap.workspace.id}/events?after=0`,
      headers: {
        cookie: login.cookie,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json()).toEqual({
      error: { code: 'forbidden', message: 'Request forbidden' },
    });
  });

  it('denies a non-member stream without disclosing the workspace', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    context.storage.users.insert({
      id: asUserId('stream-non-member'),
      username: 'stream-other',
      usernameNormalized: 'stream-other',
      passwordHash: await new FastTestPasswordHasher().hash(TEST_PASSWORD),
      occurredAt: new Date().toISOString(),
    });
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { username: 'stream-other', password: TEST_PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] as string;
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bootstrap.workspace.id}/events?after=0`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(bootstrap.workspace.name);
  });

  it('replays committed workspace events in order on a real port', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const port = listeningPort(context.app);
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${bootstrap.workspace.id}/events?after=0`,
      { headers: { cookie: login.cookie }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = responseReader(response);
    const frame = await nextFrame(reader, SSE_WORKSPACE_EVENT_NAME);
    const event = workspaceEventEnvelopeSchema.parse(JSON.parse(frame.data as string));
    expect(frame.id).toBe('1');
    expect(event).toMatchObject({
      sequence: 1,
      workspaceId: bootstrap.workspace.id,
      kind: 'workspace-created',
    });
    controller.abort();
  });

  it('uses Last-Event-ID to resume from the native reconnect cursor', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    context.storage.transaction((tx) => {
      tx.workspaceEvents.appendWorkspaceCreated({
        id: asEventId(randomUUID()),
        occurredAt: new Date().toISOString(),
        workspaceId: bootstrap.workspace.id,
        actorUserId: bootstrap.user.id,
        name: 'Second event',
        slug: 'second-event',
      });
    });
    const login = await context.login();
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const port = listeningPort(context.app);
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${bootstrap.workspace.id}/events?after=0`,
      {
        headers: { cookie: login.cookie, 'last-event-id': '1' },
        signal: controller.signal,
      },
    );
    const frame = await nextFrame(responseReader(response), SSE_WORKSPACE_EVENT_NAME);
    expect(frame.id).toBe('2');
    expect(workspaceEventEnvelopeSchema.parse(JSON.parse(frame.data as string)).sequence).toBe(2);
    controller.abort();
  });

  it('tails a post-connect commit and expires promptly after session revocation', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    await context.app.listen({ host: '127.0.0.1', port: 0 });
    const port = listeningPort(context.app);
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${bootstrap.workspace.id}/events?after=1`,
      { headers: { cookie: login.cookie }, signal: controller.signal },
    );
    const reader = responseReader(response);
    context.storage.transaction((tx) => {
      tx.workspaceEvents.appendWorkspaceCreated({
        id: asEventId(randomUUID()),
        occurredAt: new Date().toISOString(),
        workspaceId: bootstrap.workspace.id,
        actorUserId: bootstrap.user.id,
        name: 'Live event',
        slug: 'live-event',
      });
    });
    context.services.workspaceEventNotifier.notify();
    const live = await nextFrame(reader, SSE_WORKSPACE_EVENT_NAME);
    expect(workspaceEventEnvelopeSchema.parse(JSON.parse(live.data as string)).sequence).toBe(2);

    const logout = await context.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        cookie: login.cookie,
        origin: context.config.publicOrigin,
        'x-craftingtable-csrf': login.csrfToken,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    const frame = await nextFrame(reader, SSE_AUTHENTICATION_EXPIRED_EVENT_NAME);
    expect(JSON.parse(frame.data as string)).toEqual({ reason: 'session-invalid' });
    controller.abort();
  });
});
