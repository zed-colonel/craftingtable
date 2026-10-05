import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelSpelling } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { CodexBackend } from '../../src/codex/backend.js';
import { CODEX_MODELS } from '../../src/codex/models.js';
import { testTimeScale } from '../test-time.js';

/** The fixture's `model/list` answer (fixtures/model-catalogs, R-G15). */
const FIXTURE = new URL(
  '../../../../fixtures/model-catalogs/codex-model-list.json',
  import.meta.url,
);

/**
 * A stand-in for `codex app-server` that answers only what model discovery asks. It records
 * its arguments, working directory and requests; `FAKE_MODE` picks a misbehaviour.
 */
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.FAKE_MODE || '';
const catalog = JSON.parse(fs.readFileSync(process.env.FAKE_CATALOG, 'utf8'));
const trace = value => fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify(value) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
trace({args: process.argv.slice(2), cwd: process.cwd()});
let initialized = false;
readline.createInterface({input: process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  trace(msg);
  const reply = result => emit({id: msg.id, result});
  if (msg.method === 'initialize') return reply({userAgent: 'fake'});
  if (msg.method === 'initialized') { initialized = true; return; }
  if (!initialized) process.exit(3);
  if (msg.method !== 'model/list') return emit({id: msg.id, error: {code: -32601, message: 'Unknown request'}});
  if (mode === 'silent') return;
  if (mode === 'unknown-method') return emit({id: msg.id, error: {code: -32601, message: 'method not found'}});
  if (mode === 'bad-shape') return reply({data: [{...catalog.data[0], displayName: 42}]});
  if (mode === 'paged') {
    const page = msg.params.cursor === 'page-2' ? 1 : 0;
    return reply({data: catalog.data.slice(page * 2, page * 2 + 2), nextCursor: page === 0 ? 'page-2' : null});
  }
  if (mode === 'empty') return reply({data: [], nextCursor: null});
  reply(catalog);
});
`;

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeCodex(mode = '', catalog = FIXTURE.pathname) {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-codex-catalog-'));
  directories.push(root);
  const executable = join(root, 'codex');
  writeFileSync(executable, FAKE);
  chmodSync(executable, 0o755);
  const trace = join(root, 'trace.jsonl');
  const backend = new CodexBackend({
    executable,
    env: {
      PATH: process.env.PATH ?? '',
      FAKE_MODE: mode,
      FAKE_CATALOG: catalog,
      FAKE_TRACE: trace,
    },
    allowEnvironment: ['FAKE_MODE', 'FAKE_CATALOG', 'FAKE_TRACE'],
    catalogDirectory: root,
    // Only a fake that never answers waits this out; the others answer at once, at any load.
    requestTimeoutMs: mode === 'silent' ? 500 : 30_000 * testTimeScale(),
  });
  const traced = () =>
    readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { backend, root, traced };
}

it("offers Codex's own catalog, hidden models flagged, once it is read (R-G15)", async () => {
  const { backend, root, traced } = fakeCodex();
  // Until the catalog is read, the release's own list.
  expect(backend.describe().models).toEqual(CODEX_MODELS);
  expect(backend.describe().catalog).toEqual({ source: 'fallback' });
  const snapshot = await backend.listModels();
  expect(snapshot.status.source).toBe('catalog');
  expect(snapshot.status.issue).toBeUndefined();
  expect(backend.describe().models).toEqual([
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', section: 'main', hidden: false },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', section: 'main', hidden: false },
    { id: 'gpt-5.5', label: 'GPT-5.5', section: 'main', hidden: true },
  ]);
  // LIVE-34: the display name is recognised as gpt-6.1-sol's.
  expect(modelSpelling(backend.describe().models, 'GPT-6.1-Sol')).toEqual({
    kind: 'misnamed',
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
  });
  const [started, ...requests] = traced();
  // An isolated, short-lived app-server, run where no project's configuration applies.
  expect(started?.args).toEqual(expect.arrayContaining(['app-server', '--disable', 'plugins']));
  expect(started?.cwd).toBe(root);
  expect(requests.find((request) => request.method === 'model/list')?.params).toEqual({
    includeHidden: true,
    limit: 100,
  });
});

it('reads every page of the catalog (R-G15)', async () => {
  const { backend } = fakeCodex('paged');
  await backend.listModels();
  expect(backend.describe().models.map((model) => model.id)).toEqual([
    'gpt-6.1-sol',
    'gpt-6-luna',
    'gpt-5.5',
  ]);
});

it('picks up a model added to the catalog at the next refresh, with no other change (R-G15)', async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: object[] };
  const { root } = fakeCodex();
  const path = join(root, 'catalog.json');
  writeFileSync(path, JSON.stringify(fixture));
  const live = fakeCodex('', path).backend;
  await live.listModels();
  expect(live.describe().models.some((model) => model.id === 'gpt-7-preview')).toBe(false);
  const added = {
    id: 'gpt-7-preview',
    model: 'gpt-7-preview',
    displayName: 'GPT-7-Preview',
    description: 'New',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [],
  };
  writeFileSync(path, JSON.stringify({ ...fixture, data: [...fixture.data, added] }));
  await live.listModels();
  expect(live.describe().models.find((model) => model.id === 'gpt-7-preview')).toEqual({
    id: 'gpt-7-preview',
    label: 'GPT-7-Preview',
    section: 'main',
    hidden: false,
  });
});

it.each([
  ['bad-shape', 'catalog-format-unsupported'],
  ['unknown-method', 'catalog-request-failed'],
  ['silent', 'catalog-request-failed'],
  ['empty', 'catalog-empty'],
] as const)('keeps the list in use when the catalog answer is %s (R-G15)', async (mode, issue) => {
  const { backend } = fakeCodex(mode);
  const snapshot = await backend.listModels();
  expect(snapshot.status).toMatchObject({ source: 'fallback', issue });
  expect(snapshot.status.checkedAt).toBeDefined();
  expect(backend.describe().models).toEqual(CODEX_MODELS);
});

it("never asks Codex when the operator's own list replaces the catalog (R-G15)", async () => {
  const own = [{ id: 'custom', label: 'Custom', section: 'main', hidden: false }];
  const { root } = fakeCodex();
  const backend = new CodexBackend({ executable: join(root, 'missing'), models: own });
  const snapshot = await backend.listModels();
  expect(snapshot.status).toEqual({ source: 'environment' });
  expect(backend.describe().models).toEqual(own);
});

it('refuses a catalog whose display name the execution status could not carry (R-G15)', async () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: Record<string, unknown>[] };
  const { root } = fakeCodex();
  const path = join(root, 'catalog.json');
  // 60 code points, 120 UTF-16 code units: over the contract's 100.
  const wide = { ...fixture.data[0], displayName: '😀'.repeat(60) };
  writeFileSync(path, JSON.stringify({ ...fixture, data: [wide] }));
  const snapshot = await fakeCodex('', path).backend.listModels();
  expect(snapshot.status).toMatchObject({
    source: 'fallback',
    issue: 'catalog-format-unsupported',
  });
});
