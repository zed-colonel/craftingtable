import fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { RequestGate } from '../src/server.js';

/**
 * R-B9 review L-5: once the daemon's stop has drained, Fastify's close ends every connection
 * while handlers run on, and the database closes after it. The gate refuses new requests and
 * lets the requests that change state finish first, up to a bound.
 */

const apps: ReturnType<typeof fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function gated() {
  const app = fastify();
  apps.push(app);
  const gate = new RequestGate();
  gate.install(app);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.post('/write', async () => {
    await held;
    return { ok: true };
  });
  app.get('/read', async () => ({ ok: true }));
  await app.ready();
  return { app, gate, release };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('refuses new requests once closed, and waits for a running write to finish', async () => {
  const { app, gate, release } = await gated();
  expect((await app.inject({ method: 'GET', url: '/read' })).statusCode).toBe(200);
  const writing = app.inject({ method: 'POST', url: '/write' });
  await tick(20);

  let closed = false;
  const closing = gate.close(5_000).then(() => {
    closed = true;
  });
  const refused = await app.inject({ method: 'GET', url: '/read' });
  expect(refused.statusCode).toBe(503);
  expect(refused.json()).toMatchObject({ error: { code: 'unavailable' } });
  expect((await app.inject({ method: 'POST', url: '/write' })).statusCode).toBe(503);
  await tick(50);
  expect(closed).toBe(false);

  release();
  expect((await writing).statusCode).toBe(200);
  await closing;
  expect(closed).toBe(true);
});

it('waits no longer than its bound, and not at all with nothing written', async () => {
  const { app, gate, release } = await gated();
  const writing = app.inject({ method: 'POST', url: '/write' });
  await tick(20);
  const startedAt = Date.now();
  await gate.close(200);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
  release();
  await writing;

  const idle = await gated();
  // A read in flight is not waited for: only requests that change state are.
  const reading = idle.app.inject({ method: 'GET', url: '/read' });
  const idleAt = Date.now();
  await idle.gate.close(5_000);
  expect(Date.now() - idleAt).toBeLessThan(1_000);
  await reading;
  idle.release();
});
