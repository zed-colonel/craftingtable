import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedHost, headerHostname } from '../../src/routes/browser-security.js';
import { createTestContext, type TestContext } from '../test-support.js';

/**
 * Security headers and the Host check (R-G9, SEC-07): every answer, the API's and the app's,
 * carries the content security policy and its companions, and a request naming another host is
 * refused before any route runs.
 */

const contexts: TestContext[] = [];
const distDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
  for (const directory of distDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('browser security (R-G9, SEC-07)', () => {
  it('sends the security headers on API answers, errors and the app', async () => {
    const context = await createTestContext({ publicOrigin: 'https://studio.tailnet.ts.net' });
    contexts.push(context);
    for (const url of ['/api/health', '/api/workspaces']) {
      const response = await context.app.inject({ method: 'GET', url });
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['content-security-policy']).toContain("object-src 'none'");
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    }
  });

  it("refuses a request naming another host, and serves the public origin's host and loopback", async () => {
    const context = await createTestContext({ publicOrigin: 'https://studio.tailnet.ts.net' });
    contexts.push(context);
    const health = (host: string) =>
      context.app.inject({ method: 'GET', url: '/api/health', headers: { host } });
    // A page on another name that resolved it to this address (DNS rebinding).
    const rebound = await health('attacker.example:4600');
    expect(rebound.statusCode).toBe(421);
    expect(rebound.json().error.code).toBe('forbidden');
    const login = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: 'attacker.example', 'content-type': 'application/json' },
      payload: { username: 'x', password: 'y' },
    });
    expect(login.statusCode).toBe(421);
    for (const host of [
      'studio.tailnet.ts.net',
      'STUDIO.tailnet.ts.net:443',
      '127.0.0.1:4600',
      'localhost:5173',
      '[::1]:4600',
    ])
      expect((await health(host)).statusCode, host).toBe(200);
  });

  it('reads a Host header the way browsers send it', () => {
    expect(headerHostname('Example.TEST:8080')).toBe('example.test');
    expect(headerHostname('[::1]:4600')).toBe('[::1]');
    expect(headerHostname(':4600')).toBeUndefined();
    expect(headerHostname(undefined)).toBeUndefined();
    const config = { publicOrigin: 'https://studio.tailnet.ts.net', host: '127.0.0.1' } as never;
    expect(allowedHost(undefined, config)).toBe(false);
    expect(allowedHost('studio.tailnet.ts.net.evil.example', config)).toBe(false);
    // The address the daemon listens on is its own name too (the deploy's health check).
    const bound = { publicOrigin: 'https://studio.tailnet.ts.net', host: '192.168.1.20' } as never;
    expect(allowedHost('192.168.1.20:4600', bound)).toBe(true);
    expect(allowedHost('192.168.1.21:4600', bound)).toBe(false);
    // A wildcard listen address names no host.
    expect(allowedHost('0.0.0.0:4600', { ...(bound as object), host: '0.0.0.0' } as never)).toBe(
      false,
    );
  });

  it('sends the policy with the built app', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'craftingtable-csp-dist-'));
    distDirectories.push(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CraftingTable</title>');
    const context = await createTestContext({ env: { CRAFTINGTABLE_WEB_DIST: dist } });
    contexts.push(context);
    const page = await context.app.inject({ method: 'GET', url: '/workspaces/abc' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('CraftingTable');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
  });
});
