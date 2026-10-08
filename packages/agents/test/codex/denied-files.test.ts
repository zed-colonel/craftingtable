import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { unmaskableDeniedFiles } from '../../src/codex/arguments.js';

// Paths the test owns, so the count does not depend on the host (its Docker socket, say).
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function owned() {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-codex-files-'));
  roots.push(root);
  const file = (name: string) => {
    writeFileSync(join(root, name), '');
    return join(root, name);
  };
  const dangling = (name: string) => {
    symlinkSync(join(root, 'nothing-here'), join(root, name));
    return join(root, name);
  };
  const directory = join(root, 'directory');
  mkdirSync(directory);
  return { file, dangling, directory, missing: join(root, 'missing') };
}

it('refuses exactly two existing files, and lets exactly one through (R-G14 review LOW-1)', () => {
  const p = owned();
  const one = p.file('a.json');
  expect(unmaskableDeniedFiles([one, p.directory, p.missing])).toBeUndefined();
  const two = [one, p.file('b.db')];
  expect(unmaskableDeniedFiles([...two, p.directory, p.missing])).toEqual(two);
});

it('counts a link that names nothing as a file (R-G14 review LOW-2)', () => {
  const p = owned();
  const first = p.dangling('first');
  expect(unmaskableDeniedFiles([first, p.missing])).toBeUndefined();
  const both = [first, p.dangling('second')];
  expect(unmaskableDeniedFiles(both)).toEqual(both);
});
