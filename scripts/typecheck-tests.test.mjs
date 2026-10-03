import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { testProjects } from './typecheck-tests.mjs';

const SCRIPT = fileURLToPath(new URL('./typecheck-tests.mjs', import.meta.url));
const TEST_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    types: [],
  },
  include: ['test/**/*.ts'],
});

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-typecheck-tests-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

it('finds every test project, and the packages whose tests have none (R-I4)', () => {
  const root = workspace({
    'packages/typed/tsconfig.test.json': TEST_TSCONFIG,
    'packages/typed/test/one.test.ts': 'export const a = 1;\n',
    'packages/untyped/test/nested/one.test.ts': 'export const a = 1;\n',
    'packages/no-tests/src/index.ts': 'export const a = 1;\n',
    'packages/empty-test-dir/test/README.md': 'notes\n',
    'apps/server/tsconfig.test.json': TEST_TSCONFIG,
  });
  expect(testProjects(root)).toEqual({
    projects: ['apps/server/tsconfig.test.json', 'packages/typed/tsconfig.test.json'],
    missing: ['packages/untyped'],
  });
});

it('reads the real repository: every package with tests has a test project', () => {
  const { projects, missing } = testProjects(fileURLToPath(new URL('..', import.meta.url)));
  expect(missing).toEqual([]);
  expect(projects).toContain('apps/server/tsconfig.test.json');
  expect(projects.length).toBeGreaterThanOrEqual(7);
});

it('fails the command on a package without a test project, and on a type error', () => {
  const missing = workspace({ 'packages/newpkg/test/one.test.ts': 'export const a = 1;\n' });
  const refused = spawnSync(process.execPath, [SCRIPT, missing], { encoding: 'utf8' });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('packages/newpkg/test holds tests but packages/newpkg has no');

  const wrong = workspace({
    'packages/newpkg/tsconfig.test.json': TEST_TSCONFIG,
    'packages/newpkg/test/one.test.ts': "export const a: number = 'one';\n",
  });
  expect(spawnSync(process.execPath, [SCRIPT, wrong], { encoding: 'utf8' }).status).toBe(1);

  const right = workspace({
    'packages/newpkg/tsconfig.test.json': TEST_TSCONFIG,
    'packages/newpkg/test/one.test.ts': 'export const a: number = 1;\n',
  });
  expect(spawnSync(process.execPath, [SCRIPT, right], { encoding: 'utf8' }).status).toBe(0);
});
