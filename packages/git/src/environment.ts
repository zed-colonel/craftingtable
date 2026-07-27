import { dirname } from 'node:path';

export type FixedGitCommand =
  | { readonly kind: 'version'; readonly cwd: string }
  | {
      readonly kind: 'identity';
      readonly cwd: string;
      readonly expectedTopLevel: string;
      readonly expectedGitDirectory: string;
      readonly ancestorCandidates: readonly string[];
    }
  | { readonly kind: 'local-risk-signal-names'; readonly cwd: string };

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
    GIT_CEILING_DIRECTORIES: dirname(command.cwd),
  };
}
