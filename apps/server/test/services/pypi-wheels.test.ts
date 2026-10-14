import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PypiWheelStore } from '../../src/services/pypi-wheels.js';

/**
 * R-G17 decision 8: the daemon downloads the wheels checks use, from PyPI's JSON API and
 * files.pythonhosted.org only, redirects refused, with a per-file size cap, a rate window and a
 * store budget; it keeps a file by SHA-256 only when its bytes match both PyPI's digest and the
 * lock's hash.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-wheels-'));
  roots.push(directory);
  return directory;
}
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const never = new AbortController().signal;

const WHEEL = Buffer.from('a genuine wheel');
const FILE = 'markupsafe-3.0.4-cp312-cp312-manylinux_2_17_x86_64.whl';
const FILE_URL = `https://files.pythonhosted.org/packages/ab/cd/${FILE}`;
const request = { name: 'markupsafe', version: '3.0.4', filename: FILE, sha256: sha256(WHEEL) };

/** A PyPI that answers the JSON API and its files host, and records what it was asked. */
function pypi(
  overrides: {
    readonly digest?: string;
    readonly url?: string;
    readonly size?: number;
    readonly body?: Buffer | ReadableStream<Uint8Array>;
    readonly packagetype?: string;
  } = {},
) {
  const asked: { url: string; redirect: RequestInit['redirect'] }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, redirect: init.redirect });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (url === 'https://pypi.org/pypi/markupsafe/3.0.4/json')
      return Response.json({
        info: { name: 'MarkupSafe' },
        urls: [
          {
            filename: 'markupsafe-3.0.4.tar.gz',
            packagetype: 'sdist',
            url: 'https://files.pythonhosted.org/packages/x/markupsafe-3.0.4.tar.gz',
            digests: { sha256: 'f'.repeat(64) },
            size: 10,
          },
          {
            filename: FILE,
            packagetype: overrides.packagetype ?? 'bdist_wheel',
            url: overrides.url ?? FILE_URL,
            digests: { sha256: overrides.digest ?? sha256(WHEEL) },
            size: overrides.size ?? WHEEL.length,
          },
        ],
      });
    if (url === (overrides.url ?? FILE_URL)) {
      const body = overrides.body ?? WHEEL;
      return new Response(body instanceof Buffer ? new Uint8Array(body) : body);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, asked };
}

it('keeps a wheel by its SHA-256 when its bytes match PyPI’s digest and the lock’s hash, and serves it again without asking', async () => {
  const at = root();
  const server = pypi();
  const store = new PypiWheelStore(at, { fetch: server.fetch });
  const first = await store.wheel(request, never);
  expect(first).toEqual({ path: join(at, 'files', request.sha256, FILE) });
  expect(readFileSync((first as { path: string }).path)).toEqual(WHEEL);
  // Only PyPI's JSON API and its files host, redirects refused.
  expect(server.asked).toEqual([
    { url: 'https://pypi.org/pypi/markupsafe/3.0.4/json', redirect: 'error' },
    { url: FILE_URL, redirect: 'error' },
  ]);
  expect(await store.wheel(request, never)).toEqual(first);
  expect(server.asked).toHaveLength(2);
});

it("refuses a wheel whose PyPI digest is not the lock's hash, and stores nothing", async () => {
  const at = root();
  const server = pypi({ digest: 'e'.repeat(64) });
  const result = await new PypiWheelStore(at, { fetch: server.fetch }).wheel(request, never);
  expect(result).toEqual({ problem: expect.stringContaining("PyPI's digest") });
  // The file was never downloaded.
  expect(server.asked.map((a) => a.url)).toEqual(['https://pypi.org/pypi/markupsafe/3.0.4/json']);
  expect(existsSync(join(at, 'files', request.sha256))).toBe(false);
});

it('refuses bytes that do not match the digest, and leaves no partial file', async () => {
  const at = root();
  const result = await new PypiWheelStore(at, {
    fetch: pypi({ body: Buffer.from('a planted wheel'), size: 'a planted wheel'.length }).fetch,
  }).wheel(request, never);
  expect(result).toEqual({ problem: expect.stringContaining('do not match') });
  expect(existsSync(join(at, 'files', request.sha256))).toBe(false);
  expect(readdirSync(join(at, 'tmp'))).toEqual([]);
});

it('fetches only from files.pythonhosted.org over HTTPS, and only a wheel', async () => {
  for (const [overrides, problem] of [
    [{ url: `https://example.org/${FILE}` }, /files\.pythonhosted\.org/],
    [{ url: `http://files.pythonhosted.org/packages/ab/cd/${FILE}` }, /files\.pythonhosted\.org/],
    [{ url: `https://files.pythonhosted.org.example.org/${FILE}` }, /files\.pythonhosted\.org/],
    [{ packagetype: 'sdist' }, /not on PyPI/],
  ] as const) {
    const server = pypi(overrides);
    const result = await new PypiWheelStore(root(), { fetch: server.fetch }).wheel(request, never);
    expect(result, JSON.stringify(overrides)).toEqual({ problem: expect.stringMatching(problem) });
    expect(server.asked).toHaveLength(1);
  }
});

it('refuses a file over the size cap, declared or as it arrives', async () => {
  const declared = pypi({ size: 2048 });
  expect(
    await new PypiWheelStore(root(), { fetch: declared.fetch, maxFileBytes: 1024 }).wheel(
      request,
      never,
    ),
  ).toEqual({ problem: expect.stringContaining('larger than') });
  expect(declared.asked).toHaveLength(1);
  // PyPI says it is small, the stream says otherwise.
  const at = root();
  const big = Buffer.alloc(4096, 1);
  const streamed = await new PypiWheelStore(at, {
    fetch: pypi({ body: big, size: 16, digest: sha256(big) }).fetch,
    maxFileBytes: 1024,
  }).wheel({ ...request, sha256: sha256(big) }, never);
  expect(streamed).toEqual({ problem: expect.stringContaining('more bytes') });
  expect(readdirSync(join(at, 'tmp'))).toEqual([]);
});

it('ends within seconds when the check is cancelled during a download', async () => {
  const at = root();
  const endless = new ReadableStream<Uint8Array>({
    pull: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = new PypiWheelStore(at, { fetch: pypi({ body: endless }).fetch }).wheel(
    request,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 200);
  expect(await pending).toEqual({ problem: expect.stringContaining('cancelled') });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(readdirSync(join(at, 'tmp'))).toEqual([]);
});

it('asks PyPI at most so many times per window, whatever locks name', async () => {
  const server = pypi({ digest: 'e'.repeat(64) });
  let now = 1_000_000;
  const store = new PypiWheelStore(root(), {
    fetch: server.fetch,
    requestsPerWindow: 2,
    windowMs: 60_000,
    now: () => now,
  });
  await store.wheel(request, never);
  await store.wheel(
    { ...request, version: '3.0.5', filename: FILE.replace('3.0.4', '3.0.5') },
    never,
  );
  const limited = await store.wheel(
    { ...request, version: '3.0.6', filename: FILE.replace('3.0.4', '3.0.6') },
    never,
  );
  expect(limited).toEqual({ problem: expect.stringContaining('rate') });
  expect(server.asked).toHaveLength(2);
  now += 60_000;
  await store.wheel(request, never);
  expect(server.asked).toHaveLength(3);
});

it('keeps the store within its budget, removing the least recently used wheels first', async () => {
  const at = root();
  // Two earlier wheels of 100 bytes, the older one used longest ago.
  for (const [name, age] of [
    ['old', 3_000],
    ['recent', 1_000],
  ] as const) {
    const directory = join(at, 'files', sha256(name));
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${name}-1.0-py3-none-any.whl`);
    writeFileSync(file, Buffer.alloc(100));
    const seconds = (Date.now() - age * 1000) / 1000;
    utimesSync(file, seconds, seconds);
  }
  const store = new PypiWheelStore(at, { fetch: pypi().fetch, budgetBytes: 150 });
  expect(await store.wheel(request, never)).toEqual({ path: expect.any(String) });
  expect(existsSync(join(at, 'files', sha256('old')))).toBe(false);
  expect(existsSync(join(at, 'files', sha256('recent')))).toBe(true);
  expect(statSync(join(at, 'files', request.sha256, FILE)).size).toBe(WHEEL.length);
});

it('refuses a request that is not a wheel of PyPI, before asking anything', async () => {
  const server = pypi();
  const store = new PypiWheelStore(root(), { fetch: server.fetch });
  for (const bad of [
    { ...request, filename: '../escape-1.0-py3-none-any.whl' },
    { ...request, filename: 'markupsafe-3.0.4.tar.gz' },
    // A `.whl` name without a wheel's tags.
    { ...request, filename: 'markupsafe.whl' },
    { ...request, name: 'markupsafe/../x' },
    { ...request, version: '3.0.4/../../x' },
    { ...request, sha256: 'z'.repeat(64) },
  ])
    expect(await store.wheel(bad, never), JSON.stringify(bad)).toEqual({
      problem: expect.stringContaining('not a wheel'),
    });
  expect(server.asked).toEqual([]);
});

it.skipIf(process.env.CRAFTINGTABLE_REAL_PYPI !== '1')(
  'fetches and verifies a real wheel from PyPI (CRAFTINGTABLE_REAL_PYPI=1)',
  async () => {
    const real = {
      name: 'iniconfig',
      version: '2.3.1',
      filename: 'iniconfig-2.3.1-py3-none-any.whl',
      sha256: '9121e2c1fdb355232495be3194c8dfe87ccc2d5dee45947b78e68f499790d7a7',
    };
    const result = await new PypiWheelStore(root()).wheel(real, never);
    expect(result).toEqual({ path: expect.stringContaining(real.sha256) });
    expect(sha256(readFileSync((result as { path: string }).path))).toBe(real.sha256);
  },
);

it('serves only a regular file it stored: a link or a directory in its place is replaced by a verified fetch', async () => {
  for (const plant of ['link', 'directory'] as const) {
    const at = root();
    const directory = join(at, 'files', request.sha256);
    mkdirSync(directory, { recursive: true });
    const elsewhere = join(at, 'planted.whl');
    writeFileSync(elsewhere, 'planted');
    if (plant === 'link') symlinkSync(elsewhere, join(directory, FILE));
    else mkdirSync(join(directory, FILE));
    const server = pypi();
    const result = await new PypiWheelStore(at, { fetch: server.fetch }).wheel(request, never);
    expect(result, plant).toEqual({ path: join(directory, FILE) });
    expect(server.asked, plant).toHaveLength(2);
    expect(lstatSync(join(directory, FILE)).isFile(), plant).toBe(true);
    expect(readFileSync(join(directory, FILE)), plant).toEqual(WHEEL);
  }
});
