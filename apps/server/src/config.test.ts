import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';

describe('configFromEnv', () => {
  it('defaults to loopback, XDG storage, and a 30-day session', () => {
    const config = configFromEnv({ HOME: '/home/test', XDG_DATA_HOME: '/tmp/xdg' });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 4600,
      dataDir: '/tmp/xdg/craftingtable',
      databasePath: '/tmp/xdg/craftingtable/state/craftingtable.sqlite',
      publicOrigin: 'http://127.0.0.1:5173',
      secureCookies: false,
      sessionLifetimeSeconds: 2_592_000,
    });
  });

  it('accepts explicit loopback hosts, HTTPS origin, and an absolute test directory', () => {
    const config = configFromEnv({
      CRAFTINGTABLE_HOST: '::1',
      CRAFTINGTABLE_PORT: '5000',
      CRAFTINGTABLE_PUBLIC_ORIGIN: 'https://[::1]:5173',
      CRAFTINGTABLE_DATA_DIR: '/tmp/craftingtable-test',
    });
    expect(config.host).toBe('::1');
    expect(config.port).toBe(5000);
    expect(config.secureCookies).toBe(true);
  });

  it('rejects every non-loopback host and public origin (CT01-R1)', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'craftingtable.lan']) {
      expect(() => configFromEnv({ CRAFTINGTABLE_HOST: host })).toThrow(/loopback/);
    }
    for (const origin of ['http://192.168.1.20:5173', 'https://craftingtable.lan']) {
      expect(() => configFromEnv({ CRAFTINGTABLE_PUBLIC_ORIGIN: origin })).toThrow(/loopback/);
    }
  });

  it('rejects malformed ports, lifetimes, origins, and relative data directories', () => {
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: '0' })).toThrow(/PORT/);
    expect(() => configFromEnv({ CRAFTINGTABLE_SESSION_LIFETIME_SECONDS: '10' })).toThrow(
      /LIFETIME/,
    );
    expect(() => configFromEnv({ CRAFTINGTABLE_PUBLIC_ORIGIN: 'ftp://localhost' })).toThrow(
      /origin/,
    );
    expect(() => configFromEnv({ CRAFTINGTABLE_DATA_DIR: './state' })).toThrow(/absolute/);
  });
});
