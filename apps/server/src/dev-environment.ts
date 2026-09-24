import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Development defaults shared by `pnpm dev` and `pnpm craftingtable:dev`. A
 * development daemon never shares the live daemon's data directory or port
 * unless told to: it keeps its own state under `$XDG_DATA_HOME/craftingtable-dev`
 * and listens on 4601 (the web dev server's proxy target). Set
 * CRAFTINGTABLE_DATA_DIR / CRAFTINGTABLE_PORT to override.
 */
process.env.CRAFTINGTABLE_DATA_DIR ??= join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'craftingtable-dev',
);
process.env.CRAFTINGTABLE_PORT ??= '4601';
