import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelSpelling } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { ClaudeCodeBackend } from '../../src/claude-code/backend.js';
import { claudeConfigDirectory, readClaudeModelCatalog } from '../../src/claude-code/catalog.js';
import { CLAUDE_CODE_ALIASES, CLAUDE_CODE_MODELS } from '../../src/claude-code/models.js';
import { ModelCatalog, ModelCatalogError } from '../../src/model-catalog.js';
import { testTimeScale } from '../test-time.js';

/** Claude Code's version-2 catalog, hand-written in its shape (fixtures/model-catalogs, R-G15). */
const FIXTURE = new URL('../../../../fixtures/model-catalogs/claude-cc-v2.json', import.meta.url);

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A configuration directory holding `catalogs` (file name → JSON text), and nothing else. */
function configDirectory(catalogs: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-config-'));
  directories.push(root);
  if (Object.keys(catalogs).length > 0) {
    mkdirSync(join(root, 'cache', 'model-catalog'), { recursive: true });
    for (const [name, text] of Object.entries(catalogs))
      writeFileSync(join(root, 'cache', 'model-catalog', name), text);
  }
  return root;
}

const fixture = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const text = (value: unknown) => JSON.stringify(value);
function firstEntry(value: Record<string, unknown>): Record<string, unknown> {
  const entry = (value.catalog as { config: { models: Record<string, unknown>[] } }).config
    .models[0];
  if (entry === undefined) throw new Error('The fixture lists no model');
  return entry;
}

/** A `claude` that only prints its version, as the real one does for `--version`. */
function fakeClaude(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-bin-'));
  directories.push(root);
  const executable = join(root, 'claude');
  writeFileSync(
    executable,
    `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(9);\nprocess.stdout.write(${JSON.stringify(version)} + '\\n');\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

it('offers the aliases, then the catalog, leaving out entries newer than the CLI (R-G15)', async () => {
  const config = configDirectory({ 'account-org-cc.json': readFileSync(FIXTURE, 'utf8') });
  const found = await readClaudeModelCatalog(config, '2.1.288');
  expect(found.issue).toBeUndefined();
  expect(found.models).toEqual([
    ...CLAUDE_CODE_ALIASES,
    { id: 'claude-opus-5-5', label: 'Opus 5.5', section: 'main', hidden: false },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', section: 'main', hidden: false },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', section: 'main', hidden: false },
    { id: 'claude-opus-5', label: 'Opus 5', section: 'overflow', hidden: false },
  ]);
  // A CLI older than an entry's minimum does not get it: Opus 5.5 needs 2.1.280.
  const older = await readClaudeModelCatalog(config, '2.1.279');
  expect(older.models.map((model) => model.id)).not.toContain('claude-opus-5-5');
  expect((await readClaudeModelCatalog(config, '2.10.0')).models.map((m) => m.id)).toContain(
    'claude-opus-5-5',
  );
});

it('leaves out every entry that names a minimum when the CLI version is unknown (R-G15)', async () => {
  const config = configDirectory({ 'a-cc.json': readFileSync(FIXTURE, 'utf8') });
  const found = await readClaudeModelCatalog(config, undefined);
  expect(found.issue).toBe('cli-version-unknown');
  expect(found.models.map((model) => model.id)).toEqual([
    'opus',
    'sonnet',
    'haiku',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-5',
  ]);
});

it('reads the most recently fetched valid catalog of several (R-G15)', async () => {
  const older = fixture();
  const newer = fixture();
  newer.fetchedAt = (older.fetchedAt as number) + 1;
  (newer.catalog as { config: { models: unknown[] } }).config.models = [
    { id: 'claude-only-newer', name: 'Only Newer', section: 'main' },
  ];
  const config = configDirectory({
    'a-cc.json': text(older),
    'b-cc.json': '{not json',
    'c-cc.json': text(newer),
    'd-cc.json': text(older),
    'notes.json': text(older),
  });
  const found = await readClaudeModelCatalog(config, '2.1.288');
  expect(found.models.map((model) => model.id)).toEqual([
    'opus',
    'sonnet',
    'haiku',
    'claude-only-newer',
  ]);
});

it.each([
  ['a later format version', (value: Record<string, unknown>) => ({ ...value, version: 3 })],
  [
    'a model name with a control character',
    (value: Record<string, unknown>) => {
      firstEntry(value).name = 'Opus\u00075.5';
      return value;
    },
  ],
  [
    'a model with no id',
    (value: Record<string, unknown>) => {
      firstEntry(value).id = '';
      return value;
    },
  ],
  [
    'an unknown section spelling',
    (value: Record<string, unknown>) => {
      firstEntry(value).section = 'Main Section';
      return value;
    },
  ],
  [
    'a malformed minimum version',
    (value: Record<string, unknown>) => {
      firstEntry(value).min_claude_code_version = 'latest';
      return value;
    },
  ],
  ['no model list', (value: Record<string, unknown>) => ({ ...value, catalog: {} })],
])('refuses a whole catalog with %s (R-G15)', async (_case, change) => {
  const config = configDirectory({ 'a-cc.json': text(change(fixture())) });
  await expect(readClaudeModelCatalog(config, '2.1.288')).rejects.toMatchObject({
    issue: 'catalog-format-unsupported',
  });
});

it('reports a missing, unreadable or empty catalog by code (R-G15)', async () => {
  await expect(readClaudeModelCatalog(configDirectory(), '2.1.288')).rejects.toMatchObject({
    issue: 'catalog-missing',
  });
  await expect(
    readClaudeModelCatalog(configDirectory({ 'a-cc.json': '{' }), '2.1.288'),
  ).rejects.toMatchObject({ issue: 'catalog-unreadable' });
  // A link is not followed: the catalog is a file the CLI wrote.
  const linked = configDirectory({ 'real.json': readFileSync(FIXTURE, 'utf8') });
  symlinkSync(
    join(linked, 'cache', 'model-catalog', 'real.json'),
    join(linked, 'cache', 'model-catalog', 'a-cc.json'),
  );
  await expect(readClaudeModelCatalog(linked, '2.1.288')).rejects.toMatchObject({
    issue: 'catalog-unreadable',
  });
  const empty = fixture();
  (empty.catalog as { config: { models: unknown[] } }).config.models = [];
  await expect(
    readClaudeModelCatalog(configDirectory({ 'a-cc.json': text(empty) }), '2.1.288'),
  ).rejects.toMatchObject({ issue: 'catalog-empty' });
});

it("reads the account's CLAUDE_CONFIG_DIR, else ~/.claude under the daemon's HOME (R-G15)", () => {
  expect(claudeConfigDirectory({ CLAUDE_CONFIG_DIR: '/accounts/work', HOME: '/home/a' })).toBe(
    '/accounts/work',
  );
  expect(claudeConfigDirectory({ CLAUDE_CONFIG_DIR: 'relative', HOME: '/home/a' })).toBe(
    '/home/a/.claude',
  );
  expect(claudeConfigDirectory({ HOME: '/home/a' })).toBe('/home/a/.claude');
});

it("refreshes the backend's list from the account's catalog, and keeps it when a look fails (R-G15)", async () => {
  const config = configDirectory({ 'a-cc.json': readFileSync(FIXTURE, 'utf8') });
  const backend = new ClaudeCodeBackend({
    executable: fakeClaude('2.1.288 (Claude Code)'),
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', CLAUDE_CONFIG_DIR: config },
    catalogTimeoutMs: 30_000 * testTimeScale(),
  });
  expect(backend.describe()).toMatchObject({
    models: CLAUDE_CODE_MODELS,
    catalog: { source: 'fallback' },
  });
  const first = await backend.listModels();
  expect(first.status).toMatchObject({ source: 'catalog' });
  expect(backend.describe().models.map((model) => model.id)).toContain('claude-opus-5-5');
  // A model added to the catalog is offered at the next refresh, with no other change.
  const added = fixture();
  (added.catalog as { config: { models: unknown[] } }).config.models.push({
    id: 'claude-opus-6',
    name: 'Opus 6',
    section: 'main',
  });
  writeFileSync(join(config, 'cache', 'model-catalog', 'a-cc.json'), text(added));
  const second = await backend.listModels();
  expect(modelSpelling(backend.describe().models, 'Opus 6')).toEqual({
    kind: 'misnamed',
    id: 'claude-opus-6',
    label: 'Opus 6',
  });
  // A catalog that turns unreadable leaves the last one in use, saying why.
  writeFileSync(join(config, 'cache', 'model-catalog', 'a-cc.json'), '{');
  const failed = await backend.listModels();
  expect(failed.status).toMatchObject({
    source: 'catalog',
    listedAt: second.status.listedAt,
    issue: 'catalog-unreadable',
  });
  expect(backend.describe().models.map((model) => model.id)).toContain('claude-opus-6');
});

it("keeps the operator's list and never reads a catalog when it replaces it (R-G15)", async () => {
  const own = [{ id: 'mine', label: 'Mine', section: 'main', hidden: false }];
  const backend = new ClaudeCodeBackend({ executable: '/nonexistent/claude', models: own });
  expect(await backend.listModels()).toEqual({ models: own, status: { source: 'environment' } });
});

it('shares one look among concurrent refreshes, and starts a new one after (R-G15)', async () => {
  let looks = 0;
  let release: (() => void) | undefined;
  const catalog = new ModelCatalog(
    () =>
      new Promise((resolve) => {
        looks++;
        release = () =>
          resolve({ models: [{ id: 'm', label: 'M', section: 'main', hidden: false }] });
      }),
    [],
  );
  const both = Promise.all([catalog.refresh(), catalog.refresh()]);
  release?.();
  await both;
  expect(looks).toBe(1);
  await expect(
    new ModelCatalog(() => Promise.reject(new ModelCatalogError('catalog-missing', 'none')), [])
      .refresh()
      .then((snapshot) => snapshot.status.issue),
  ).resolves.toBe('catalog-missing');
  const next = catalog.refresh();
  release?.();
  await next;
  expect(looks).toBe(2);
});

it.each([
  ['missing', (): string => '/nonexistent/claude'],
  [
    'hung',
    (): string => {
      const root = mkdtempSync(join(tmpdir(), 'craftingtable-claude-bin-'));
      directories.push(root);
      const executable = join(root, 'claude');
      writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
      chmodSync(executable, 0o755);
      return executable;
    },
  ],
] as const)(
  'reads the catalog without a version when the CLI is %s (R-G15)',
  async (_case, cli) => {
    const config = configDirectory({ 'a-cc.json': readFileSync(FIXTURE, 'utf8') });
    const backend = new ClaudeCodeBackend({
      executable: cli(),
      env: { PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: config },
      catalogTimeoutMs: 300,
    });
    const snapshot = await backend.listModels();
    expect(snapshot.status).toMatchObject({ source: 'catalog', issue: 'cli-version-unknown' });
    expect(snapshot.models.map((model) => model.id)).not.toContain('claude-opus-5-5');
    expect(snapshot.models.map((model) => model.id)).toContain('claude-sonnet-5-5');
  },
);

it('leaves out an entry whose id cannot be sent, keeping the rest of the catalog (R-G15)', async () => {
  const value = fixture();
  firstEntry(value).id = 'claude-opus-5-5[1m]';
  const found = await readClaudeModelCatalog(
    configDirectory({ 'a-cc.json': text(value) }),
    '2.1.288',
  );
  expect(found.models.map((model) => model.id)).toEqual([
    'opus',
    'sonnet',
    'haiku',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-5',
  ]);
});

it('refuses a catalog file over 1 MiB (R-G15)', async () => {
  const value = fixture();
  value.padding = 'x'.repeat(1024 * 1024);
  await expect(
    readClaudeModelCatalog(configDirectory({ 'a-cc.json': text(value) }), '2.1.288'),
  ).rejects.toMatchObject({ issue: 'catalog-unreadable' });
});

it("cuts an operator's list to what the execution status carries (R-G15)", () => {
  const own = Array.from({ length: 101 }, (_, index) => ({
    id: `model-${index}`,
    label: `Model ${index}`,
    section: 'main',
    hidden: false,
  }));
  const backend = new ClaudeCodeBackend({ executable: '/nonexistent/claude', models: own });
  expect(backend.describe().models).toHaveLength(100);
});
