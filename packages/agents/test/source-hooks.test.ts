import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const HOOKS = new URL('../src/source-hooks.ts', import.meta.url).href;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Where a plain `node` child with the hooks resolves `specifier`, from `directory`. */
function resolveInChild(directory: string, specifier: string) {
  return spawnSync(
    process.execPath,
    [
      `--import=${HOOKS}`,
      '--input-type=module',
      '-e',
      `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
    ],
    { cwd: directory, encoding: 'utf8' },
  );
}

it('resolves a workspace package to its TypeScript source', () => {
  const child = resolveInChild(
    fileURLToPath(new URL('..', import.meta.url)),
    '@craftingtable/domain',
  );
  expect(child.stdout.trim()).toBe(new URL('../../domain/src/index.ts', import.meta.url).href);
});

/** A dependency that publishes a `source` condition keeps resolving to what it ships. */
it('leaves a dependency’s own source condition alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-source-hooks-'));
  roots.push(root);
  const dependency = join(root, 'node_modules', 'published');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'published',
      type: 'module',
      exports: { '.': { source: './src/index.ts', default: './index.js' } },
    }),
  );
  writeFileSync(join(dependency, 'index.js'), 'export {};\n');
  const child = resolveInChild(root, 'published');
  expect(child.stdout.trim()).toBe(pathToFileURL(join(dependency, 'index.js')).href);
});
