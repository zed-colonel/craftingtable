import { createRuntime } from './composition.js';
import { configFromEnv } from './config.js';
import { acquireInstanceLock, InstanceLockedError } from './instance-lock.js';

const config = configFromEnv();
// Taken before any database work: restart recovery would otherwise rewrite a
// running daemon's live state before this process failed to bind its port.
const lock = await acquireInstanceLock(config.dataDir).catch((error: unknown) => {
  if (!(error instanceof InstanceLockedError)) throw error;
  process.stderr.write(`${error.message} Refusing to start a second daemon on it.\n`);
  process.exit(1);
});
const runtime = await createRuntime(config, { logger: true });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    // A second signal stops waiting for live turns; they are interrupted for resume.
    runtime.app.log.info({ signal }, 'stop requested again; interrupting live runs now');
    runtime.services.daemonDrain.expedite();
    return;
  }
  shuttingDown = true;
  runtime.app.log.info({ signal }, 'shutting down: draining live agent turns');
  await runtime.close();
  await lock.release();
}

// A deploy that drained this daemon restarts it within seconds. If none does, the deploy
// was interrupted after the drain; exit with a failure status so the service manager
// restarts the daemon, and the recorded clean stop resumes automation (R-B9).
runtime.services.daemonDrain.whenStranded(() => {
  runtime.app.log.warn('drained for a deploy that never restarted the daemon; exiting to restart');
  void shutdown('SIGTERM').finally(() => process.exit(75));
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await runtime.app.listen({ host: config.host, port: config.port });
