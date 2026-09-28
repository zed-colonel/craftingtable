/**
 * The environment a child of the daemon starts from: named variables only, never the daemon's
 * whole environment (SEC-02). Desktop session variables (D-Bus, Wayland, X11, Hyprland),
 * `XDG_RUNTIME_DIR` with the Docker socket, SSH agents and anything else the operator's
 * session carries stay out unless a caller names them.
 */
const BASE_VARIABLES = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

export function allowlistedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
): Record<string, string> {
  const allowed = new Set<string>([...BASE_VARIABLES, ...extra]);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(key) || key.startsWith('LC_')))
      environment[key] = value;
  }
  return environment;
}
