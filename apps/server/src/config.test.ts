import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';

describe('configFromEnv', () => {
  it('defaults to loopback on port 4600', () => {
    expect(configFromEnv({})).toEqual({ host: '127.0.0.1', port: 4600 });
  });

  it('accepts explicit loopback hosts and a port override', () => {
    expect(configFromEnv({ CRAFTINGTABLE_HOST: 'localhost', CRAFTINGTABLE_PORT: '5000' })).toEqual({
      host: 'localhost',
      port: 5000,
    });
    expect(configFromEnv({ CRAFTINGTABLE_HOST: '::1' }).host).toBe('::1');
  });

  it('rejects non-loopback hosts (CT01-R1)', () => {
    expect(() => configFromEnv({ CRAFTINGTABLE_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => configFromEnv({ CRAFTINGTABLE_HOST: '::' })).toThrow(/loopback/);
    expect(() => configFromEnv({ CRAFTINGTABLE_HOST: '192.168.1.20' })).toThrow(/loopback/);
    expect(() => configFromEnv({ CRAFTINGTABLE_HOST: 'craftingtable.lan' })).toThrow(/loopback/);
  });

  it('rejects malformed ports', () => {
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: 'abc' })).toThrow(/CRAFTINGTABLE_PORT/);
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: '0' })).toThrow(/CRAFTINGTABLE_PORT/);
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: '70000' })).toThrow(/CRAFTINGTABLE_PORT/);
    expect(() => configFromEnv({ CRAFTINGTABLE_PORT: '80.5' })).toThrow(/CRAFTINGTABLE_PORT/);
  });
});
