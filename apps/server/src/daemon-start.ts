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
