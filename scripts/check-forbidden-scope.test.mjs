import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectWorkspace, PROCESS_AUTHORITY, runCheck } from './check-forbidden-scope.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A server-like project: compiles `src` to `dist`, as the workspace's packages do. */
const PACKAGE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    rootDir: 'src',
    outDir: 'dist',
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src'],
});
/** The browser app's shape: bundler resolution, no emit. */
const WEB_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2023',
    module: 'ESNext',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src'],
});
/** The tests vitest runs, declared the way the real `vitest.config.ts` declares them. */
const VITEST_CONFIG = `export default {
  test: {
    projects: [
      {
        test: {
          include: [
            'packages/*/src/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
          ],
          globalSetup: ['packages/storage/src/global-setup.ts'],
        },
      },
      { test: { include: ['apps/web/src/**/*.test.tsx'], setupFiles: ['apps/web/src/setup.ts'] } },
    ],
  },
};
`;

/**
 * A throwaway Git workspace: the given files, a TypeScript project for every package they name
 * (unless the files give one, or `null` for none), a vitest config, and the repository's kind
 * of `.gitignore`, all in a temporary directory.
 */
function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-scope-'));
  roots.push(root);
  const all = {
    'package.json': '{"name":"scratch"}',
    'vitest.config.ts': VITEST_CONFIG,
    '.gitignore': 'node_modules/\ndist/\ncoverage/\n',
  };
  for (const path of Object.keys(files)) {
    const [group, name] = path.split('/');
    if (group !== 'apps' && group !== 'packages') continue;
    all[`${group}/${name}/tsconfig.json`] =
      `${group}/${name}` === 'apps/web' ? WEB_TSCONFIG : PACKAGE_TSCONFIG;
  }
  Object.assign(all, files);
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  return root;
}

const AUTHORITY_ONLY = 'is permitted only in a listed process authority';
const capability = (file, specifier) =>
  `${file}: capability import "${specifier}" ${AUTHORITY_ONLY}`;
const computed = (file, line, what) =>
  `${file}:${line}: loads a module by a name it computes (${what}); only a listed process authority may`;
const prose = (file, line) => `${file}:${line}: branches on human-readable text; use a typed code`;

describe('the bypasses that printed "passed" (TS-M11; GR F-4, F-7)', () => {
  it('fails each of them', () => {
    const root = workspace({
      // tsc compiles a directory named `dist` inside `src`; the old walk skipped it.
      'apps/server/src/dist/spawner.ts':
        "import { spawn } from 'node:child_process';\nexport { spawn };\n",
      // A dot-directory is skipped by tsc and was skipped by the walk; it is still listed.
      'apps/server/src/.cache/spawner.ts':
        "import { spawn } from 'node:child_process';\nexport { spawn };\n",
      'apps/server/src/template.ts': 'export const cp = await import(`node:child_process`);\n',
      'apps/server/src/template-require.ts': 'export const cp = require(`child_process`);\n',
      'apps/server/src/computed.ts':
        "const name = ['node:child', 'process'].join('_');\nexport const cp = await import(name);\n",
      'apps/server/src/builtin.ts':
        "export const cp = process.getBuiltinModule('node:child_process');\n",
      'apps/server/src/created.ts':
        "import { createRequire } from 'node:module';\nexport const cp = createRequire(import.meta.url)('child_process');\n",
      'apps/server/src/escaped.ts': "const r = require;\nexport const cp = r('child_process');\n",
      'apps/server/src/cluster.ts': "import cluster from 'node:cluster';\nexport { cluster };\n",
      // The comment stripper ran over strings too, and hid what followed.
      'apps/server/src/stripped.ts': [
        "export const sep = '//'; import { spawn } from 'node:child_process';",
        "export const open = '/*'; import { fork } from 'child_process'; export const shut = '*/';",
        'export { spawn, fork };',
        '',
      ].join('\n'),
      // A production module is production whatever it is named.
      'apps/server/src/spawn-test-support.ts':
        "import { spawn } from 'node:child_process';\nexport { spawn };\n",
      'apps/server/src/uses-support.ts':
        "import { spawn } from './spawn-test-support.js';\nexport const run = spawn;\n",
      'apps/server/src/prose.ts': [
        'type Stop = { reason: string; message?: string };',
        'export function f(x: Stop): number {',
        '  switch (x.reason) {',
        "    case 'Daemon restarted.':",
        '      return 1;',
        '  }',
        "  if (x.reason!.startsWith('Daemon')) return 2;",
        "  if (x.reason.toLowerCase().includes('quota')) return 3;",
        '  if (x.reason',
        "    .startsWith('Waiting')) return 4;",
        "  if (x.reason.slice(0, 8) === 'Waiting ') return 5;",
        "  if (x.reason.split(' ')[0] === 'Daemon') return 6;",
        "  if (x['reason'] === 'Daemon restarted.') return 7;",
        "  if (String(x.message).includes('quota')) return 8;",
        "  if (new RegExp('quota').test(x.message ?? '')) return 9;",
        "  if (['Paused.', 'Stopped.'].includes(x.reason)) return 10;",
        "  if (x.reason === 'Paused') return 11;",
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    });
    expect(runCheck(root).sort()).toEqual(
      [
        capability('apps/server/src/.cache/spawner.ts', 'node:child_process'),
        capability('apps/server/src/dist/spawner.ts', 'node:child_process'),
        capability('apps/server/src/template.ts', 'node:child_process'),
        capability('apps/server/src/template-require.ts', 'child_process'),
        computed('apps/server/src/computed.ts', 2, 'import()'),
        computed('apps/server/src/builtin.ts', 1, 'getBuiltinModule'),
        computed('apps/server/src/created.ts', 1, 'createRequire'),
        computed('apps/server/src/created.ts', 2, 'createRequire'),
        computed('apps/server/src/escaped.ts', 1, 'require'),
        capability('apps/server/src/cluster.ts', 'node:cluster'),
        capability('apps/server/src/stripped.ts', 'node:child_process'),
        capability('apps/server/src/stripped.ts', 'child_process'),
        capability('apps/server/src/spawn-test-support.ts', 'node:child_process'),
        ...[3, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17].map((line) =>
          prose('apps/server/src/prose.ts', line),
        ),
      ].sort(),
    );
  });
});

describe('what the boundaries allow', () => {
  it('passes tests, test support, typed codes, local names and the legacy mapping', () => {
    const root = workspace({
      // Tests and what only tests import may spawn, whatever their names.
      'apps/server/src/run.test.ts':
        "import { spawn } from 'node:child_process';\nimport { helper } from './helper.js';\nexport { spawn, helper };\n",
      'apps/server/src/helper.ts':
        "import { execFile } from 'node:child_process';\nexport const helper = execFile;\n",
      'packages/storage/src/global-setup.ts':
        "import { spawnSync } from 'node:child_process';\nexport default () => spawnSync('true');\n",
      'apps/web/src/setup.ts':
        "export const message = 'x';\nif (message.startsWith('Daemon')) {}\n",
      'apps/server/src/typed.ts': [
        'type Stop = { reason: string; message: { text: string } };',
        'const OPEN_QUESTIONS = /open questions/;',
        'export function f(x: Stop): number {',
        "  if (x.reason === 'daemon-drain') return 1;",
        '  if (OPEN_QUESTIONS.test(x.message.text)) return 2;',
        '  switch (x.reason) {',
        "    case 'daemon-drain':",
        '      return 3;',
        '  }',
        "  // x.reason.startsWith('Daemon') is gone",
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      // A local function named `require` is not module loading.
      'packages/planning/src/rules.ts':
        "function require(ok: boolean, message: string): void {\n  if (!ok) throw new Error(message);\n}\nexport const check = (n: number) => require(n > 0, 'positive');\n",
      'packages/domain/src/attention-legacy.ts':
        "export const legacy = (reason: string) => reason.startsWith('Daemon restarted.');\n",
      // The adapters parse vendor and tool output on purpose.
      'packages/agents/src/codex.ts':
        'export const limited = (message: string) => /usage limit/i.test(message);\n',
    });
    expect(runCheck(root)).toEqual([]);
  });

  it('lets each listed process authority, and only it, spawn and load by computed names', () => {
    const files = {};
    const spawning =
      "import { spawn } from 'node:child_process';\nconst m = await import(new URL('./x.js', import.meta.url).href);\nexport { spawn, m };\n";
    for (const path of PROCESS_AUTHORITY.keys()) files[path] = spawning;
    files['packages/agents/src/rogue.ts'] = spawning;
    files['packages/git/src/vendor.ts'] = "import git from 'simple-git';\nexport { git };\n";
    expect(runCheck(workspace(files)).sort()).toEqual(
      [
        capability('packages/agents/src/rogue.ts', 'node:child_process'),
        computed('packages/agents/src/rogue.ts', 2, 'import()'),
        capability('packages/git/src/vendor.ts', 'simple-git'),
      ].sort(),
    );
  });
});

it('takes tests only from vitest’s test blocks, less what they exclude', () => {
  const spawning = "import { spawn } from 'node:child_process';\nexport { spawn };\n";
  const root = workspace({
    'vitest.config.ts': `export default {
  test: {
    include: ['apps/server/src/**/*.test.ts'],
    exclude: ['apps/server/src/slow/**'],
    coverage: { include: ['apps/server/src/**'] },
  },
};
`,
    'apps/server/src/run.test.ts': spawning,
    'apps/server/src/slow/run.test.ts': spawning,
    'apps/server/src/service.ts': spawning,
  });
  expect(runCheck(root).sort()).toEqual(
    [
      capability('apps/server/src/slow/run.test.ts', 'node:child_process'),
      capability('apps/server/src/service.ts', 'node:child_process'),
    ].sort(),
  );
});

describe('the package boundaries', () => {
  it('keeps the planning and domain packages pure, by specifier and by resolved file', () => {
    const root = workspace({
      'packages/storage/src/database.ts': 'export const open = () => 1;\n',
      'packages/domain/src/ids.ts': 'export type Id = string;\n',
      'packages/planning/src/parse.ts':
        "import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nexport { readFileSync, createHash };\n",
      'packages/planning/src/escape.ts':
        "import { open } from '../../storage/src/database.js';\nimport type { Id } from '../../domain/src/ids.js';\nexport const o: Id = String(open());\n",
      'packages/domain/src/external.ts': "import { z } from 'zod';\nexport { z };\n",
      'packages/domain/src/escape.ts':
        "import { open } from '../../storage/src/database.js';\nexport { open };\n",
      'packages/domain/src/ok.ts':
        "import type { Id } from './ids.js';\nexport const a: Id = 'a';\n",
    });
    expect(runCheck(root).sort()).toEqual(
      [
        'packages/planning/src/parse.ts: planning package imports impure module "node:fs"',
        'packages/planning/src/escape.ts: planning package imports "packages/storage/src/database.ts" from packages/storage',
        'packages/domain/src/external.ts: domain package imports external module "zod"',
        'packages/domain/src/escape.ts: domain package imports "packages/storage/src/database.ts" from packages/storage',
      ].sort(),
    );
  });

  it('reads manifests and rejects Exo Stack names and NUL bytes everywhere, tests included', () => {
    const root = workspace({
      'packages/domain/package.json':
        '{"name":"@craftingtable/domain","devDependencies":{"exoskeleton":"1","execa":"9"}}',
      'packages/domain/src/a.test.ts': "import q from '@exo/action-queue';\nexport { q };\n",
      'apps/web/src/a.ts': 'export const a = " \0";\n',
    });
    expect(runCheck(root).sort()).toEqual(
      [
        'packages/domain/package.json: forbidden dependency "exoskeleton"',
        'packages/domain/package.json: forbidden capability dependency "execa"',
        'packages/domain/src/a.test.ts: forbidden import "@exo/action-queue"',
        'apps/web/src/a.ts: contains a NUL byte',
      ].sort(),
    );
  });
});

describe('the bypasses the unit review found', () => {
  it('follows imports into build output, CommonJS requires, page entries and URL-loaded modules', () => {
    const spawning = "import { spawn } from 'node:child_process';\nexport { spawn };\n";
    const root = workspace({
      'packages/storage/src/database.ts': 'export const open = () => 1;\n',
      'packages/storage/dist/database.d.ts': 'export declare const open: () => number;\n',
      'packages/storage/dist/database.js': 'export const open = () => 1;\n',
      'packages/planning/src/built.ts':
        "import { open } from '../../storage/dist/database.js';\nexport { open };\n",
      'packages/domain/src/built.ts':
        "import { open } from '../../storage/dist/database.js';\nexport { open };\n",
      'packages/planning/src/common.cts':
        "export const db = require('../../storage/src/database.js');\n",
      // The page's entry, which a test also imports.
      'apps/web/index.html': '<script type="module" src="/src/main.tsx"></script>\n',
      'apps/web/src/main.tsx':
        "export const stopped = (x: { reason: string }) => x.reason === 'Daemon restarted.';\n",
      'apps/web/src/main.test.tsx': "import { stopped } from './main.tsx';\nexport { stopped };\n",
      // A worker the daemon loads by URL, which its test also imports.
      'apps/server/src/index.ts':
        "export const worker = new URL('./worker.js', import.meta.url);\n",
      'apps/server/src/worker.ts': spawning,
      'apps/server/src/worker.test.ts': "import { spawn } from './worker.js';\nexport { spawn };\n",
      // Node's loader, declared ambiently or reached through CommonJS's module object.
      'apps/server/src/ambient.ts':
        "declare const require: (name: string) => unknown;\nexport const cp = require('child_process');\n",
      'apps/server/src/module-require.cts':
        "export const cp = module.require('child_process');\nexport const again = process.mainModule?.require('node:child_process');\n",
      // Artifacts beside the sources are not sources.
      'apps/web/coverage/prettify.js': 'window.x = 1;\n',
    });
    expect(runCheck(root).sort()).toEqual(
      [
        'packages/planning/src/built.ts: planning package imports "packages/storage/dist/database.d.ts" from packages/storage',
        'packages/domain/src/built.ts: domain package imports "packages/storage/dist/database.d.ts" from packages/storage',
        'packages/planning/src/common.cts: planning package imports "packages/storage/src/database.ts" from packages/storage',
        prose('apps/web/src/main.tsx', 1),
        capability('apps/server/src/worker.ts', 'node:child_process'),
        capability('apps/server/src/ambient.ts', 'child_process'),
        computed('apps/server/src/module-require.cts', 1, 'module.require'),
        computed('apps/server/src/module-require.cts', 2, 'module.require'),
      ].sort(),
    );
  });
});

describe('the fail-open gaps the independent review found', () => {
  /** Every source file Git would commit is checked, whichever project compiles it (HIGH-2). */
  it('checks files outside every package-root project', () => {
    const spawning = "import { spawn } from 'node:child_process';\nexport { spawn };\n";
    const root = workspace({
      'packages/newpkg/tsconfig.json': null,
      'packages/newpkg/src/index.ts':
        "import q from '@exo/action-queue';\nimport { spawn } from 'node:child_process';\nexport { q, spawn };\n",
      'apps/server/src/index.ts': 'export const a = 1;\n',
      'apps/server/bin/spawn.mjs': spawning,
      'apps/server/root.ts': spawning,
      'packages/agents/src/index.ts': 'export const a = 1;\n',
      'packages/agents/fixtures/fake.mjs': spawning,
      // A nested project, as test support moved out of `src` will have.
      'packages/storage/src/index.ts': 'export const a = 1;\n',
      'packages/storage/test/tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true },
        include: ['.'],
      }),
      'packages/storage/test/stray.ts': spawning,
      // Ignored build output is not source.
      'apps/web/coverage/prettify.js': spawning,
    });
    expect(runCheck(root).sort()).toEqual(
      [
        'packages/newpkg/src/index.ts: forbidden import "@exo/action-queue"',
        capability('packages/newpkg/src/index.ts', 'node:child_process'),
        capability('apps/server/bin/spawn.mjs', 'node:child_process'),
        capability('apps/server/root.ts', 'node:child_process'),
        capability('packages/agents/fixtures/fake.mjs', 'node:child_process'),
        capability('packages/storage/test/stray.ts', 'node:child_process'),
      ].sort(),
    );
  });

  /**
   * The layouts unit K moves test support into (MEDIUM-4): a package's `test/` project, and a
   * workspace package only tests depend on. Neither is production; a package an app depends
   * on is, through its manifest's entry.
   */
  it('treats test projects and test-only packages as test support', () => {
    const spawning = "import { spawn } from 'node:child_process';\nexport { spawn };\n";
    const stack = (name) => ({
      [`packages/${name}/package.json`]: JSON.stringify({
        name: `@craftingtable/${name}`,
        main: './dist/index.js',
        exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
      }),
      [`packages/${name}/src/index.ts`]: spawning,
    });
    const root = workspace({
      'packages/storage/src/index.ts': 'export const a = 1;\n',
      'packages/storage/test/tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true },
        include: ['.'],
      }),
      'packages/storage/test/support.ts': spawning,
      'packages/storage/test/store.test.ts':
        "import { spawn } from './support.js';\nexport { spawn };\n",
      ...stack('test-stack'),
      ...stack('runner'),
      'apps/server/package.json': JSON.stringify({
        name: '@craftingtable/server',
        dependencies: { '@craftingtable/runner': 'workspace:*' },
        devDependencies: { '@craftingtable/test-stack': 'workspace:*' },
      }),
      'apps/server/src/index.ts': 'export const a = 1;\n',
      'apps/server/src/run.test.ts':
        "import { spawn } from '@craftingtable/test-stack';\nexport { spawn };\n",
    });
    const { findings, classes } = inspectWorkspace(root);
    expect(findings).toEqual([capability('packages/runner/src/index.ts', 'node:child_process')]);
    expect(classes.get('packages/storage/test/support.ts')).toBe('test-support');
    expect(classes.get('packages/test-stack/src/index.ts')).toBe('test-support');
  });

  /** Forms the self-tests did not plant, so a checker that dropped them still passed (MEDIUM-3). */
  it('catches import-equals, import types, process loaders and lowercase prose', () => {
    const root = workspace({
      'apps/server/src/equals.ts': "import cp = require('node:child_process');\nexport { cp };\n",
      'apps/server/src/types.ts':
        "export type Spawn = typeof import('node:child_process').spawn;\n",
      'apps/server/src/natives.ts': [
        "export const a = process.binding('spawn_sync');",
        "export const b = process.dlopen({ exports: {} }, '/x.node');",
        "export const c = process['getBuiltinModule']('node:child_process');",
        '',
      ].join('\n'),
      'apps/server/src/lower.ts':
        "export const f = (x: { reason: string }) => x.reason === 'daemon restarted';\n",
    });
    expect(runCheck(root).sort()).toEqual(
      [
        capability('apps/server/src/equals.ts', 'node:child_process'),
        capability('apps/server/src/types.ts', 'node:child_process'),
        computed('apps/server/src/natives.ts', 1, 'process.binding'),
        computed('apps/server/src/natives.ts', 2, 'process.dlopen'),
        computed('apps/server/src/natives.ts', 3, 'getBuiltinModule'),
        prose('apps/server/src/lower.ts', 1),
      ].sort(),
    );
  });

  /** Code run from text, and `process` reached around a name (LOW-6). */
  it('catches eval, Function, workers, vm and computed access to process', () => {
    const root = workspace({
      'apps/server/src/reflect.ts':
        "export const a = Reflect.get(process, 'getBuiltin' + 'Module');\n",
      'apps/server/src/indexed.ts':
        "const k = ['getBuiltin', 'Module'].join('');\nexport const b = (process as any)[k]('node:child_process');\n",
      'apps/server/src/cast.ts':
        "export const c = (process as any).binding('spawn_sync');\nexport const d = (process!).dlopen;\n",
      'apps/server/src/text.ts': [
        'export const e = new Function(\'return import("node:child_process")\');',
        "export const f = eval('1');",
        '',
      ].join('\n'),
      'apps/server/src/worker.ts':
        "import { Worker } from 'node:worker_threads';\nexport const w = () => new Worker('1', { eval: true });\n",
      'apps/server/src/context.ts': "import vm from 'node:vm';\nexport { vm };\n",
      'apps/server/src/fine.ts':
        "export const env = process.env.HOME;\nexport const g = process['argv'];\n",
    });
    expect(runCheck(root).sort()).toEqual(
      [
        computed('apps/server/src/reflect.ts', 1, 'Reflect on process'),
        computed('apps/server/src/indexed.ts', 2, 'process[…]'),
        computed('apps/server/src/cast.ts', 1, 'process.binding'),
        computed('apps/server/src/cast.ts', 2, 'process.dlopen'),
        computed('apps/server/src/text.ts', 1, 'Function'),
        computed('apps/server/src/text.ts', 2, 'eval'),
        capability('apps/server/src/worker.ts', 'node:worker_threads'),
        capability('apps/server/src/context.ts', 'node:vm'),
      ].sort(),
    );
  });

  /** Only what tests reach, and nothing production reaches, is test support (HIGH-1). */
  it('checks a module that neither an entry nor a test reaches', () => {
    const root = workspace({
      'apps/server/src/self.ts':
        "import { spawn } from 'node:child_process';\nimport * as self from './self.js';\nexport { spawn, self };\n",
      'apps/server/src/cycle-a.ts':
        "import { spawn } from 'node:child_process';\nimport type { B } from './cycle-b.js';\nexport type A = B;\nexport { spawn };\n",
      'apps/server/src/cycle-b.ts':
        "import type { A } from './cycle-a.js';\nexport type B = A | 1;\n",
      'packages/planning/src/cycle-a.ts':
        "import { readFileSync } from 'node:fs';\nimport { b } from './cycle-b.js';\nexport const a = () => b() + readFileSync('x', 'utf8');\n",
      'packages/planning/src/cycle-b.ts':
        "import { a } from './cycle-a.js';\nexport const b = (): string => (a ? '' : '');\n",
    });
    expect(runCheck(root).sort()).toEqual(
      [
        capability('apps/server/src/self.ts', 'node:child_process'),
        capability('apps/server/src/cycle-a.ts', 'node:child_process'),
        'packages/planning/src/cycle-a.ts: planning package imports impure module "node:fs"',
      ].sort(),
    );
  });
});

it('passes on the real repository, having read and classified its modules', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { findings, classes } = inspectWorkspace(root);
  expect(findings).toEqual([]);
  const count = (kind) => [...classes.values()].filter((c) => c === kind).length;
  // The projects were read: an empty file set would pass vacuously.
  expect(count('production')).toBeGreaterThan(400);
  expect(count('test')).toBeGreaterThan(200);
  for (const path of PROCESS_AUTHORITY.keys()) expect(classes.get(path)).toBe('production');
  expect(classes.get('apps/server/src/index.ts')).toBe('production');
  // Run by a package script, and imported by its own test.
  expect(classes.get('apps/server/src/db-verify.ts')).toBe('production');
  expect(classes.get('apps/web/src/test-setup.ts')).toBe('test');
  expect(classes.get('apps/server/src/execution-test-support.ts')).toBe('test-support');
  // Test support by what imports it, not by its name.
  expect(classes.get('packages/storage/src/migration-preservation.ts')).toBe('test-support');
});

/** The gate is the command, not the function: `pnpm check:scope` must exit non-zero. */
it('fails the command on a planted violation and passes it on a clean workspace', () => {
  const script = fileURLToPath(new URL('./check-forbidden-scope.mjs', import.meta.url));
  const clean = workspace({ 'apps/server/src/index.ts': 'export const a = 1;\n' });
  const passed = spawnSync(process.execPath, [script, clean], { encoding: 'utf8' });
  expect(passed.status).toBe(0);
  expect(passed.stdout).toContain('Forbidden-scope check passed');
  const planted = workspace({
    'apps/server/src/index.ts': 'export const cp = await import(`node:child_process`);\n',
  });
  const failed = spawnSync(process.execPath, [script, planted], { encoding: 'utf8' });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain(capability('apps/server/src/index.ts', 'node:child_process'));
});
