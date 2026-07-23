import { FakeAgentBackend, FakeGitService, loadDemoRunScript } from '@craftingtable/testing';
import { configFromEnv } from './config.js';
import { buildServer } from './server.js';

const config = configFromEnv();
const script = await loadDemoRunScript();
const git = new FakeGitService();
const backend = new FakeAgentBackend(script, git);

const app = buildServer({ backend, git }, { logger: true });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(`backend: ${backend.describe().label} (simulated)`);
