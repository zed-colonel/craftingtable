import { configFromEnv } from './config.js';
import { createRuntime } from './composition.js';

const config = configFromEnv();
const runtime = await createRuntime(config, { logger: true });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  runtime.app.log.info({ signal }, 'shutting down');
  await runtime.close();
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await runtime.app.listen({ host: config.host, port: config.port });
