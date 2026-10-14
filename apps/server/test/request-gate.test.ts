import { once } from 'node:events';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { RequestGate } from '../src/server.js';

/**
 * R-B9 review L-5: once the daemon's stop has drained, Fastify's close ends every connection
 * while handlers run on, and the database closes after it. The gate refuses new requests that
 * change state and lets those already running finish first, up to a bound.
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
  app.get('/held-read', async () => {
    await held;
    return { ok: true };
  });
  await app.ready();
  return { app, gate, release };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('refuses new writes once closed, and waits for a running write to finish', async () => {
  const { app, gate, release } = await gated();
  expect((await app.inject({ method: 'GET', url: '/read' })).statusCode).toBe(200);
  const writing = app.inject({ method: 'POST', url: '/write' });
  await tick(20);

  let closed = false;
  const closing = gate.close(5_000).then(() => {
    closed = true;
  });
  const refused = await app.inject({ method: 'POST', url: '/write' });
  expect(refused.statusCode).toBe(503);
  expect(refused.json()).toMatchObject({ error: { code: 'unavailable' } });
  // Reads are still answered until the server closes: a browser's event stream refused with a
  // 503 would never reconnect (re-check R-L2).
  expect((await app.inject({ method: 'GET', url: '/read' })).statusCode).toBe(200);
  await tick(50);
  expect(closed).toBe(false);

  const releasedAt = Date.now();
  release();
  expect((await writing).statusCode).toBe(200);
  await closing;
  expect(closed).toBe(true);
  // Once the last write has answered, not at the bound.
  expect(Date.now() - releasedAt).toBeLessThan(1_000);
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
  // A read still running is not waited for: only requests that change state are.
  const reading = idle.app.inject({ method: 'GET', url: '/held-read' });
  await tick(20);
  const idleAt = Date.now();
  await idle.gate.close(5_000);
  expect(Date.now() - idleAt).toBeLessThan(1_000);
  idle.release();
  await reading;
});

it('lets go of a write whose client left after sending it, once its handler has answered (re-check R-L1)', async () => {
  const { app, gate, release } = await gated();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  // The whole request, then the client goes (a laptop asleep, a tab closed) before the answer.
  socket.write(
    'POST /write HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
  );
  await tick(100);
  socket.destroy();
  await tick(100);
  release();
  await tick(100);
  const closingAt = Date.now();
  await gate.close(5_000);
  expect(Date.now() - closingAt).toBeLessThan(1_000);
});

it('lets go of a write whose client left before sending all of it', async () => {
  const { app, gate } = await gated();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    'POST /write HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{"a"',
  );
  await tick(100);
  socket.destroy();
  await tick(100);
  const closingAt = Date.now();
  await gate.close(5_000);
  expect(Date.now() - closingAt).toBeLessThan(1_000);
});
