import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromEnv } from './config.js';
import { createRuntime } from './composition.js';

const E2E_USERNAME = 'e2e-admin';
const E2E_PASSWORD = 'correct horse battery staple';
const directory = mkdtempSync(join(tmpdir(), 'craftingtable-e2e-'));
const config = configFromEnv({
  CRAFTINGTABLE_DATA_DIR: directory,
  CRAFTINGTABLE_HOST: '127.0.0.1',
  CRAFTINGTABLE_PORT: '4600',
  CRAFTINGTABLE_PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
  CRAFTINGTABLE_LOG_LEVEL: 'warn',
});
const runtime = await createRuntime(config, { logger: true });
await runtime.services.bootstrapService.bootstrap(E2E_USERNAME, E2E_PASSWORD);

let closing = false;
async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await runtime.close();
  rmSync(directory, { recursive: true, force: true });
}

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));

await runtime.app.listen({ host: config.host, port: config.port });
