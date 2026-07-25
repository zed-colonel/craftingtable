import { readFileSync } from 'node:fs';
import { planImportResponseSchema, workspaceEventEnvelopeSchema } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME } from './config.js';
import { buildMultipartBody, type MultipartFilePart } from './multipart-test-support.js';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * CT03-A45 to A47 and A49.
 *
 * The CT-02 review left one binding forward obligation: every daemon command
 * that appends a workspace event must call the composed notifier after commit,
 * and acceptance must prove delivery *without* waiting for the fallback poll.
 *
 * These tests configure the stream's fallback wait far longer than the whole
 * test, so any event that arrives must have arrived through same-process
 * notification. A dropped notification is covered separately against CT-02's
 * durable timeout behaviour.
 */

const FALLBACK_LONGER_THAN_TEST_MS = 60_000;

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

const FIXTURE_DIR = new URL('../../../fixtures/plan-bundles/aq-cont-1/', import.meta.url);

function aqFiles(): readonly MultipartFilePart[] {
  const read = (filename: string, fieldName: string, contentType: string) => ({
    fieldName,
    filename,
    contentType,
    bytes: new Uint8Array(readFileSync(new URL(filename, FIXTURE_DIR))),
  });
  return [
    read('aq-cont-1-implementation-plan.md', 'implementation-plan', 'text/markdown'),
    read('aq-cont-1-work-breakdown.yaml', 'work-breakdown', 'application/yaml'),
  ];
}

function listeningPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a listening address');
  }
  return address.port;
}

interface StreamReader {
  readonly events: unknown[];
  waitForKind(kind: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

/** Reads an SSE stream, parsing each `workspace-event` frame as it arrives. */
async function openStream(
  port: number,
  cookie: string,
  workspaceId: string,
  after: number,
): Promise<StreamReader> {
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspaceId}/events?after=${after}`,
    { headers: { cookie, accept: 'text/event-stream' }, signal: controller.signal },
  );
  if (response.body === null) {
    throw new Error('Event stream had no body');
  }
  const events: Record<string, unknown>[] = [];
  const waiters: { kind: string; resolve: (event: Record<string, unknown>) => void }[] = [];
  const reader = response.body.getReader();

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (frame.includes('event: workspace-event') && dataLine !== undefined) {
            const event = workspaceEventEnvelopeSchema.parse(
              JSON.parse(dataLine.slice('data: '.length)),
            ) as unknown as Record<string, unknown>;
            events.push(event);
            for (const waiter of waiters.splice(0)) {
              if (waiter.kind === event.kind) {
                waiter.resolve(event);
              } else {
                waiters.push(waiter);
              }
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted by close().
    }
  })();

  return {
    events,
    waitForKind(kind, timeoutMs = 5_000) {
      const existing = events.find((event) => event.kind === kind);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${kind}`)),
          timeoutMs,
        );
        waiters.push({
          kind,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    close() {
      controller.abort();
    },
  };
}

async function readyDaemon(streamHooks: { waitTimeoutMs: number }) {
  const context = await createTestContext({ streamHooks });
  contexts.push(context);
  await context.bootstrap();
  const session = await context.login();
  await context.app.listen({ host: '127.0.0.1', port: 0 });
  const workspaceId = context.storage.workspaces
    .listAuthorized(
      context.storage.users.findByNormalizedUsername('test-user')?.id ?? ('' as never),
    )
    .at(0)?.workspace.id as WorkspaceId;
  return { context, session, workspaceId, port: listeningPort(context.app) };
}

async function importAq(ready: Awaited<ReturnType<typeof readyDaemon>>) {
  const body = buildMultipartBody({ fields: { projectName: 'AQ' }, files: aqFiles() });
  const response = await ready.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ready.workspaceId}/plan-imports`,
    headers: {
      cookie: ready.session.cookie,
      origin: ready.context.config.publicOrigin,
      [CSRF_HEADER_NAME]: ready.session.csrfToken,
      'content-type': body.contentType,
    },
    payload: body.payload,
  });
  return planImportResponseSchema.parse(response.json());
}

describe('planning event delivery', () => {
  it('reaches a connected client through same-process notification (CT03-A45)', async () => {
    // The fallback poll is set an order of magnitude longer than this test, so
    // an event that arrives cannot have come from polling.
    const ready = await readyDaemon({ waitTimeoutMs: FALLBACK_LONGER_THAN_TEST_MS });
    const cursor = ready.context.storage.workspaceEvents.maxSequence();
    const stream = await openStream(ready.port, ready.session.cookie, ready.workspaceId, cursor);
    try {
      const started = Date.now();
      const result = await importAq(ready);
      if (result.outcome !== 'succeeded') {
        throw new Error('Expected the import to succeed');
      }
      const event = await stream.waitForKind('plan-version-imported');
      const elapsed = Date.now() - started;

      expect((event.payload as { itemCount: number }).itemCount).toBe(14);
      expect((event.payload as { requiredDependencyCount: number }).requiredDependencyCount).toBe(
        24,
      );
      expect(elapsed).toBeLessThan(FALLBACK_LONGER_THAN_TEST_MS / 10);
      expect(stream.events.map((event_) => (event_ as { kind: string }).kind)).toEqual([
        'project-created',
        'plan-version-imported',
      ]);
    } finally {
      stream.close();
    }
  });

  it('reaches a connected client when a work item is admitted (CT03-A46)', async () => {
    const ready = await readyDaemon({ waitTimeoutMs: FALLBACK_LONGER_THAN_TEST_MS });
    const imported = await importAq(ready);
    if (imported.outcome !== 'succeeded') {
      throw new Error('Expected the import to succeed');
    }
    const aq01 = ready.context.storage.planning.workItems
      .listForVersion(ready.workspaceId, imported.planVersionId)
      .find((item) => item.sourceId === 'AQ-01');
    if (aq01 === undefined) {
      throw new Error('AQ-01 missing');
    }

    const cursor = ready.context.storage.workspaceEvents.maxSequence();
    const stream = await openStream(ready.port, ready.session.cookie, ready.workspaceId, cursor);
    try {
      const started = Date.now();
      const response = await ready.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ready.workspaceId}/work-items/${aq01.id}/admit`,
        headers: {
          cookie: ready.session.cookie,
          origin: ready.context.config.publicOrigin,
          [CSRF_HEADER_NAME]: ready.session.csrfToken,
          'content-type': 'application/json',
        },
        payload: {},
      });
      expect(response.statusCode).toBe(200);

      const event = await stream.waitForKind('work-item-admitted');
      const elapsed = Date.now() - started;
      expect((event.payload as { sourceWorkItemId: string }).sourceWorkItemId).toBe('AQ-01');
      expect(elapsed).toBeLessThan(FALLBACK_LONGER_THAN_TEST_MS / 10);
      expect(stream.events).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  it('emits no second event for a repeated admission (CT03-A54)', async () => {
    const ready = await readyDaemon({ waitTimeoutMs: FALLBACK_LONGER_THAN_TEST_MS });
    const imported = await importAq(ready);
    if (imported.outcome !== 'succeeded') {
      throw new Error('Expected the import to succeed');
    }
    const aq01 = ready.context.storage.planning.workItems
      .listForVersion(ready.workspaceId, imported.planVersionId)
      .find((item) => item.sourceId === 'AQ-01');
    const admit = () =>
      ready.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ready.workspaceId}/work-items/${aq01?.id}/admit`,
        headers: {
          cookie: ready.session.cookie,
          origin: ready.context.config.publicOrigin,
          [CSRF_HEADER_NAME]: ready.session.csrfToken,
          'content-type': 'application/json',
        },
        payload: {},
      });

    await admit();
    const cursor = ready.context.storage.workspaceEvents.maxSequence();
    const stream = await openStream(ready.port, ready.session.cookie, ready.workspaceId, cursor);
    try {
      await admit();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(stream.events).toEqual([]);
      expect(ready.context.storage.workspaceEvents.maxSequence()).toBe(cursor);
    } finally {
      stream.close();
    }
  });

  it('recovers a dropped notification through the durable re-query (CT03-A47)', async () => {
    // Same production stream path, but with a short fallback and a notifier
    // whose wakeup is suppressed: CT-02's durable timeout must still deliver.
    const ready = await readyDaemon({ waitTimeoutMs: 150 });
    const notifier = ready.context.services.workspaceEventNotifier;
    const realNotify = notifier.notify.bind(notifier);
    notifier.notify = () => {
      /* deliberately dropped */
    };

    const cursor = ready.context.storage.workspaceEvents.maxSequence();
    const stream = await openStream(ready.port, ready.session.cookie, ready.workspaceId, cursor);
    try {
      const result = await importAq(ready);
      if (result.outcome !== 'succeeded') {
        throw new Error('Expected the import to succeed');
      }
      const event = await stream.waitForKind('plan-version-imported', 5_000);
      expect((event.payload as { itemCount: number }).itemCount).toBe(14);
    } finally {
      notifier.notify = realNotify;
      stream.close();
    }
  });

  it('has no gap or duplicate when the import commits before the snapshot', async () => {
    const ready = await readyDaemon({ waitTimeoutMs: FALLBACK_LONGER_THAN_TEST_MS });
    const result = await importAq(ready);
    if (result.outcome !== 'succeeded') {
      throw new Error('Expected the import to succeed');
    }

    const snapshot = await ready.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ready.workspaceId}/snapshot`,
      headers: { cookie: ready.session.cookie },
    });
    const body = snapshot.json() as {
      asOfSequence: number;
      recentActivity: { sequence: number; kind: string }[];
    };
    const stream = await openStream(
      ready.port,
      ready.session.cookie,
      ready.workspaceId,
      body.asOfSequence,
    );
    try {
      // The snapshot already contains both events, so replay after its cursor
      // must add nothing: no duplicate.
      expect(body.recentActivity.map((event) => event.kind)).toEqual([
        'workspace-created',
        'project-created',
        'plan-version-imported',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stream.events).toEqual([]);
    } finally {
      stream.close();
    }
  });

  it('has no gap when the snapshot is taken before the import commits (CT03-A49)', async () => {
    const ready = await readyDaemon({ waitTimeoutMs: FALLBACK_LONGER_THAN_TEST_MS });
    const snapshot = await ready.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${ready.workspaceId}/snapshot`,
      headers: { cookie: ready.session.cookie },
    });
    const body = snapshot.json() as { asOfSequence: number };
    const stream = await openStream(
      ready.port,
      ready.session.cookie,
      ready.workspaceId,
      body.asOfSequence,
    );
    try {
      const result = await importAq(ready);
      if (result.outcome !== 'succeeded') {
        throw new Error('Expected the import to succeed');
      }
      await stream.waitForKind('plan-version-imported');
      // Every event committed after the snapshot cursor appears exactly once.
      const sequences = stream.events.map((event) => (event as { sequence: number }).sequence);
      expect(sequences).toEqual([...sequences].toSorted((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(stream.events.map((event) => (event as { kind: string }).kind)).toEqual([
        'project-created',
        'plan-version-imported',
      ]);
    } finally {
      stream.close();
    }
  });

  it('emits no event for a duplicate or failed import (CT03-A44)', async () => {
    const ready = await readyDaemon({ waitTimeoutMs: FALLBACK_LONGER_THAN_TEST_MS });
    await importAq(ready);
    const cursor = ready.context.storage.workspaceEvents.maxSequence();
    const stream = await openStream(ready.port, ready.session.cookie, ready.workspaceId, cursor);
    try {
      const duplicate = await importAq(ready);
      expect(duplicate.outcome).toBe('duplicate');

      const failed = await ready.context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${ready.workspaceId}/plan-imports`,
        headers: {
          cookie: ready.session.cookie,
          origin: ready.context.config.publicOrigin,
          [CSRF_HEADER_NAME]: ready.session.csrfToken,
          'content-type': buildMultipartBody({}).contentType,
        },
        payload: buildMultipartBody({
          fields: { projectName: 'Broken' },
          files: [
            {
              fieldName: 'implementation-plan',
              filename: 'plan.md',
              contentType: 'text/markdown',
              bytes: new TextEncoder().encode('# Plan\n'),
            },
          ],
        }).payload,
      });
      expect(planImportResponseSchema.parse(failed.json()).outcome).toBe('failed-validation');

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(stream.events).toEqual([]);
      expect(ready.context.storage.workspaceEvents.maxSequence()).toBe(cursor);
    } finally {
      stream.close();
    }
  });
});
