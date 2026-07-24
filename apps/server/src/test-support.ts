import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCraftingTableStorage } from '@craftingtable/storage';
import type { FastifyInstance } from 'fastify';
import { configFromEnv, SESSION_COOKIE_NAME, type ServerConfig } from './config.js';
import { createServices, type ServiceSet } from './composition.js';
import type { PasswordHasher } from './security/password-hasher.js';
import { buildServer } from './server.js';

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
  readonly storage: ReturnType<typeof openCraftingTableStorage>;
  bootstrap(): Promise<void>;
  login(): Promise<{ cookie: string; csrfToken: string; sessionId: string }>;
  cleanup(): Promise<void>;
}

export async function createTestContext(
  options: {
    readonly now?: () => Date;
    readonly passwordHasher?: PasswordHasher;
    readonly publicOrigin?: string;
    readonly loggerStream?: { write(message: string): void };
  } = {},
): Promise<TestContext> {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-server-test-'));
  const config = configFromEnv({
    CRAFTINGTABLE_DATA_DIR: directory,
    CRAFTINGTABLE_PUBLIC_ORIGIN: options.publicOrigin ?? 'http://127.0.0.1:5173',
    CRAFTINGTABLE_LOG_LEVEL: 'silent',
  });
  const storage = openCraftingTableStorage(config.databasePath);
  const services = await createServices(storage, config, {
    passwordHasher: options.passwordHasher ?? new FastTestPasswordHasher(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const app = buildServer(
    {
      authService: services.authService,
      workspaceService: services.workspaceService,
      workspaceEventStreamService: services.workspaceEventStreamService,
    },
    config,
    options.loggerStream === undefined
      ? { logger: false }
      : { logger: true, loggerStream: options.loggerStream },
  );
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
      await app.close();
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
