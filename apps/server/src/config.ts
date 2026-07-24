import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface ServerConfig {
  readonly host: '127.0.0.1' | 'localhost' | '::1';
  readonly port: number;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly sessionLifetimeSeconds: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export const SERVER_VERSION = '0.2.0';
export const SESSION_COOKIE_NAME = 'craftingtable_session';
export const CSRF_HEADER_NAME = 'x-craftingtable-csrf';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const URL_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOG_LEVELS = new Set<ServerConfig['logLevel']>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

function dataDirectory(env: NodeJS.ProcessEnv): string {
  const override = env.CRAFTINGTABLE_DATA_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error('CRAFTINGTABLE_DATA_DIR must be an absolute path');
    }
    return override;
  }
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'craftingtable');
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const configuredHost = env.CRAFTINGTABLE_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(configuredHost)) {
    throw new Error(
      `CRAFTINGTABLE_HOST must be loopback-only until CT-08; got "${configuredHost}"`,
    );
  }
  const host = configuredHost as ServerConfig['host'];

  const port = Number(env.CRAFTINGTABLE_PORT ?? 4600);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `CRAFTINGTABLE_PORT must be an integer between 1 and 65535; got "${env.CRAFTINGTABLE_PORT}"`,
    );
  }

  const publicOriginUrl = new URL(env.CRAFTINGTABLE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173');
  if (
    !['http:', 'https:'].includes(publicOriginUrl.protocol) ||
    !URL_LOOPBACK_HOSTS.has(publicOriginUrl.hostname) ||
    publicOriginUrl.username !== '' ||
    publicOriginUrl.password !== '' ||
    publicOriginUrl.pathname !== '/' ||
    publicOriginUrl.search !== '' ||
    publicOriginUrl.hash !== ''
  ) {
    throw new Error('CRAFTINGTABLE_PUBLIC_ORIGIN must be an HTTP(S) loopback origin');
  }
  const publicOrigin = publicOriginUrl.origin;

  const sessionLifetimeSeconds = Number(env.CRAFTINGTABLE_SESSION_LIFETIME_SECONDS ?? 2_592_000);
  if (
    !Number.isInteger(sessionLifetimeSeconds) ||
    sessionLifetimeSeconds < 300 ||
    sessionLifetimeSeconds > 7_776_000
  ) {
    throw new Error(
      'CRAFTINGTABLE_SESSION_LIFETIME_SECONDS must be an integer between 300 and 7776000',
    );
  }

  const configuredLogLevel = env.CRAFTINGTABLE_LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.has(configuredLogLevel as ServerConfig['logLevel'])) {
    throw new Error(`Invalid CRAFTINGTABLE_LOG_LEVEL "${configuredLogLevel}"`);
  }

  const dataDir = dataDirectory(env);
  return {
    host,
    port,
    dataDir,
    databasePath: join(dataDir, 'state', 'craftingtable.sqlite'),
    publicOrigin,
    secureCookies: publicOriginUrl.protocol === 'https:',
    sessionLifetimeSeconds,
    logLevel: configuredLogLevel as ServerConfig['logLevel'],
  };
}
