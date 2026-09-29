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

/** What an agent needs to reach its vendor through a proxy or a private CA. */
const NETWORK_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * An agent's environment (R-G5, SEC-02, AGT-04): the named variables of `source`, the vendor's
 * own login variables (`vendor`), any names the operator allowed (`extra`), then the run's
 * overlay the daemon computed, with the run's directories ahead of PATH. Nothing else of the
 * daemon's environment reaches the agent.
 */
export function agentEnvironment(
  source: NodeJS.ProcessEnv,
  vendor: readonly string[],
  extra: readonly string[],
  overlay: Readonly<Record<string, string>> = {},
  pathPrefix: readonly string[] = [],
): Record<string, string> {
  const base = allowlistedEnvironment(source, [...NETWORK_VARIABLES, ...vendor, ...extra]);
  const path = [...pathPrefix, overlay.PATH ?? base.PATH ?? ''].filter(Boolean).join(':');
  return { ...base, ...overlay, ...(path ? { PATH: path } : {}) };
}
