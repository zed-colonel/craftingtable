import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentLaunchRequest } from './index.js';
import { launchCargoHome } from './outside-sources.js';

/** The system Docker socket, under both of its usual names. */
export const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'] as const;

/** Claude Code's login, the one file of `~/.claude` a sandboxed command must not read. */
export const CLAUDE_CREDENTIALS_FILE = '~/.claude/.credentials.json';

/**
 * uv's stored credentials (`uv auth login`) and its user configuration, which may hold an
 * index's credentials (R-G17): at XDG's default places always, and where the daemon's XDG
 * variables say too, when they say something else. The daemon's unit may set them differently
 * from the operator's shell, whose uv writes the defaults (review L-9).
 */
export function uvConfigPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const defaults = ['~/.local/share/uv/credentials', '~/.config/uv'];
  const named = [
    ...(env.XDG_DATA_HOME !== undefined && isAbsolute(env.XDG_DATA_HOME)
      ? [join(env.XDG_DATA_HOME, 'uv', 'credentials')]
      : []),
    ...(env.XDG_CONFIG_HOME !== undefined && isAbsolute(env.XDG_CONFIG_HOME)
      ? [join(env.XDG_CONFIG_HOME, 'uv')]
      : []),
  ];
  // An XDG path that is a default spelled out is listed once, as the default.
  const spelled = defaults.map((path) => join(homedir(), path.slice(2)));
  return [...defaults, ...named.filter((path) => !spelled.includes(path))];
}

/**
 * What a sandboxed agent command may not read (R-G5 review; shared by both adapters since R-G14):
 * the user's runtime directory, which holds the rootless Docker socket and the session bus (Unix
 * sockets are not otherwise blocked where Claude Code's seccomp helper is absent), system Docker
 * sockets, and the operator's credentials. The agent itself still reads its own login; only the
 * agent's commands are denied. Each adapter passes it in the form its sandbox can apply.
 */
export function sandboxDeniedReads(
  request: Pick<AgentLaunchRequest, 'environment' | 'deniedReads'>,
): string[] {
  const uid = process.getuid?.();
  return [
    ...(uid === undefined ? [] : [`/run/user/${uid}`]),
    ...DOCKER_SOCKETS,
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.docker',
    '~/.config/gh',
    '~/.git-credentials',
    '~/.codex',
    CLAUDE_CREDENTIALS_FILE,
    // Cargo's registry tokens, which would let a command publish or yank as the operator.
    join(launchCargoHome(request), 'credentials.toml'),
    join(launchCargoHome(request), 'credentials'),
    // PyPI's and uv's credentials, and uv's own configuration (R-G17).
    '~/.pypirc',
    '~/.netrc',
    ...uvConfigPaths(),
    // The daemon's database, its copies and the credentials file (R-G9).
    ...(request.deniedReads ?? []),
  ];
}
