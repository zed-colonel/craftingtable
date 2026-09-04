import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Resolves a tool executable: an explicit absolute path, else the first
 * executable of that name on PATH. Returns undefined rather than throwing so
 * composition can run with a feature disabled and report it.
 */
export function resolveExecutable(
  name: string,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  extraDirectories: readonly string[] = [],
): string | undefined {
  const candidates: string[] = [];
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      return undefined;
    }
    candidates.push(explicit);
  } else {
    for (const entry of env.PATH?.split(delimiter) ?? []) {
      if (entry.length > 0) {
        candidates.push(join(entry, name));
      }
    }
    for (const directory of extraDirectories) {
      candidates.push(join(directory, name));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Next candidate.
    }
  }
  return undefined;
}
