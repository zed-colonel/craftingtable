import { tmpdir } from 'node:os';

/**
 * The e2e daemon's configuration (R-I9): a fresh data directory and fixed test settings, plus
 * the few variables the Playwright config passes through. Everything else of the caller's
 * environment is ignored, so a variable set on the command line cannot change the daemon under
 * test by accident.
 */
export function e2eEnvironment(
  directory: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return {
    CRAFTINGTABLE_DATA_DIR: directory,
    CRAFTINGTABLE_HOST: '127.0.0.1',
    // Defaults match `playwright.config.ts`, away from the 4600/5173 an operator
    // daemon or `pnpm dev` uses; Playwright passes both explicitly.
    CRAFTINGTABLE_PORT: env.CRAFTINGTABLE_PORT ?? '4610',
    CRAFTINGTABLE_PUBLIC_ORIGIN: env.CRAFTINGTABLE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5183',
    CRAFTINGTABLE_LOG_LEVEL: 'warn',
    CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS: '0',
    // The specs make their fixture repositories under the temporary directory (R-G9).
    CRAFTINGTABLE_REPOSITORY_ROOTS: tmpdir(),
    ...(env.CRAFTINGTABLE_CLAUDE_EXECUTABLE === undefined
      ? {}
      : { CRAFTINGTABLE_CLAUDE_EXECUTABLE: env.CRAFTINGTABLE_CLAUDE_EXECUTABLE }),
    ...(env.CRAFTINGTABLE_CODEX_EXECUTABLE === undefined
      ? {}
      : { CRAFTINGTABLE_CODEX_EXECUTABLE: env.CRAFTINGTABLE_CODEX_EXECUTABLE }),
    ...(env.CRAFTINGTABLE_GIT_EXECUTABLE === undefined
      ? {}
      : { CRAFTINGTABLE_GIT_EXECUTABLE: env.CRAFTINGTABLE_GIT_EXECUTABLE }),
    // The gate raises workstation capacity for its parallel specs (R-I9); the walkthrough keeps
    // the defaults it photographs.
    ...(env.CRAFTINGTABLE_DEVELOPMENT_CAPACITY === undefined
      ? {}
      : { CRAFTINGTABLE_DEVELOPMENT_CAPACITY: env.CRAFTINGTABLE_DEVELOPMENT_CAPACITY }),
    ...(env.CRAFTINGTABLE_VERIFICATION_CAPACITY === undefined
      ? {}
      : { CRAFTINGTABLE_VERIFICATION_CAPACITY: env.CRAFTINGTABLE_VERIFICATION_CAPACITY }),
  };
}
