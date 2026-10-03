import type { ServerConfig } from '../../src/config.js';
import type { openDaemonStorage } from '../../src/persisted-records.js';
import { initialStorageSettings } from '../../src/services/storage-service.js';

/**
 * The free-space reserve of a test daemon, in GiB (TS-H8). Test daemons keep their data on the
 * user's runtime tmpfs, 10% of RAM by default, where the production default of 5 GiB would
 * refuse their launches; 1 GiB is the smallest reserve the storage settings allow.
 */
export const TEST_DAEMON_RESERVE_GIB = 1;

/**
 * Gives a fresh test daemon (vitest or e2e) its first storage settings with the test reserve,
 * before its services start and would write the production defaults.
 */
export function seedTestDaemonStorage(
  storage: ReturnType<typeof openDaemonStorage>,
  config: ServerConfig,
): void {
  if (storage.maintenance.settings()) return;
  const settings = initialStorageSettings(config, { minimumFreeGiB: TEST_DAEMON_RESERVE_GIB });
  storage.transaction((tx) => tx.maintenance.saveSettings(settings));
}
