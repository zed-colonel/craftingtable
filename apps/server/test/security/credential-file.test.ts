import {
  chmodSync,
  existsSync,
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
import { afterEach, expect, it } from 'vitest';
import { CredentialFile } from '../../src/security/credential-file.js';

/**
 * The Pushover credentials live in a file only the operator can read, outside the database and
 * its copies and out of every sandboxed agent's reach (R-G9; operator decision 2026-10-05).
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-credentials-'));
  directories.push(root);
  return join(root, 'config');
}

const one = { applicationToken: 'a'.repeat(30), userKey: 'u'.repeat(30) };

it("keeps each workspace's credentials in a file only the operator can read", () => {
  const dir = directory();
  const file = new CredentialFile(dir);
  expect(file.pushover('ws-1')).toBeUndefined();
  file.setPushover('ws-1', one);
  // Written private, before anything reads it.
  const path = join(dir, 'credentials.json');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  file.setPushover('ws-2', { ...one, userKey: 'k'.repeat(30) });
  expect(file.pushover('ws-1')).toEqual(one);
  expect(new CredentialFile(dir).pushover('ws-2')?.userKey).toBe('k'.repeat(30));
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  file.setPushover('ws-1', undefined);
  expect(file.pushover('ws-1')).toBeUndefined();
  expect(JSON.parse(readFileSync(path, 'utf8')).pushover).not.toHaveProperty('ws-1');
});

it('makes a file it finds readable by others private again, and refuses one it cannot read', () => {
  const dir = directory();
  const file = new CredentialFile(dir);
  file.setPushover('ws-1', one);
  const path = join(dir, 'credentials.json');
  rmSync(path);
  writeFileSync(path, JSON.stringify({ version: 1, pushover: { 'ws-1': one } }), { mode: 0o644 });
  expect(file.pushover('ws-1')).toEqual(one);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  writeFileSync(path, '{ not json');
  expect(() => file.pushover('ws-1')).toThrow(/credentials\.json/);
});

it('makes a settings directory it finds private, and leaves no temporary file behind (R-G9 review)', () => {
  const dir = directory();
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  // What a crash between writing and renaming would leave.
  const stale = join(dir, 'credentials.json.12345.tmp');
  writeFileSync(stale, '{"version":1,"pushover":{}}', { mode: 0o600 });
  new CredentialFile(dir).setPushover('ws-1', one);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(existsSync(stale)).toBe(false);
  expect(readdirSync(dir)).toEqual(['credentials.json']);
});
