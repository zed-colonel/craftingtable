import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Host tools for tests, found the way the daemon finds them: on PATH, then in rustup's
 * default directory for Cargo (R-I5, QA-08). Nothing here assumes a fixed install path.
 */
function hostExecutable(
  name: string,
  extraDirectories: readonly string[] = [],
): string | undefined {
  const directories = [...(process.env.PATH?.split(delimiter) ?? []), ...extraDirectories];
  for (const directory of directories.filter((entry) => entry.length > 0)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Next directory.
    }
  }
  return undefined;
}

/** Git is required: every repository fixture needs it. */
export function hostGit(): string {
  const git = hostExecutable('git');
  if (git === undefined) throw new Error('These tests need a git executable on PATH.');
  return git;
}

/** Cargo, or undefined on a host without Rust; the Cargo tests skip there. */
export const hostCargo = hostExecutable('cargo', [join(homedir(), '.cargo', 'bin')]);
