export interface ServerConfig {
  host: string;
  port: number;
}

export const SERVER_VERSION = '0.1.0';

/** Loopback-only by default; LAN exposure is a CT-08 concern (ADR-006, deferred). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.CRAFTINGTABLE_HOST ?? '127.0.0.1',
    port: Number(env.CRAFTINGTABLE_PORT ?? 4600),
  };
}
