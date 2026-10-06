import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fastify } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStaticWebRoutes } from '../../src/routes/static-web.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A built web app in a directory of its own, beside a file a traversal would reach (ARCH F8a). */
function distFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-static-web-'));
  directories.push(root);
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CraftingTable</title>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  writeFileSync(join(dist, 'secret.pem'), 'not served');
  writeFileSync(join(root, 'craftingtable-outside.txt'), 'outside');
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

  it('gzips a large text asset for a client that accepts it, and reads the file again when it changes (R-D5)', async () => {
    const dist = distFixture();
    const bundle = join(dist, 'assets', 'bundle-def456.js');
    const code = `export const chunk = ${JSON.stringify('x'.repeat(20_000))};`;
    writeFileSync(bundle, code);
    writeFileSync(join(dist, 'assets', 'icon.png'), Buffer.alloc(20_000, 1));
    const app = fastify({ logger: false });
    registerStaticWebRoutes(app, dist);
    try {
      const zipped = await app.inject({
        method: 'GET',
        url: '/assets/bundle-def456.js',
        headers: { 'accept-encoding': 'gzip, br' },
      });
      expect(zipped.statusCode).toBe(200);
      expect(zipped.headers['content-encoding']).toBe('gzip');
      expect(zipped.headers.vary).toContain('accept-encoding');
      expect(zipped.headers['content-type']).toContain('text/javascript');
      expect(zipped.headers['cache-control']).toContain('immutable');
      expect(gunzipSync(zipped.rawPayload).toString('utf8')).toBe(code);
      expect(zipped.rawPayload.length).toBeLessThan(code.length / 10);
      // Without gzip, the file as it is.
      const plain = await app.inject({ method: 'GET', url: '/assets/bundle-def456.js' });
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.body).toBe(code);
      // A small file, or one that is not text, goes as it is.
      const small = await app.inject({
        method: 'GET',
        url: '/assets/app-abc123.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(small.headers['content-encoding']).toBeUndefined();
      const image = await app.inject({
        method: 'GET',
        url: '/assets/icon.png',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(image.headers['content-encoding']).toBeUndefined();
      // A rebuilt file is compressed again, not served from what was compressed before.
      const rebuilt = `export const chunk = ${JSON.stringify('y'.repeat(30_000))};`;
      writeFileSync(bundle, rebuilt);
      const later = new Date(Date.now() + 5_000);
      utimesSync(bundle, later, later);
      const again = await app.inject({
        method: 'GET',
        url: '/assets/bundle-def456.js',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(gunzipSync(again.rawPayload).toString('utf8')).toBe(rebuilt);
    } finally {
      await app.close();
    }
  });

  it("answers 404 for a built file that does not exist, so an old page's missing chunk fails as one (R-D5 review)", async () => {
    const dist = distFixture();
    const app = fastify({ logger: false });
    registerStaticWebRoutes(app, dist);
    try {
      const missing = await app.inject({ method: 'GET', url: '/assets/RunRoute-oldhash.js' });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).not.toContain('CraftingTable');
      // A deep link still gets the app.
      const deep = await app.inject({ method: 'GET', url: '/workspaces/abc/runs/def' });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('CraftingTable');
    } finally {
      await app.close();
    }
  });
});
