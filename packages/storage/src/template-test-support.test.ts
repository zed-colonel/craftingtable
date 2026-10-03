import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asUserId } from '@craftingtable/domain';
import { afterEach, expect, inject, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIRECTORY, discoverMigrations } from './migrations.js';
import {
  migratedTemplate,
  migrationLedger,
  publishOnce,
  readTemplate,
  templateLedger,
} from './template-test-support.js';
import { pidNamespace, sweepEndedRuns } from './template-test-support-setup.js';
import { temporaryStorage, testDataRoot } from './test-support.js';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(root: string): string {
  const directory = mkdtempSync(join(root, 'craftingtable-template-test-'));
  scratch.push(directory);
  return directory;
}

const tables = (path: string) =>
  readTemplate<{ name: string }>(path, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
    (row) => row.name,
  );
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

it("gives a test database a copy of the run's migrated template, which stays unchanged (TS-M13)", () => {
  const template = migratedTemplate(inject('testTemplateDirectory'));
  const before = digest(template);
  const fixture = temporaryStorage();
  try {
    // A fresh migration would stamp every row with the time it ran; the copy keeps the
    // template's stamps.
    expect(migrationLedger(fixture.databasePath)).toEqual(templateLedger(template));
    expect(templateLedger(template)).toHaveLength(discoverMigrations().length);
    expect(statSync(fixture.databasePath).ino).not.toBe(statSync(template).ino);
    fixture.storage.transaction((tx) =>
      tx.users.insert({
        id: asUserId('template-user'),
        username: 'template-user',
        usernameNormalized: 'template-user',
        passwordHash: '$argon2id$test',
        occurredAt: '2026-10-02T00:00:00.000Z',
      }),
    );
  } finally {
    fixture.cleanup();
  }
  expect(digest(template)).toBe(before);
});

it('builds a new template when a migration is added or edited, and reuses one for the same set (TS-M13)', () => {
  const directory = scratchDirectory(testDataRoot());
  const sql = scratchDirectory(tmpdir());
  cpSync(DEFAULT_MIGRATIONS_DIRECTORY, sql, { recursive: true });
  const current = discoverMigrations(sql);
  const first = migratedTemplate(directory, current);
  expect(migratedTemplate(directory, current)).toBe(first);

  const probe = join(sql, `${String(current.length + 1).padStart(4, '0')}-template-probe.sql`);
  writeFileSync(probe, 'CREATE TABLE template_probe (id INTEGER PRIMARY KEY) STRICT;\n');
  const added = migratedTemplate(directory, discoverMigrations(sql));
  expect(added).not.toBe(first);
  expect(tables(added)).toContain('template_probe');
  expect(tables(first)).not.toContain('template_probe');

  // The same versions and names, one checksum changed.
  writeFileSync(probe, `${readFileSync(probe, 'utf8')}-- edited\n`);
  const edited = discoverMigrations(sql);
  const rebuilt = migratedTemplate(directory, edited);
  expect(new Set([first, added, rebuilt]).size).toBe(3);
  expect(templateLedger(rebuilt).map((row) => row.checksum)).toEqual(edited.map((m) => m.checksum));
  // Each template is a whole, checkpointed file: no write-ahead log or half-built file beside it.
  expect(readdirSync(directory).toSorted()).toEqual(
    [first, added, rebuilt].map((path) => path.slice(directory.length + 1)).toSorted(),
  );
});

it("removes the template directories of ended runs in its PID namespace, never a running one's or another namespace's (TS-M13)", () => {
  const root = scratchDirectory(testDataRoot());
  const names = (paths: string[]) => paths.map((path) => path.slice(root.length + 1)).toSorted();
  // Above the kernel's largest process ID (2^22), so no process has it.
  const gone = 2 ** 22 + 1;
  const ended = join(root, `craftingtable-template-test-111-${gone}-AbC123`);
  const running = join(root, `craftingtable-template-test-111-${process.pid}-dEf456`);
  // Its process IDs are not this namespace's, so it cannot be told ended.
  const sandboxed = join(root, `craftingtable-template-test-222-${gone}-JkL012`);
  const other = join(root, 'craftingtable-server-test-GhI789');
  for (const directory of [ended, running, sandboxed, other]) mkdirSync(directory);
  sweepEndedRuns(root, undefined);
  expect(readdirSync(root).toSorted()).toEqual(names([ended, running, sandboxed, other]));
  sweepEndedRuns(root, '111');
  expect(readdirSync(root).toSorted()).toEqual(names([running, sandboxed, other]));
});

it('publishes a template without replacing one, and by rename where hard links are refused (TS-M13)', () => {
  const directory = scratchDirectory(testDataRoot());
  const file = (name: string, text: string) => {
    writeFileSync(join(directory, name), text);
    return join(directory, name);
  };
  const refuse = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const path = join(directory, 'template.sqlite');
  publishOnce(file('first', 'first'), path);
  publishOnce(file('second', 'second'), path);
  expect(readFileSync(path, 'utf8')).toBe('first');

  const linkless = join(directory, 'linkless.sqlite');
  publishOnce(file('third', 'third'), linkless, refuse('EXDEV'));
  publishOnce(file('fourth', 'fourth'), linkless, refuse('EPERM'));
  expect(readFileSync(linkless, 'utf8')).toBe('third');
  expect(() => publishOnce(file('fifth', 'fifth'), linkless, refuse('EACCES'))).toThrow('EACCES');
});

it.skipIf(pidNamespace() === undefined)(
  "names this run's template directory by its PID namespace and process (TS-M13)",
  () => {
    expect(inject('testTemplateDirectory').split('/').at(-1)).toMatch(
      new RegExp(`^craftingtable-template-test-${pidNamespace()}-\\d+-`),
    );
  },
);
