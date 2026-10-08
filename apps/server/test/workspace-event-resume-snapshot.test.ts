import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentBackend } from '@craftingtable/agents';
import { SSE_WORKSPACE_EVENT_NAME, workspaceEventEnvelopeSchema } from '@craftingtable/contracts';
import {
  type AgentBackendKind,
  asEventId,
  asSessionId,
  asUserId,
  asWorkspaceId,
} from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import {
  copyDatabase,
  discoverMigrations,
  inspectMigrationStatus,
  openDatabase,
  runMigrations,
} from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { createDaemon } from '../src/composition.js';
import { configFromEnv, SESSION_COOKIE_NAME } from '../src/config.js';
import { openDaemonStorage } from '../src/persisted-records.js';
import { testDataRoot } from './test-support.js';

/**
 * R-H6's end-to-end check, on a copy of a real database: a browser that last saw an event
 * before migration 0040 rebuilt the journal reconnects with that `Last-Event-ID`, and the real
 * daemon's stream sends every later event of its workspace once, in order, and then the first
 * event appended after the migration, whose sequence follows the old high-water mark.
 *
 * The daemon is built as `controller:replay --page-load` builds it over a snapshot: its workers
 * stopped, no restart recovery, Git stubbed to fail and no agent backend, so nothing reaches
 * the worktrees or repositories the snapshot names. Point `CRAFTINGTABLE_MIGRATION_SNAPSHOT` at
 * a snapshot below schema 40, never at a live database:
 *
 *     CRAFTINGTABLE_MIGRATION_SNAPSHOT=<copy>/snapshot.sqlite \
 *       pnpm exec vitest run --project node apps/server/test/workspace-event-resume-snapshot.test.ts
 */
const SNAPSHOT = process.env.CRAFTINGTABLE_MIGRATION_SNAPSHOT;
const RESUMED = 40;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function* frames(response: Response): AsyncGenerator<{ event?: string; id?: string }> {
  if (response.body === null) throw new Error('The stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const event = part.match(/^event: (.+)$/m)?.[1];
      const id = part.match(/^id: (.+)$/m)?.[1];
      const data = part.match(/^data: (.+)$/m)?.[1];
      if (event === SSE_WORKSPACE_EVENT_NAME && data !== undefined)
        expect(workspaceEventEnvelopeSchema.parse(JSON.parse(data)).sequence).toBe(Number(id));
      yield { ...(event === undefined ? {} : { event }), ...(id === undefined ? {} : { id }) };
    }
  }
}

it.skipIf(SNAPSHOT === undefined)(
  "resumes a snapshot's event stream across migration 0040 without a gap or a repeat (R-H6)",
  async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-resume-0040-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite');
    await copyDatabase(SNAPSHOT as string, path);

    // Before: schema 39, as the deployed daemon would leave it, and what a browser last saw.
    const prepared = openDatabase(path);
    runMigrations(
      prepared,
      discoverMigrations().filter((migration) => migration.version <= 39),
    );
    const highWater = (
      prepared.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'").get() as {
        seq: number;
      }
    ).seq;
    const busiest = prepared
      .prepare(
        `SELECT workspace_id AS workspaceId FROM workspace_events
         GROUP BY workspace_id ORDER BY COUNT(*) DESC LIMIT 1`,
      )
      .get() as { workspaceId: string };
    const sequences = (
      prepared
        .prepare('SELECT sequence FROM workspace_events WHERE workspace_id = ? ORDER BY sequence')
        .all(busiest.workspaceId) as { sequence: number }[]
    ).map((row) => row.sequence);
    const member = prepared
      .prepare(
        `SELECT m.user_id AS userId FROM workspace_memberships AS m
         JOIN users AS u ON u.id = m.user_id
         WHERE m.workspace_id = ? AND m.status = 'active' AND u.status = 'active' LIMIT 1`,
      )
      .get(busiest.workspaceId) as { userId: string };
    prepared.close();
    expect(inspectMigrationStatus(path).currentVersion).toBe(39);
    const lastSeen = sequences.at(-RESUMED - 1) ?? 0;
    const expected = sequences.filter((sequence) => sequence > lastSeen);

    // The daemon opens it: migration 0040 runs here, under the contract guard.
    const storage = openDaemonStorage(path);
    expect(storage.migrationStatus.currentVersion).toBe(40);
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: directory,
      CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
      CRAFTINGTABLE_WEB_DIST: '',
    });
    const git = new Proxy({} as GitOperations, {
      get: (_target, method) => async () => ({
        ok: false,
        failure: { kind: 'spawn-failed', message: `No Git in this test (${String(method)}).` },
      }),
    });
    const daemon = await createDaemon(storage, config, {
      overrides: {
        gitOperations: git,
        agentBackends: new Map<AgentBackendKind, AgentBackend>(),
        notificationTransport: { send: async () => ({ status: 'accepted' }) },
        restartRecovery: false,
      },
      server: { logger: false, startWorkers: false },
    });
    const controller = new AbortController();
    try {
      const raw = randomBytes(32).toString('base64url');
      const now = new Date();
      storage.transaction((tx) =>
        tx.sessions.insert({
          id: asSessionId(randomUUID()),
          userId: asUserId(member.userId),
          tokenDigest: createHash('sha256').update(raw, 'utf8').digest('hex'),
          csrfToken: randomBytes(32).toString('base64url'),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        }),
      );
      await daemon.app.listen({ host: '127.0.0.1', port: 0 });
      const port = daemon.app.addresses()[0]?.port;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/${busiest.workspaceId}/events`,
        {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${raw}`, 'last-event-id': String(lastSeen) },
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);

      const received: number[] = [];
      let appended: number | undefined;
      for await (const frame of frames(response)) {
        if (frame.event !== SSE_WORKSPACE_EVENT_NAME) continue;
        received.push(Number(frame.id));
        if (received.length === expected.length) {
          // Caught up: the next event, appended after the migration, follows the high-water mark.
          appended = storage.transaction((tx) =>
            tx.workspaceEvents.appendEvent({
              id: asEventId(randomUUID()),
              occurredAt: new Date().toISOString(),
              workspaceId: asWorkspaceId(busiest.workspaceId),
              kind: 'attention-changed',
              payload: { open: 0 },
            }),
          ).sequence;
          daemon.services.workspaceEventNotifier.notify();
        }
        if (received.length === expected.length + 1) break;
      }
      expect(received.slice(0, expected.length)).toEqual(expected);
      expect(appended).toBe(highWater + 1);
      expect(received.at(-1)).toBe(highWater + 1);
    } finally {
      controller.abort();
      await daemon.close();
    }
  },
);
