import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend } from '@craftingtable/agents';
import { CYCLE_ATTENTION } from '@craftingtable/domain';
import type { GitOperations } from '@craftingtable/git';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { copyMigratedTemplate } from '../../../packages/storage/test/test-support.js';
import { type CraftingTableRuntime, createDaemon, type ServiceSet } from '../src/composition.js';
import { configFromEnv, SESSION_COOKIE_NAME, type ServerConfig } from '../src/config.js';
import { groupedIssues } from '../src/db-verify.js';
import { openDaemonStorage, verified, verifyRecords } from '../src/persisted-records.js';
import type { PasswordHasher } from '../src/security/password-hasher.js';
import type { NotificationTransport } from '../src/services/notification-transport.js';
import type { RunLog } from '../src/services/agent-run-service.js';
import type { WorkspaceEventStreamHooks } from '../src/services/workspace-event-stream-service.js';
import { seedTestDaemonStorage } from './e2e/test-daemon-storage.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Where test daemons keep their data, chosen once for the run (TS-H8). */
    testDataRoot: string;
  }
}

/**
 * Where test daemons keep their data directories (TS-H8): the root `vitest.config.ts` chose
 * once for the run with `chooseTestDataRoot`: `CRAFTINGTABLE_TEST_DATA_ROOT`, or the user's
 * runtime tmpfs when that is not set (R-I2).
 */
export function testDataRoot(): string {
  const root = inject('testDataRoot');
  if (typeof root !== 'string') throw new Error('vitest.config.ts provides no testDataRoot');
  return root;
}

export const TEST_USERNAME = 'test-user';
export const TEST_PASSWORD = 'correct horse battery staple';

export class FastTestPasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return Promise.resolve(`$argon2id$test$${Buffer.from(password).toString('base64url')}`);
  }

  verify(encodedHash: string, password: string): Promise<boolean> {
    return Promise.resolve(
      encodedHash === `$argon2id$test$${Buffer.from(password).toString('base64url')}`,
    );
  }
}

export interface TestContext {
  readonly directory: string;
  readonly config: ServerConfig;
  readonly app: FastifyInstance;
  readonly services: ServiceSet;
  readonly storage: ReturnType<typeof openDaemonStorage>;
  bootstrap(): Promise<void>;
  login(): Promise<{ cookie: string; csrfToken: string; sessionId: string }>;
  cleanup(): Promise<void>;
}

export async function createTestContext(
  options: {
    readonly notificationTransport?: NotificationTransport;
    readonly now?: () => Date;
    readonly passwordHasher?: PasswordHasher;
    readonly publicOrigin?: string;
    readonly loggerStream?: { write(message: string): void };
    readonly streamHooks?: WorkspaceEventStreamHooks;
    readonly gitOperations?: GitOperations | null;
    readonly agentBackends?: ReadonlyMap<
      import('@craftingtable/domain').AgentBackendKind,
      AgentBackend
    >;
    readonly env?: Readonly<Record<string, string>>;
    /** Where the agent run and check request services' warnings go; nowhere by default. */
    readonly runLog?: RunLog;
    /** False leaves the controller loops stopped so the test steps them itself. */
    readonly workers?: boolean;
    /** False skips the cleanup's record check, for tests that store invalid rows on purpose. */
    readonly verifyRecords?: boolean;
  } = {},
): Promise<TestContext> {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-server-test-'));
  const config = configFromEnv({
    CRAFTINGTABLE_DATA_DIR: directory,
    // Its own credentials file, never the operator's (R-G9).
    CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
    CRAFTINGTABLE_PUBLIC_ORIGIN: options.publicOrigin ?? 'http://127.0.0.1:5173',
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
    // Fixture repositories are made under the temporary directory and the test data root (R-G9).
    CRAFTINGTABLE_REPOSITORY_ROOTS: [tmpdir(), testDataRoot()].join(':'),
    // The API surface under test is the route allowlist; static serving is opt-in.
    CRAFTINGTABLE_WEB_DIST: '',
    // Closing a test daemon interrupts live fake runs at once instead of draining them.
    CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '0',
    // Checks run as plain process groups here; the systemd unit has its own adapter test.
    CRAFTINGTABLE_CHECK_CONFINEMENT: 'none',
    ...options.env,
  });
  // A copy of the run's migrated template, not a migration of its own (TS-M13). It holds no
  // settings, so the test reserve below is still the daemon's first-boot save.
  let storage: ReturnType<typeof openDaemonStorage>;
  try {
    copyMigratedTemplate(config.databasePath);
    storage = openDaemonStorage(config.databasePath);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  // What the record checks found once the daemon stopped, before its storage closed.
  let untyped: string[] = [];
  let unverified: string[] = [];
  let daemon: CraftingTableRuntime;
  try {
    seedTestDaemonStorage(storage, config);
    // The daemon production runs, and its close (TS-M14): only the services' seams differ.
    daemon = await createDaemon(storage, config, {
      overrides: {
        notificationTransport: options.notificationTransport ?? {
          send: async () => ({ status: 'accepted' }),
        },
        passwordHasher: options.passwordHasher ?? new FastTestPasswordHasher(),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.streamHooks === undefined ? {} : { streamHooks: options.streamHooks }),
        // Tests never reach the real Git or Claude executables unless they opt in.
        gitOperations: options.gitOperations === undefined ? null : options.gitOperations,
        agentBackends: options.agentBackends ?? new Map(),
        ...(options.runLog === undefined ? {} : { runLog: options.runLog }),
      },
      server: {
        ...(options.loggerStream === undefined
          ? { logger: false }
          : { logger: true, loggerStream: options.loggerStream }),
        ...(options.workers === false ? { startWorkers: false } : {}),
      },
      beforeStorageCloses: () => {
        untyped = untypedStops(storage);
        unverified = options.verifyRecords === false ? [] : unverifiedRecords(storage);
      },
    });
  } catch (error) {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const { app, services } = daemon;
  let closed = false;
  return {
    directory,
    config,
    app,
    services,
    storage,
    async bootstrap() {
      await services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
    },
    async login() {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          origin: config.publicOrigin,
          'content-type': 'application/json',
          'user-agent': 'CraftingTable test',
        },
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      if (response.statusCode !== 200) {
        throw new Error(`Test login failed: ${response.statusCode} ${response.body}`);
      }
      const setCookie = response.headers['set-cookie'];
      const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookie = rawCookie?.split(';')[0];
      if (cookie === undefined || !cookie.startsWith(`${SESSION_COOKIE_NAME}=`)) {
        throw new Error('Test login did not return a session cookie');
      }
      const body = response.json() as { csrfToken: string; session: { id: string } };
      return { cookie, csrfToken: body.csrfToken, sessionId: body.session.id };
    },
    async cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      // The daemon's own close: a check still running would otherwise write its log into the
      // data directory after it is removed, and leave it behind (TS-M14, TS-H8). The directory
      // goes whatever the close or the record checks found (ARCH F8d).
      try {
        await daemon.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      if (untyped.length)
        throw new Error(`Stops written without typed attention (R-A3): ${untyped.join('; ')}`);
      if (unverified.length)
        throw new Error(`Stored records break their contracts (R-H3): ${unverified.join('; ')}`);
    },
  };
}

/**
 * Contract check run by every test daemon on cleanup (R-A3): whatever path a test drove,
 * each cycle it left needs-attention or awaiting-merge, and each roadmap or entry hold it
 * left needs-attention, carries typed attention whose owner is the one its code declares.
 */
export function untypedStops(storage: ReturnType<typeof openDaemonStorage>): string[] {
  const problems: string[] = [];
  for (const cycle of storage.execution.cycles.listAll())
    if (
      (cycle.status === 'needs-attention' || cycle.status === 'awaiting-merge') &&
      (!cycle.attention ||
        cycle.attention.owner !==
          (cycle.attention.claim ? 'controller' : CYCLE_ATTENTION[cycle.attention.code]))
    )
      problems.push(`cycle ${cycle.status}: ${cycle.reason.slice(0, 80)}`);
  for (const roadmap of storage.roadmaps.list()) {
    if (roadmap.status === 'needs-attention' && !roadmap.attention)
      problems.push(`roadmap needs-attention: ${roadmap.reason.slice(0, 80)}`);
    for (const hold of Object.values(roadmap.entryHolds ?? {}))
      if (hold.status === 'needs-attention' && !hold.attention)
        problems.push(`entry hold: ${hold.reason.slice(0, 80)}`);
  }
  return problems;
}

/**
 * Contract check run by every test daemon on cleanup (R-H3): every record the test left,
 * whichever path wrote it, reads back through the storage upcasters and conforms to its
 * contract, as `pnpm db:verify` checks a live snapshot, including the v0.3 format check on
 * saved map sources (R-F3, FMT-15).
 */
export function unverifiedRecords(storage: ReturnType<typeof openDaemonStorage>): string[] {
  const verification = verifyRecords(storage);
  return verified(verification)
    ? []
    : groupedIssues(verification)
        .map((group) => `${group.count}x ${group.issue} (${group.example})`)
        .concat(verification.integrity);
}

/**
 * Rebuilds full route paths from Fastify's prefix-nested route tree.
 *
 * Each nesting level is four characters of indent, and each node contributes a
 * path fragment that must be concatenated with its ancestors.
 */
export function routeTable(printed: string): readonly string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of printed.split('\n')) {
    const match = /^([│\s]*)(?:├──|└──)\s(\S*)\s\(([^)]+)\)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const depth = (match[1] as string).length / 4;
    stack.length = depth;
    stack[depth] = match[2] as string;
    const url = stack.join('');
    for (const method of (match[3] as string).split(', ')) {
      if (method !== 'HEAD' && method !== 'OPTIONS') {
        routes.push(`${method} ${url}`);
      }
    }
  }
  return routes;
}
