import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fastify } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStaticWebRoutes } from './static-web.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function distFixture(): string {
  const dist = mkdtempSync(join(tmpdir(), 'craftingtable-dist-'));
  directories.push(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CraftingTable</title>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  writeFileSync(join(dist, 'secret.pem'), 'not served');
  writeFileSync(join(tmpdir(), 'craftingtable-outside.txt'), 'outside');
  return dist;
}

describe('static web routes', () => {
  it('serves assets, falls back to index for deep links, and never leaves dist', async () => {
    const dist = distFixture();
    const app = fastify({ logger: false });
    registerStaticWebRoutes(app, dist);
    app.get('/api/health', async () => ({ ok: true }));
    try {
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.headers['content-type']).toContain('text/html');
      expect(index.body).toContain('CraftingTable');

      const deep = await app.inject({ method: 'GET', url: '/workspaces/abc/work-items/def' });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('CraftingTable');

      const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect(asset.body).toBe('console.log(1);');

      const unknownType = await app.inject({ method: 'GET', url: '/secret.pem' });
      expect(unknownType.statusCode).toBe(404);

      const traversal = await app.inject({
        method: 'GET',
        url: '/assets/..%2F..%2Fcraftingtable-outside.txt',
      });
      expect(traversal.body).not.toContain('outside');

      const api = await app.inject({ method: 'GET', url: '/api/health' });
      expect(api.json()).toEqual({ ok: true });
      const missingApi = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(missingApi.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
