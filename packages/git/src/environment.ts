import { dirname } from 'node:path';
import type { CanonicalPath } from './path-policy.js';

declare const gitCeilingDirectoryBrand: unique symbol;

export type GitCeilingDirectory = string & {
  readonly [gitCeilingDirectoryBrand]: true;
};

export function isGitCeilingDirectoryRepresentable(path: string): boolean {
  return !path.includes(':');
}

export function createGitCeilingDirectory(cwd: CanonicalPath): GitCeilingDirectory | undefined {
  const ceilingDirectory = dirname(cwd);
  return isGitCeilingDirectoryRepresentable(ceilingDirectory)
    ? (ceilingDirectory as GitCeilingDirectory)
    : undefined;
}

export type FixedGitCommand =
  | { readonly kind: 'version'; readonly cwd: CanonicalPath }
  | {
      readonly kind: 'identity';
      readonly cwd: CanonicalPath;
      readonly ceilingDirectory: GitCeilingDirectory;
      readonly expectedTopLevel: CanonicalPath;
      readonly expectedGitDirectory: CanonicalPath;
      readonly ancestorCandidates: readonly string[];
    }
  | {
      readonly kind: 'local-risk-signal-names';
      readonly cwd: CanonicalPath;
      readonly ceilingDirectory: GitCeilingDirectory;
    };

export const BASE_GIT_ENVIRONMENT = Object.freeze({
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
});

export function environmentFor(command: FixedGitCommand): Readonly<Record<string, string>> {
  if (command.kind === 'version') {
    return { ...BASE_GIT_ENVIRONMENT };
  }
  return {
    ...BASE_GIT_ENVIRONMENT,
    GIT_CEILING_DIRECTORIES: command.ceilingDirectory,
  };
}
