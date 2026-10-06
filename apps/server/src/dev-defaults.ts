import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Development defaults shared by `pnpm dev` and `pnpm craftingtable:dev`. A
 * development daemon never shares the live daemon's data directory, port or
 * settings directory unless told to: it keeps its own state under
 * `$XDG_DATA_HOME/craftingtable-dev`, its credentials file under
 * `$XDG_CONFIG_HOME/craftingtable-dev` (R-G9 review: a dev daemon on a copy of the
 * live database must not change the live credentials), and listens on 4601 (the
 * web dev server's proxy target). Set CRAFTINGTABLE_DATA_DIR,
 * CRAFTINGTABLE_CONFIG_DIR or CRAFTINGTABLE_PORT to override.
 */
export function developmentDefaults(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    CRAFTINGTABLE_DATA_DIR:
      env.CRAFTINGTABLE_DATA_DIR ??
      join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'craftingtable-dev'),
    CRAFTINGTABLE_CONFIG_DIR:
      env.CRAFTINGTABLE_CONFIG_DIR ??
      join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'craftingtable-dev'),
    CRAFTINGTABLE_PORT: env.CRAFTINGTABLE_PORT ?? '4601',
  };
}
