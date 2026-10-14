import { type CraftingTableRuntime, createRuntime } from './composition.js';
import type { ServerConfig } from './config.js';
import { acquireDaemonLocks, type InstanceLock } from './instance-lock.js';

export interface StartedDaemon {
  readonly runtime: CraftingTableRuntime;
  /** Held until the daemon has closed; release it last. */
  readonly lock: InstanceLock;
}

/**
 * The daemon's start (R-I8, R-G5): its locks first, then its runtime. Restart recovery marks
 * every live run interrupted and sweeps the agents' temporary root, so a second daemon on the
 * same data directory or root must be refused before either. A refused start throws
 * `InstanceLockedError` and has touched no database.
 */
export async function startDaemon(
  config: ServerConfig,
  options: Parameters<typeof createRuntime>[1] = {},
): Promise<StartedDaemon> {
  const lock = await acquireDaemonLocks(config);
  try {
    return { runtime: await createRuntime(config, options), lock };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/**
 * The daemon's stop on a signal (R-B9): the first drains live agent turns up to the configured
 * bound, records the clean stop and closes the daemon, then releases its locks; another
 * interrupts what is still live at once. Each call resolves when the stop has finished.
 */
export function daemonStop(daemon: {
  readonly runtime: Pick<CraftingTableRuntime, 'app' | 'services' | 'close'>;
  readonly lock: Pick<InstanceLock, 'release'>;
}): (signal: NodeJS.Signals) => Promise<void> {
  const { runtime, lock } = daemon;
  let stopping: Promise<void> | undefined;
  return (signal) => {
    if (stopping !== undefined) {
      runtime.app.log.info({ signal }, 'stop requested again; interrupting live runs now');
      runtime.services.daemonDrain.expedite();
      return stopping;
    }
    runtime.app.log.info({ signal }, 'shutting down: draining live agent turns');
    stopping = runtime.close().then(() => lock.release());
    return stopping;
  };
}
