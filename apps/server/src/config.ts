export interface ServerConfig {
  host: string;
  port: number;
}

export const SERVER_VERSION = '0.1.0';

/**
 * Until the authenticated TLS deployment work item (ADR-006), the
 * unauthenticated CT-01 server must never listen on a non-loopback interface,
 * regardless of environment configuration.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.CRAFTINGTABLE_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `CRAFTINGTABLE_HOST must be a loopback address (127.0.0.1, localhost, or ::1) until ` +
        `authenticated TLS deployment lands (ADR-006); got "${host}"`,
    );
  }

  const port = Number(env.CRAFTINGTABLE_PORT ?? 4600);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `CRAFTINGTABLE_PORT must be an integer between 1 and 65535; got "${env.CRAFTINGTABLE_PORT}"`,
    );
  }

  return { host, port };
}
