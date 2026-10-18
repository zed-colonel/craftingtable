import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMITTED_EXPORTS,
  inspectWorkspace,
  KNOWN_IMPORT_CYCLES,
  PROCESS_AUTHORITY,
  REPLAY_HOST_PIN,
  REPLAY_HOST_USERS,
  runCheck,
} from './check-forbidden-scope.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A server-like project: compiles `src` to `dist`, as the workspace's packages do. Without
 * `emit` it sets `noEmit`: rules 1-5 read it the same either way, and rule 6, which reads only
 * what a build ships, is planted with `{ emit: true }` and declared entries.
 */
const packageTsconfig = (emit) =>
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      rootDir: 'src',
      outDir: 'dist',
      ...(emit ? {} : { noEmit: true }),
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
          include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
          globalSetup: ['packages/storage/test/global-setup.ts'],
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
function workspace(files, { root: given, git = true, emit = false } = {}) {
  const root = given ?? mkdtempSync(join(tmpdir(), 'craftingtable-scope-'));
  if (given === undefined) roots.push(root);
  const all = {
    'package.json': '{"name":"scratch"}',
    'vitest.config.ts': VITEST_CONFIG,
    '.gitignore': 'node_modules/\ndist/\ncoverage/\n',
  };
  for (const path of Object.keys(files)) {
    const [group, name] = path.split('/');
    if (group !== 'apps' && group !== 'packages') continue;
    all[`${group}/${name}/tsconfig.json`] =
      `${group}/${name}` === 'apps/web' ? WEB_TSCONFIG : packageTsconfig(emit);
  }
  Object.assign(all, files);
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (git) expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  return root;
}

const AUTHORITY_ONLY = 'is permitted only in a listed process authority';
const capability = (file, specifier) =>
  `${file}: capability import "${specifier}" ${AUTHORITY_ONLY}`;
const computed = (file, line, what) =>
  `${file}:${line}: loads a module by a name it computes (${what}); only a listed process authority may`;
const prose = (file, line) => `${file}:${line}: branches on human-readable text; use a typed code`;
/** The other rules' workspaces plant exports nothing imports; rule 8 has its own tests. */
const exceptRule8 = (findings) => findings.filter((finding) => !finding.endsWith('(DATA-15)'));

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
        capability('apps/server/src/created.ts', 'node:module'),
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
      'apps/server/test/run.test.ts':
        "import { spawn } from 'node:child_process';\nimport { helper } from './helper.js';\nexport { spawn, helper };\n",
      'apps/server/test/helper.ts':
        "import { execFile } from 'node:child_process';\nexport const helper = execFile;\n",
      'packages/storage/test/global-setup.ts':
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
    expect(exceptRule8(runCheck(root))).toEqual([]);
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
    include: ['apps/server/test/**/*.test.ts'],
    exclude: ['apps/server/test/slow/**'],
    coverage: { include: ['apps/server/test/**'] },
  },
};
`,
    'apps/server/test/run.test.ts': spawning,
    'apps/server/test/slow/run.test.ts': spawning,
    'apps/server/src/service.ts': spawning,
  });
  expect(runCheck(root).sort()).toEqual(
    [
      capability('apps/server/test/slow/run.test.ts', 'node:child_process'),
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
    expect(exceptRule8(runCheck(root)).sort()).toEqual(
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
      'packages/domain/test/a.test.ts': "import q from '@exo/action-queue';\nexport { q };\n",
      'apps/web/src/a.ts': 'export const a = " \0";\n',
    });
    expect(runCheck(root).sort()).toEqual(
      [
        'packages/domain/package.json: forbidden dependency "exoskeleton"',
        'packages/domain/package.json: forbidden capability dependency "execa"',
        'packages/domain/test/a.test.ts: forbidden import "@exo/action-queue"',
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
      'apps/server/test/worker.test.ts':
        "import { spawn } from '../src/worker.js';\nexport { spawn };\n",
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
    expect(exceptRule8(runCheck(root)).sort()).toEqual(
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
      'apps/server/test/run.test.ts':
        "import { spawn } from '@craftingtable/test-stack';\nexport { spawn };\n",
    });
    const { findings, classes } = inspectWorkspace(root);
    expect(exceptRule8(findings)).toEqual([
      capability('packages/runner/src/index.ts', 'node:child_process'),
    ]);
    expect(classes.get('packages/storage/test/support.ts')).toBe('test-support');
    expect(classes.get('packages/test-stack/src/index.ts')).toBe('test-support');
  });

  /**
   * Nothing test-only in what a production build ships (R-I4, TS-M14): a test, a module that
   * imports the test runner, or one only tests import, compiled into a production package's
   * `dist`. Such a module is checked as production, which closes unit I's last gap: one loaded
   * only through a path built at runtime, and imported by a test.
   */
  it('fails tests and test support that a production build would ship', () => {
    const spawning = "import { spawn } from 'node:child_process';\nexport { spawn };\n";
    const root = workspace(
      {
        'vitest.config.ts': `export default {
  test: { include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts'] },
};
`,
        'apps/server/package.json': JSON.stringify({
          name: '@craftingtable/server',
          main: './dist/index.js',
          // A harness a script starts from the package's test/ (the e2e daemon).
          scripts: { 'e2e:start': 'tsx test/e2e/entry.ts' },
          dependencies: { '@craftingtable/storage': 'workspace:*' },
        }),
        'packages/storage/package.json': JSON.stringify({ name: '@craftingtable/storage' }),
        // Left in `src` by a move, and still included by vitest.
        'packages/storage/src/store.test.ts':
          "import { seed } from './seed.js';\nexport { seed };\n",
        // Only tests import it.
        'packages/storage/src/seed.ts': 'export const seed = 1;\n',
        'packages/storage/test/seed.test.ts':
          "import { seed } from '../src/seed.js';\nexport { seed };\n",
        // Production imports a module that imports the test runner.
        'apps/server/src/index.ts':
          "import { expect } from './expect.js';\nexport const worker = 'worker.js';\nexport { expect };\n",
        'apps/server/src/expect.ts': "import { expect } from 'vitest';\nexport { expect };\n",
        // Loaded only by a path built at runtime (the string above), and imported by its test.
        'apps/server/src/worker.ts': spawning,
        'apps/server/test/worker.test.ts':
          "import { spawn } from '../src/worker.js';\nexport { spawn };\n",
        // A harness nothing declares, which nothing imports: not an entry to rule 6, so it and
        // what only it and tests reach are findings.
        'apps/server/src/harness.ts':
          "import { reserve } from './reserve.js';\nexport { reserve };\n",
        'apps/server/src/reserve.ts': 'export const reserve = 1;\n',
        'apps/server/test/reserve.test.ts':
          "import { reserve } from '../src/reserve.js';\nexport { reserve };\n",
        // What only the test/ harness reaches.
        'apps/server/test/e2e/entry.ts':
          "import { root } from '../../src/root.js';\nexport { root };\n",
        'apps/server/src/root.ts': 'export const root = 1;\n',
        // Test support in a test project: not built, so not a finding.
        'apps/server/test/support.ts': spawning,
        'apps/server/test/support.test.ts':
          "import { spawn } from './support.js';\nexport { spawn };\n",
      },
      { emit: true },
    );
    const onlyTests = (path, outDir) =>
      `${path}: only tests import it, yet it is built into ${outDir}; move it to the package's test/ directory, or name it with new URL(…, import.meta.url) from the module that loads it`;
    const { findings, classes } = inspectWorkspace(root);
    expect(findings.sort()).toEqual(
      [
        "packages/storage/src/store.test.ts: a test built into packages/storage/dist; tests live in the package's test/ directory",
        onlyTests('packages/storage/src/seed.ts', 'packages/storage/dist'),
        'apps/server/src/expect.ts: imports the test runner "vitest" and is built into apps/server/dist',
        onlyTests('apps/server/src/worker.ts', 'apps/server/dist'),
        capability('apps/server/src/worker.ts', 'node:child_process'),
        "apps/server/src/harness.ts: no declared entry reaches it, yet it is built into apps/server/dist; import it from production, name it with new URL(…, import.meta.url) from the module that loads it, or move it to the package's test/ directory",
        onlyTests('apps/server/src/reserve.ts', 'apps/server/dist'),
        onlyTests('apps/server/src/root.ts', 'apps/server/dist'),
      ].sort(),
    );
    expect(classes.get('apps/server/src/worker.ts')).toBe('production');
    expect(classes.get('apps/server/test/support.ts')).toBe('test-support');
  });

  /** Code review: a test vitest no longer runs, other runners, and a build that compiles test/. */
  it('fails stray tests, other test runners, and a production project compiling test/', () => {
    const root = workspace(
      {
        'apps/server/package.json': JSON.stringify({
          name: '@craftingtable/server',
          main: './dist/index.js',
          dependencies: {
            '@craftingtable/storage': 'workspace:*',
            '@craftingtable/contracts': '*',
          },
        }),
        'packages/storage/package.json': JSON.stringify({ name: '@craftingtable/storage' }),
        // Left in `src`, outside vitest's include, and importing no runner itself.
        'packages/storage/src/stray.test.ts':
          "import { help } from './help.js';\nexport { help };\n",
        'packages/storage/src/help.ts': 'export const help = 1;\n',
        'apps/server/src/index.ts': "import { check } from './runner.js';\nexport { check };\n",
        'apps/server/src/runner.ts':
          '/// <reference types="vitest" />\nimport { test } from \'node:test\';\nexport const check = test;\n',
        'packages/contracts/package.json': JSON.stringify({
          name: '@craftingtable/contracts',
          main: './dist/src/index.js',
        }),
        'packages/contracts/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            rootDir: '.',
            outDir: 'dist',
            types: [],
          },
          include: ['src', 'test'],
        }),
        'packages/contracts/src/index.ts': 'export const a = 1;\n',
        'packages/contracts/test/support.ts': 'export const s = 1;\n',
        'packages/contracts/test/a.test.ts': "import { s } from './support.js';\nexport { s };\n",
      },
      { emit: true },
    );
    const keepOut = "keep the package's test/ directory out of its production tsconfig.json";
    expect(exceptRule8(runCheck(root)).sort()).toEqual(
      [
        "packages/storage/src/stray.test.ts: named as a test, though vitest does not run it, built into packages/storage/dist; tests live in the package's test/ directory",
        "packages/storage/src/help.ts: only tests import it, yet it is built into packages/storage/dist; move it to the package's test/ directory, or name it with new URL(…, import.meta.url) from the module that loads it",
        'apps/server/src/runner.ts: imports the test runner "node:test" and is built into apps/server/dist',
        'apps/server/src/runner.ts: references the test runner\'s types "vitest" and is built into apps/server/dist',
        `packages/contracts/test/a.test.ts: a test built into packages/contracts/dist; ${keepOut}`,
        `packages/contracts/test/support.ts: only tests import it, yet it is built into packages/contracts/dist; ${keepOut}`,
      ].sort(),
    );
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
        computed('apps/server/src/reflect.ts', 1, 'process as a value'),
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
        // Rule 10 finds the daemon's two cycles; the planning package's is outside it.
        'apps/server/src/cycle-a.ts: import cycle among 2 modules (apps/server/src/cycle-a.ts, apps/server/src/cycle-b.ts), one path round it apps/server/src/cycle-a.ts → apps/server/src/cycle-b.ts → apps/server/src/cycle-a.ts; move what they share into a module none of them imports back (R-B7)',
        'apps/server/src/self.ts: import cycle among 1 module (apps/server/src/self.ts), one path round it apps/server/src/self.ts → apps/server/src/self.ts; move what they share into a module none of them imports back (R-B7)',
      ].sort(),
    );
  });
});

describe('map vocabulary stays in map-capabilities (rule 7, R-F2)', () => {
  const VOCABULARY = [
    'export const V03_VOCABULARY = {',
    "  planAcceptance: { reviewerRole: 'plan-owner', passCriteria: ['Plan is valid.'] },",
    "  resourceAdapters: { nativeTestHost: 'native-host' },",
    '  independentMaturity: /^independent\\b/i,',
    '} as const;',
    "export const kind = 'plan_approval';",
    '',
  ].join('\n');
  const vocabulary = (file, line, word) =>
    `${file}:${line}: writes map vocabulary "${word}"; ask packages/domain/src/map-capabilities.ts what the map declares`;

  it('finds vocabulary written elsewhere in production: string, template, JSX text or pattern', () => {
    const root = workspace({
      'packages/domain/src/map-capabilities.ts': VOCABULARY,
      'apps/server/src/policy.ts': [
        "export const role = (r: string) => r === 'plan-owner';",
        // A template with a substitution: `Resource native-host for ${id}`.
        `export const host = (id: string) => \`Resource native-host for \${id}\`;`,
        "export const ok = (c: string[]) => c.includes('Plan is valid.');",
        'export const maturity = /^independent\\b/i;',
        "export const built = new RegExp('^independent\\\\b');",
        // Format terms and keys are not vocabulary; neither is a comment naming plan-owner.
        "export const kinds = ['plan_approval', 'nativeTestHost', 'independent'];",
        '// plan-owner reviews the plan.',
        '',
      ].join('\n'),
      'apps/web/src/Panel.tsx':
        "export const title = 'Saved plan · plan-owner';\nexport const h = <h4>Accepted as plan-owner</h4>;\n",
      // Tests and the legacy mapping may write it.
      'apps/server/test/policy.test.ts': "export const role = 'plan-owner';\n",
      'packages/domain/src/attention-legacy.ts':
        "export const legacy = (m: string) => m.startsWith('Resource native-host');\n",
    });
    expect(exceptRule8(runCheck(root)).sort()).toEqual(
      [
        vocabulary('apps/server/src/policy.ts', 1, 'plan-owner'),
        vocabulary('apps/server/src/policy.ts', 2, 'native-host'),
        vocabulary('apps/server/src/policy.ts', 3, 'Plan is valid.'),
        vocabulary('apps/server/src/policy.ts', 4, '^independent\\b'),
        vocabulary('apps/server/src/policy.ts', 5, '^independent\\b'),
        vocabulary('apps/web/src/Panel.tsx', 1, 'plan-owner'),
        vocabulary('apps/web/src/Panel.tsx', 2, 'plan-owner'),
      ].sort(),
    );
  });

  it('reads constant concatenations, templates and const names, and the retired identifiers', () => {
    const root = workspace({
      'packages/domain/src/map-capabilities.ts': VOCABULARY,
      'apps/server/src/folded.ts': [
        "export const joined = 'plan-' + 'owner';",
        `export const template = \`plan-\${'owner'}\`;`,
        "const suffix = 'owner';",
        `export const named = \`plan-\${suffix}\`;`,
        "export const plan = (id: string) => id === 'STACK-PLAN-ACCEPTED';",
        "export const message = 'Accept STACK-PLAN-ACCEPTED evidence';",
        "export const bypass = ['review', 'independent-reviewer'];",
        // Legitimate: `review` alone, a role merely containing the retired one, a parameter.
        "export const roles = ['review', 'independent-reviewer-of-record'];",
        `export const dynamic = (part: string) => \`plan-\${part}\`;`,
        '',
      ].join('\n'),
      // Tests and fixtures keep the retired names.
      'apps/server/test/folded.test.ts':
        "export const ids = ['STACK-PLAN-ACCEPTED', 'independent-reviewer'];\n",
    });
    expect(exceptRule8(runCheck(root)).sort()).toEqual(
      [
        vocabulary('apps/server/src/folded.ts', 1, 'plan-owner'),
        vocabulary('apps/server/src/folded.ts', 2, 'plan-owner'),
        vocabulary('apps/server/src/folded.ts', 4, 'plan-owner'),
        vocabulary('apps/server/src/folded.ts', 5, 'STACK-PLAN-ACCEPTED'),
        vocabulary('apps/server/src/folded.ts', 6, 'STACK-PLAN-ACCEPTED'),
        vocabulary('apps/server/src/folded.ts', 7, 'independent-reviewer'),
      ].sort(),
    );
  });

  it('resolves a name only when one module-wide `const` declares it', () => {
    const root = workspace({
      'packages/domain/src/map-capabilities.ts': VOCABULARY,
      // Each builds run-time or other text; none writes `plan-owner`.
      'apps/server/src/inner.ts': [
        `export function g() { const suffix = 'reader'; return \`plan-\${suffix}\`; }`,
        `export function f() { const suffix = 'owner'; return suffix; }`,
        '',
      ].join('\n'),
      'apps/server/src/shadow.ts': [
        "const suffix = 'owner';",
        `export const h = (suffix: string) => \`plan-\${suffix}\`;`,
        'export const unused = suffix;',
        '',
      ].join('\n'),
      'apps/server/src/mutable.ts': [
        "let suffix = 'owner';",
        'export const set = (next: string) => { suffix = next; };',
        `export const read = () => \`plan-\${suffix}\`;`,
        '',
      ].join('\n'),
    });
    expect(exceptRule8(runCheck(root))).toEqual([]);
  });

  it('pins what it does not catch: text built at run time and other spellings of a pattern', () => {
    // Known misses, listed in rule 7's comment. A stronger rule turns these into findings.
    const root = workspace({
      'packages/domain/src/map-capabilities.ts': VOCABULARY,
      'apps/server/src/evasive.ts': [
        "export const joined = ['plan', 'owner'].join('-');",
        "export const cased = 'PLAN-OWNER'.toLowerCase();",
        'export const shouted = /^INDEPENDENT\\b/i;',
        'export const unanchored = /^independent/;',
        "export const prefix = (m: string) => m.startsWith('independent');",
        '',
      ].join('\n'),
    });
    expect(exceptRule8(runCheck(root))).toEqual([]);
  });

  it('fails closed when the module no longer declares the table', () => {
    const root = workspace({
      'packages/domain/src/map-capabilities.ts':
        "export const VOCABULARY = { role: 'plan-owner' };\n",
      'apps/server/src/policy.ts': "export const role = 'plan-owner';\n",
    });
    expect(exceptRule8(runCheck(root))).toEqual([
      'packages/domain/src/map-capabilities.ts: declares no V03_VOCABULARY literals, so map vocabulary cannot be confined',
    ]);
  });
});

describe('route parameters are read once, by the route layer (rule 9, R-H7)', () => {
  /** Fastify's request type, as the server's code sees it: a property `params` of `FastifyRequest`. */
  const FASTIFY = {
    'node_modules/fastify/package.json': JSON.stringify({
      name: 'fastify',
      types: './types/request.d.ts',
    }),
    'node_modules/fastify/types/request.d.ts': [
      'export interface FastifyRequest<G = unknown> { params: unknown; body: unknown; query: unknown }',
      // A route schema's `params` is not a request's.
      'export interface FastifySchema { params?: unknown }',
      'export interface FastifyInstance {',
      '  get<G = unknown>(url: string, handler: (request: FastifyRequest<G>) => unknown): void;',
      '}',
      // Fastify's own route generic declares an optional `Params`: naming it types nothing.
      'export interface RouteGenericInterface { Params?: unknown; Body?: unknown }',
      // Real Fastify puts the route generic fourth in a reply, a handler method and options.
      'export interface FastifyReply<A = unknown, B = unknown, C = unknown, G = unknown> {',
      '  send(payload: unknown): void;',
      '}',
      '',
    ].join('\n'),
  };
  const reads = (file, line) =>
    `${file}:${line}: reads a request's path parameters; read the values the daemon parsed with paramsOf (R-H7)`;
  const typed = (file, line) =>
    `${file}:${line}: types a request's path parameters (\`Params\`); declare them in the route's config and read them with paramsOf (R-H7)`;

  it("finds every way a production module reads a request's params, whatever the request is called", () => {
    const root = workspace({
      ...FASTIFY,
      // The route layer parses them for every route: the one module that may.
      'apps/server/src/routes/route-access.ts': [
        "import type { FastifyRequest } from 'fastify';",
        'export const parse = (request: FastifyRequest) => request.params;',
        '',
      ].join('\n'),
      'apps/server/src/routes/handlers.ts': [
        "import type { FastifyRequest } from 'fastify';",
        'export function a(request: FastifyRequest) {',
        '  return (request.params as { id: string }).id;',
        '}',
        "export const b = (req: FastifyRequest) => req['params'];",
        'export function c(request: FastifyRequest) {',
        '  const { params } = request;',
        '  return params;',
        '}',
        'export const d = ({ params }: FastifyRequest) => params;',
        'export function e(request: FastifyRequest) {',
        '  const r = request;',
        '  return r?.params;',
        '}',
        'export function f(request: FastifyRequest) {',
        '  const { params: renamed } = request;',
        '  return renamed;',
        '}',
        // Another object's `params`, and a request's other members, are not path parameters.
        'export const g = (options: { params: string }, request: FastifyRequest) => [',
        '  options.params,',
        '  request.body,',
        '  request.query,',
        '];',
        '',
      ].join('\n'),
      // A route schema's `params`, and a local type that only shares Fastify's name, are not one.
      'apps/server/src/routes/lookalikes.ts': [
        "import type { FastifySchema } from 'fastify';",
        'interface FastifyRequest { params: string }',
        'export const schemaParams = (schema: FastifySchema) => schema.params;',
        'export const local = (request: FastifyRequest) => request.params;',
        '',
      ].join('\n'),
      // Typing a route's parameters is what lets a handler read them unparsed: reported too.
      'apps/server/src/routes/typed.ts': [
        "import type { FastifyInstance, FastifyRequest } from 'fastify';",
        'export const register = (app: FastifyInstance) =>',
        "  app.get<{ Params: { id: string } }>('/api/x/:id', () => 'ok');",
        'export type Typed = FastifyRequest<{ Params: { id: string } }>;',
        'export type Untyped = FastifyRequest<{ Body: { id: string } }>;',
        'export const other = <G,>(value: G) => value;',
        "export const notFastify = other<{ Params: string }>({ Params: 'x' });",
        // Through an alias, an interface, an intersection or a heritage clause: decided by type.
        'type Aliased = { Params: { id: string } };',
        'interface Declared { Params: { id: string } }',
        'const helper = (req: { readonly params: { readonly id: string } }) => req.params.id;',
        'export const viaAlias = (app: FastifyInstance) =>',
        "  app.get<Aliased>('/api/y/:id', (request) => helper(request));",
        "export const viaInterface = (app: FastifyInstance) => app.get<Declared>('/api/z/:id', () => 1);",
        'export type Intersected = FastifyRequest<Aliased & { Body: string }>;',
        'export interface Extended extends FastifyRequest<Declared> {}',
        'export type BodyOnly = FastifyRequest<{ Body: string } & { Querystring: string }>;',
        "import type * as F from 'fastify';",
        'export type Spaced = F.FastifyRequest<Aliased>;',
        'export type Fourth = F.FastifyReply<unknown, unknown, unknown, Aliased>;',
        'export type First = F.FastifyReply<Aliased, unknown, unknown, unknown>;',
        // Fastify's route generic, and a helper generic over it, type nothing of a route's own.
        'export type Generic = FastifyRequest<F.RouteGenericInterface>;',
        'export const anyRoute = <G extends F.RouteGenericInterface>(request: FastifyRequest<G>) =>',
        '  request.body;',
        // A route's own `Params` beside Fastify's: through an intersection or an extension.
        'export type Mixed = FastifyRequest<F.RouteGenericInterface & Aliased>;',
        'interface Route extends F.RouteGenericInterface { Params: { id: string } }',
        'export type Extending = FastifyRequest<Route>;',
        '',
      ].join('\n'),
      // Tests may read what a request carried.
      'apps/server/test/handlers.test.ts': [
        "import type { FastifyRequest } from 'fastify';",
        'export const seen = (request: FastifyRequest) => request.params;',
        '',
      ].join('\n'),
    });
    expect(exceptRule8(runCheck(root))).toEqual([
      reads('apps/server/src/routes/handlers.ts', 3),
      reads('apps/server/src/routes/handlers.ts', 5),
      reads('apps/server/src/routes/handlers.ts', 7),
      reads('apps/server/src/routes/handlers.ts', 10),
      reads('apps/server/src/routes/handlers.ts', 13),
      reads('apps/server/src/routes/handlers.ts', 16),
      typed('apps/server/src/routes/typed.ts', 3),
      typed('apps/server/src/routes/typed.ts', 4),
      typed('apps/server/src/routes/typed.ts', 12),
      typed('apps/server/src/routes/typed.ts', 13),
      typed('apps/server/src/routes/typed.ts', 14),
      typed('apps/server/src/routes/typed.ts', 15),
      typed('apps/server/src/routes/typed.ts', 18),
      typed('apps/server/src/routes/typed.ts', 19),
      typed('apps/server/src/routes/typed.ts', 20),
      typed('apps/server/src/routes/typed.ts', 24),
      typed('apps/server/src/routes/typed.ts', 26),
    ]);
  });

  it('pins what it does not catch: a member it cannot name, a helper typed by shape', () => {
    const root = workspace({
      ...FASTIFY,
      'apps/server/src/routes/evasive.ts': [
        "import type { FastifyRequest } from 'fastify';",
        "const key = 'par' + 'ams';",
        'export const a = (request: FastifyRequest) => (request as never)[key];',
        "export const b = (request: FastifyRequest) => Reflect.get(request, 'params');",
        // A helper typed by shape reads what it is handed; handing it a request needs the
        // route's `Params` typed, which the rule reports.
        'export const c = (req: { readonly params: { readonly id: string } }) => req.params.id;',
        '',
      ].join('\n'),
    });
    expect(exceptRule8(runCheck(root))).toEqual([]);
  });
});

describe('domain, contracts and storage export only what another module takes (rule 8, DATA-15)', () => {
  const unimported = (name, file) =>
    `\`${name}\` is exported by \`${file}\` but no other module imports it; drop the \`export\` (DATA-15)`;
  const onlyReexported = (name, file, reexports) =>
    `\`${name}\` is exported by \`${file}\` but no other module imports it, only re-exports it (${reexports.map((path) => `\`${path}\``).join(', ')}); drop the re-exports and the \`export\` (DATA-15)`;
  const kept = (name, file, what) => `\`${name}\` is kept exported by \`${file}\`${what} (DATA-15)`;
  const DOMAIN = {
    'packages/domain/package.json': JSON.stringify({
      name: '@craftingtable/domain',
      exports: {
        '.': { types: './src/index.ts', source: './src/index.ts', default: './dist/index.js' },
      },
    }),
    'packages/domain/src/index.ts': [
      "export * from './vocabulary.js';",
      "export * from './self.js';",
      "export { plumbed } from './plumbing.js';",
      "export * as nested from './nested.js';",
      '',
    ].join('\n'),
  };

  it('finds an export no other module takes, and counts each way another module takes one', () => {
    const root = workspace({
      ...DOMAIN,
      'packages/domain/src/vocabulary.ts': [
        'export const unused = 1;',
        'export const ownOnly = 2;',
        'export const viaBarrel = ownOnly + 1;',
        'export const aliased = 3;',
        'export const viaTest = 4;',
        'export const viaScript = 5;',
        'export const viaNamespace = 6;',
        'export type ViaQualifiedName = string;',
        'export const onlyWholesale = 7;',
        'export const viaReexport = 8;',
        'export const viaDynamic = 9;',
        'export type ViaImportType = number;',
        'export const viaAwaited = 10;',
        'export const viaDynamicNamespace = 11;',
        'export const viaE2e = 12;',
        'export const viaElementAccess = 13;',
        'export const viaNamespaceDestructure = 14;',
        'export const viaTypeofImport = 15;',
        'export const viaImportEquals = 16;',
        'export const viaRequire = 17;',
        'export type ViaDeclarationFile = string;',
        'export const viaOtherPackage = 18;',
        'export const viaTypeofNamespace = 19;',
        'export const shadowed = 27;',
        '',
      ].join('\n'),
      // Re-exported by name within its own package: barrel plumbing, not a use.
      'packages/domain/src/plumbing.ts': 'export const plumbed = 20;\n',
      // A namespace re-exported whole (`export * as nested`): each name read of it is a use.
      'packages/domain/src/nested.ts': [
        'export const viaStarAs = 21;',
        'export const viaStarAsChain = 22;',
        'export const nestedUnused = 23;',
        'export const viaDestructuredNamespace = 26;',
        'export type ViaImportTypeChain = number;',
        '',
      ].join('\n'),
      // Taken by its own module through the barrel: not another module's use.
      'packages/domain/src/self.ts':
        "import { selfOnly as again } from './index.js';\nexport const selfOnly = 24;\nvoid again;\n",
      'packages/domain/src/default.ts': 'export default function viaDefault() {\n  return 25;\n}\n',
      // Production, through the package's barrel; a namespace used whole takes no name.
      'apps/server/src/index.ts': [
        "import { aliased as renamed, nested, viaBarrel } from '@craftingtable/domain';",
        "import * as domain from '@craftingtable/domain';",
        "import viaDefault from '../../../packages/domain/src/default.js';",
        "import { viaOtherPackage } from '@craftingtable/contracts';",
        'export const a = [viaBarrel, renamed, domain.viaNamespace, Object.keys(domain), viaDefault];',
        "export const b = [domain['viaElementAccess'], nested.viaStarAs, domain.nested.viaStarAsChain];",
        'const { viaNamespaceDestructure, nested: inner } = domain;',
        'export const d = [viaNamespaceDestructure, viaOtherPackage, inner.viaDestructuredNamespace];',
        "export type B = domain.ViaQualifiedName | import('@craftingtable/domain').ViaImportType;",
        "export type C = import('@craftingtable/domain').nested.ViaImportTypeChain;",
        "export type T = (typeof import('@craftingtable/domain'))['viaTypeofImport'];",
        "export type U = (typeof domain)['viaTypeofNamespace'];",
        // A parameter named like the namespace is not the namespace.
        'export const f = (domain: { shadowed: number }) => domain.shadowed;',
        'export const c = async () => {',
        "  const { viaDynamic } = await import('@craftingtable/domain');",
        "  const later = await import('@craftingtable/domain');",
        "  return [viaDynamic, (await import('@craftingtable/domain')).viaAwaited, later.viaDynamicNamespace];",
        '};',
        '',
      ].join('\n'),
      'apps/server/src/required.cts': [
        "import domain = require('@craftingtable/domain');",
        "export const r = [domain.viaImportEquals, require('@craftingtable/domain').viaRequire];",
        '',
      ].join('\n'),
      'apps/server/src/ambient.d.ts':
        "import type { ViaDeclarationFile } from '@craftingtable/domain';\nexport type X = ViaDeclarationFile;\n",
      'packages/domain/test/vocabulary.test.ts':
        "import { viaTest } from '../src/vocabulary.js';\nexport { viaTest };\n",
      'scripts/tool.mjs':
        "import { viaScript } from '@craftingtable/domain';\nexport { viaScript };\n",
      'e2e/flow.spec.ts': "import { viaE2e } from '@craftingtable/domain';\nexport { viaE2e };\n",
      // Another package's surface: what is imported through it is used, what is only re-exported
      // by it is not.
      'packages/contracts/package.json': JSON.stringify({
        name: '@craftingtable/contracts',
        exports: { '.': { source: './src/index.ts', default: './dist/index.js' } },
      }),
      'packages/contracts/src/index.ts':
        "export { viaOtherPackage, viaReexport } from '@craftingtable/domain';\n",
    });
    // Linked as pnpm links the workspace, so the compiler resolves the contracts' re-export.
    mkdirSync(join(root, 'packages/contracts/node_modules/@craftingtable'), { recursive: true });
    symlinkSync(
      '../../../domain',
      join(root, 'packages/contracts/node_modules/@craftingtable/domain'),
    );
    expect(runCheck(root).sort()).toEqual(
      [
        unimported('unused', 'packages/domain/src/vocabulary.ts'),
        unimported('ownOnly', 'packages/domain/src/vocabulary.ts'),
        unimported('shadowed', 'packages/domain/src/vocabulary.ts'),
        unimported('onlyWholesale', 'packages/domain/src/vocabulary.ts'),
        unimported('nestedUnused', 'packages/domain/src/nested.ts'),
        unimported('selfOnly', 'packages/domain/src/self.ts'),
        onlyReexported('plumbed', 'packages/domain/src/plumbing.ts', [
          'packages/domain/src/index.ts',
        ]),
        onlyReexported('viaReexport', 'packages/domain/src/vocabulary.ts', [
          'packages/contracts/src/index.ts',
        ]),
      ].sort(),
    );
  });

  it('keeps a listed export only with its reason, and fails an exception no longer needed', () => {
    const emitted = 'packages/storage/src/emitted.ts';
    const root = workspace({
      [emitted]: [
        'export interface Kept { a: number }',
        'export interface Unreasoned { b: number }',
        'export const used = 1;',
        '',
      ].join('\n'),
      'apps/server/src/index.ts': `import { used } from '../../../${emitted.replace('.ts', '.js')}';\nexport { used };\n`,
    });
    const exceptions = new Map([
      [
        emitted,
        new Map([
          ['Kept', 'the inferred return type of a server function names it'],
          ['Unreasoned', ' '],
          ['used', 'imported since'],
          ['Gone', 'deleted since'],
        ]),
      ],
      // A module this workspace does not have.
      ['packages/storage/src/absent.ts', new Map([['Elsewhere', 'another workspace']])],
    ]);
    expect(inspectWorkspace(root, exceptions).findings.sort()).toEqual(
      [
        kept('Unreasoned', emitted, ' without a reason; say what needs it, or drop the `export`'),
        ...['used', 'Gone'].map((name) =>
          kept(
            name,
            emitted,
            ', which exports no such declaration that no other module imports; drop the exception',
          ),
        ),
      ].sort(),
    );
    expect(runCheck(root).sort()).toEqual(
      [unimported('Kept', emitted), unimported('Unreasoned', emitted)].sort(),
    );
  });
});

describe("the daemon's modules import one another without cycles (rule 10, R-B7)", () => {
  const cycle = (members, round) =>
    `${members[0]}: import cycle among ${members.length} module${members.length === 1 ? '' : 's'} (${members.join(', ')}), one path round it ${round.join(' → ')}; move what they share into a module none of them imports back (R-B7)`;
  const inspect = (files, known = []) => inspectWorkspace(workspace(files), EMITTED_EXPORTS, known);

  it('finds a cycle through value imports, type-only imports and import() types, with a path round it', () => {
    const typed = inspect({
      'apps/server/src/index.ts': "import { a } from './a.js';\nexport const main = a;\n",
      'apps/server/src/a.ts':
        "import { b } from './b.js';\nexport const a = b + 1;\nexport type A = number;\n",
      'apps/server/src/b.ts':
        "import type { C } from './c.js';\nexport const b = 1;\nexport type B = C;\n",
      'apps/server/src/c.ts': "export type C = import('./a.js').A;\n",
    });
    expect(exceptRule8(typed.findings)).toEqual([
      cycle(
        ['apps/server/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/c.ts'],
        [
          'apps/server/src/a.ts',
          'apps/server/src/b.ts',
          'apps/server/src/c.ts',
          'apps/server/src/a.ts',
        ],
      ),
    ]);
  });

  it('names every module of a cycle, and the shortest path round it from the first', () => {
    // a → b → a is the shortest of the paths round a; c and d are in the cycle too.
    const { findings } = inspect({
      'apps/server/src/index.ts': "import { a } from './a.js';\nexport const main = a;\n",
      'apps/server/src/a.ts':
        "import { b } from './b.js';\nimport { c } from './c.js';\nexport const a = () => b() + c();\n",
      'apps/server/src/b.ts': "import { a } from './a.js';\nexport const b = () => (a ? 1 : 0);\n",
      'apps/server/src/c.ts': "import { d } from './d.js';\nexport const c = () => d();\n",
      'apps/server/src/d.ts': "import { a } from './a.js';\nexport const d = () => (a ? 1 : 0);\n",
    });
    expect(exceptRule8(findings)).toEqual([
      cycle(
        [
          'apps/server/src/a.ts',
          'apps/server/src/b.ts',
          'apps/server/src/c.ts',
          'apps/server/src/d.ts',
        ],
        ['apps/server/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/a.ts'],
      ),
    ]);
  });

  it('allows a listed cycle, and finds a listed cycle that no longer exists or has grown', () => {
    const files = {
      'apps/server/src/index.ts':
        "import { a } from './a.js';\nimport { d } from './d.js';\nexport const main = a + d;\n",
      'apps/server/src/a.ts':
        "import type { B } from './b.js';\nexport const a = 1;\nexport type A = B;\n",
      'apps/server/src/b.ts': "import { a } from './a.js';\nexport type B = typeof a;\n",
      'apps/server/src/d.ts': 'export const d = 1;\n',
    };
    const pair = ['apps/server/src/b.ts', 'apps/server/src/a.ts'];
    expect(exceptRule8(inspect(files, [pair]).findings)).toEqual([]);
    const gone = ['apps/server/src/a.ts', 'apps/server/src/d.ts'];
    expect(exceptRule8(inspect(files, [pair, gone]).findings)).toEqual([
      'apps/server/src/a.ts: KNOWN_IMPORT_CYCLES lists apps/server/src/a.ts, apps/server/src/d.ts, which no longer form exactly one import cycle; update the list (R-B7)',
    ]);
    // A third module joins the listed pair's cycle: the set is no longer the one listed.
    const grown = inspect(
      {
        ...files,
        'apps/server/src/b.ts':
          "import { a } from './a.js';\nimport { d } from './d.js';\nexport type B = typeof a;\nexport const e = d;\n",
        'apps/server/src/d.ts':
          "import type { B } from './b.js';\nexport const d = 1;\nexport type D = B;\n",
      },
      [pair],
    );
    expect(exceptRule8(grown.findings).sort()).toEqual(
      [
        cycle(
          ['apps/server/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/d.ts'],
          ['apps/server/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/a.ts'],
        ),
        'apps/server/src/a.ts: KNOWN_IMPORT_CYCLES lists apps/server/src/a.ts, apps/server/src/b.ts, which no longer form exactly one import cycle; update the list (R-B7)',
      ].sort(),
    );
  });

  it("leaves the packages', the browser's and the tests' cycles alone", () => {
    const { findings } = inspect({
      'apps/web/src/a.ts': "import { b } from './b.js';\nexport const a = () => b();\n",
      'apps/web/src/b.ts': "import { a } from './a.js';\nexport const b = () => (a ? 1 : 0);\n",
      'apps/server/src/index.ts': 'export const main = 1;\n',
      'apps/server/test/a.test.ts':
        "import { b } from './b.js';\nimport { it } from 'vitest';\nit('a', () => b);\nexport const a = 1;\n",
      'apps/server/test/b.ts': "import { a } from './a.test.js';\nexport const b = a;\n",
      'packages/agents/src/index.ts': "import { b } from './b.js';\nexport const a = b;\n",
      'packages/agents/src/b.ts': "import { a } from './index.js';\nexport const b = () => a;\n",
    });
    expect(findings.filter((finding) => finding.includes('import cycle'))).toEqual([]);
  });
});

describe('the cycle core reaches no service and no file or process access (rule 11, R-B7)', () => {
  const core = 'apps/server/src/services/cycle/core';
  const reaches = (file, path, what) =>
    `${file}: imports "${what}", and the cycle core reaches it by value imports (${path.join(' → ')}); keep file and process access out of the core's reach (R-B7)`;
  const service = (file, path) =>
    `${file}: a service the cycle core reaches by value imports (${path.join(' → ')}); the core decides and the services act, so take what it needs from a module of its own (R-B7)`;
  const coreFindings = (findings) =>
    findings.filter((finding) => finding.includes('the cycle core reaches'));

  it('finds file and process access and services the core reaches by value imports, with the path', () => {
    const { findings } = inspectWorkspace(
      workspace({
        'apps/server/src/index.ts':
          "import { decide } from './services/cycle/core/machine.js';\nexport const main = decide;\n",
        [`${core}/machine.ts`]:
          "import { read } from '../../journal.js';\nimport { act } from '../../thing-service.js';\nexport const decide = () => read() + act();\n",
        'apps/server/src/services/journal.ts':
          "import { readFileSync } from 'node:fs';\nexport const read = () => readFileSync('x', 'utf8');\n",
        'apps/server/src/services/thing-service.ts':
          "import { spawn } from 'child_process';\nexport const act = () => String(spawn);\n",
      }),
      EMITTED_EXPORTS,
      [],
    );
    expect(coreFindings(findings).sort()).toEqual(
      [
        reaches(
          'apps/server/src/services/journal.ts',
          [`${core}/machine.ts`, 'apps/server/src/services/journal.ts'],
          'node:fs',
        ),
        reaches(
          'apps/server/src/services/thing-service.ts',
          [`${core}/machine.ts`, 'apps/server/src/services/thing-service.ts'],
          'child_process',
        ),
        service('apps/server/src/services/thing-service.ts', [
          `${core}/machine.ts`,
          'apps/server/src/services/thing-service.ts',
        ]),
      ].sort(),
    );
  });

  it('follows only value imports, within the daemon', () => {
    const { findings } = inspectWorkspace(
      workspace({
        'apps/server/src/index.ts':
          "import { decide } from './services/cycle/core/machine.js';\nexport const main = decide;\n",
        [`${core}/machine.ts`]: [
          "import type { Journal } from '../../journal.js';",
          "import { type Thing } from '../../thing-service.js';",
          "import { digest } from '@scratch/agents';",
          "export type Kind = import('../../writer.js').Written;",
          'export const decide = (j: Journal, t: Thing, k: Kind) => [j, t, k, digest()];',
          '',
        ].join('\n'),
        'apps/server/src/services/journal.ts':
          "import { readFileSync } from 'node:fs';\nexport type Journal = string;\nexport const read = () => readFileSync('x', 'utf8');\n",
        'apps/server/src/services/thing-service.ts': 'export type Thing = number;\n',
        'apps/server/src/services/writer.ts':
          "import { writeFileSync } from 'node:fs';\nexport type Written = boolean;\nexport const write = () => writeFileSync('x', 'y');\n",
        'packages/agents/package.json':
          '{"name":"@scratch/agents","type":"module","exports":"./src/index.ts"}',
        'packages/agents/src/index.ts':
          "import { readFileSync } from 'node:fs';\nexport const digest = () => readFileSync('x', 'utf8');\n",
      }),
      EMITTED_EXPORTS,
      [],
    );
    expect(coreFindings(findings)).toEqual([]);
  });

  // Increment 5 review, LOW-1: a declaration that imports a value beside its types is followed.
  it('follows a mixed import, a default beside types, a mixed re-export and an import require', () => {
    const { findings } = inspectWorkspace(
      workspace({
        'apps/server/src/index.ts':
          "import { decide } from './services/cycle/core/machine.js';\nexport const main = decide;\n",
        [`${core}/machine.ts`]: [
          "import { type Kind, read } from '../../journal.js';",
          "import load, { type Loaded } from '../../loader.js';",
          "export { type Emitted, emit } from '../../emitter.js';",
          "import legacy = require('../../legacy.js');",
          'export const decide = (k: Kind, l: Loaded) => [k, l, read(), load(), legacy];',
          '',
        ].join('\n'),
        'apps/server/src/services/journal.ts':
          "import { readFileSync } from 'node:fs';\nexport type Kind = string;\nexport const read = () => readFileSync('x', 'utf8');\n",
        'apps/server/src/services/loader.ts':
          "import { readFile } from 'node:fs/promises';\nexport type Loaded = string;\nexport default () => readFile('x', 'utf8');\n",
        'apps/server/src/services/emitter.ts':
          "import { writeFileSync } from 'node:fs';\nexport type Emitted = boolean;\nexport const emit = () => writeFileSync('x', 'y');\n",
        'apps/server/src/services/legacy.ts':
          "import { spawn } from 'node:child_process';\nexport const run = () => String(spawn);\n",
      }),
      EMITTED_EXPORTS,
      [],
    );
    const via = (file) => [`${core}/machine.ts`, `apps/server/src/services/${file}`];
    expect(coreFindings(findings).sort()).toEqual(
      [
        reaches('apps/server/src/services/journal.ts', via('journal.ts'), 'node:fs'),
        reaches('apps/server/src/services/loader.ts', via('loader.ts'), 'node:fs/promises'),
        reaches('apps/server/src/services/emitter.ts', via('emitter.ts'), 'node:fs'),
        reaches('apps/server/src/services/legacy.ts', via('legacy.ts'), 'node:child_process'),
      ].sort(),
    );
  });

  // Increment 5 review, NIT-1: the path named is the shortest from the core.
  it('names the shortest path from the core', () => {
    const { findings } = inspectWorkspace(
      workspace({
        'apps/server/src/index.ts':
          "import { decide } from './services/cycle/core/machine.js';\nexport const main = decide;\n",
        [`${core}/machine.ts`]:
          "import { far } from '../../far.js';\nimport { read } from '../../journal.js';\nexport const decide = () => far() + read();\n",
        'apps/server/src/services/far.ts':
          "import { near } from './near.js';\nexport const far = () => near();\n",
        'apps/server/src/services/near.ts':
          "import { read } from './journal.js';\nexport const near = () => read();\n",
        'apps/server/src/services/journal.ts':
          "import { readFileSync } from 'node:fs';\nexport const read = () => readFileSync('x', 'utf8');\n",
      }),
      EMITTED_EXPORTS,
      [],
    );
    expect(coreFindings(findings)).toEqual([
      reaches(
        'apps/server/src/services/journal.ts',
        [`${core}/machine.ts`, 'apps/server/src/services/journal.ts'],
        'node:fs',
      ),
    ]);
  });
});

describe('only the replay tool pins the host a replay runs as (rule 12, R-B4b)', () => {
  const pinned = (file) =>
    `${file}: imports the replay host pin (${REPLAY_HOST_PIN}); only the replay tool sets it and only the workstation reads it, so the daemon compares native approvals with the live host digest (R-B4b)`;
  const pin =
    'let pinned: string | undefined;\nexport const pinReplayHost = (d?: string) => { pinned = d; };\nexport const replayHost = () => pinned;\n';

  it('finds any other production module importing the pin, by value or by type', () => {
    const { findings } = inspectWorkspace(
      workspace({
        'apps/server/src/controller-replay.ts':
          "import { pinReplayHost } from './services/replay-host.js';\npinReplayHost('x');\n",
        'apps/server/src/services/replay-host.ts': pin,
        'apps/server/src/services/workstation.ts':
          "import { replayHost } from './replay-host.js';\nexport const workstationDigest = () => replayHost() ?? 'live';\n",
        'apps/server/src/index.ts':
          "import { workstationDigest } from './services/workstation.js';\nexport const main = workstationDigest;\n",
        'apps/server/src/services/policy.ts':
          "import { pinReplayHost } from './replay-host.js';\nexport const policy = () => pinReplayHost('y');\n",
        'apps/server/src/services/typed.ts':
          "export type Pin = typeof import('./replay-host.js').pinReplayHost;\n",
        'apps/server/src/services/again.ts': "export { replayHost } from './replay-host.js';\n",
        // A test may set the pin.
        'apps/server/test/replay-host.test.ts':
          "import { pinReplayHost } from '../src/services/replay-host.js';\npinReplayHost(undefined);\n",
      }),
      EMITTED_EXPORTS,
      [],
    );
    expect(findings.filter((finding) => finding.includes('replay host pin')).sort()).toEqual(
      [
        pinned('apps/server/src/services/again.ts'),
        pinned('apps/server/src/services/policy.ts'),
        pinned('apps/server/src/services/typed.ts'),
      ].sort(),
    );
  });

  it('lets each listed user take only its own binding, by name, and hand none of it on', () => {
    const handsOn = (file) =>
      `${file}: takes more of the replay host pin (${REPLAY_HOST_PIN}) than its own \`${REPLAY_HOST_USERS.get(file)}\`, or hands it on; import that binding by name alone (R-B4b)`;
    const tool = 'apps/server/src/controller-replay.ts';
    const workstation = 'apps/server/src/services/workstation.ts';
    const findingsWith = (files) =>
      inspectWorkspace(
        workspace({
          'apps/server/src/services/replay-host.ts': pin,
          'apps/server/src/index.ts':
            "import { workstationDigest } from './services/workstation.js';\nexport const main = workstationDigest;\n",
          [tool]:
            "import { pinReplayHost } from './services/replay-host.js';\npinReplayHost('x');\n",
          ...files,
        }),
        EMITTED_EXPORTS,
        [],
      ).findings.filter((finding) => finding.includes('replay host pin'));
    // The workstation reads the pin; the setter is the tool's alone.
    expect(
      findingsWith({
        [workstation]:
          "import { pinReplayHost, replayHost } from './replay-host.js';\nexport const workstationDigest = () => (pinReplayHost('y'), replayHost() ?? 'live');\n",
      }),
    ).toEqual([handsOn(workstation)]);
    // A re-export from a listed user, in either form, or a namespace, hands the pin on.
    expect(
      findingsWith({
        [workstation]:
          "import { replayHost } from './replay-host.js';\nexport const workstationDigest = () => replayHost() ?? 'live';\nexport { replayHost };\n",
      }),
    ).toEqual([
      `${workstation}:3: re-exports the replay host pin's binding; it must not leave this module (R-B4b)`,
    ]);
    expect(
      findingsWith({
        [workstation]:
          "export { replayHost } from './replay-host.js';\nexport const workstationDigest = () => 'live';\n",
      }),
    ).toEqual([handsOn(workstation)]);
    expect(
      findingsWith({
        [tool]: "import * as host from './services/replay-host.js';\nhost.pinReplayHost('x');\n",
        [workstation]: "export const workstationDigest = () => 'live';\n",
      }),
    ).toEqual([handsOn(tool)]);
    // The two bindings as built pass.
    expect(
      findingsWith({
        [workstation]:
          "import { replayHost } from './replay-host.js';\nexport const workstationDigest = () => replayHost() ?? 'live';\n",
      }),
    ).toEqual([]);
  });
});

it('passes on the real repository, having read and classified its modules', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { findings, classes, vocabulary } = inspectWorkspace(root);
  expect(findings).toEqual([]);
  // Rule 7 found the vocabulary table: a moved module would otherwise pass vacuously.
  expect(vocabulary).toEqual(
    expect.arrayContaining(['repository-maintainer', 'controlled-native-test-host']),
  );
  const count = (kind) => [...classes.values()].filter((c) => c === kind).length;
  // The projects were read: an empty file set would pass vacuously.
  expect(count('production')).toBeGreaterThan(400);
  expect(count('test')).toBeGreaterThan(200);
  for (const path of PROCESS_AUTHORITY.keys()) expect(classes.get(path)).toBe('production');
  // Rule 8's exceptions name production modules: one for a moved module would pass vacuously.
  for (const path of EMITTED_EXPORTS.keys()) expect(classes.get(path)).toBe('production');
  expect(classes.get('apps/server/src/index.ts')).toBe('production');
  // Rule 12 names the pin and its two users: a moved module would pass vacuously.
  for (const path of [REPLAY_HOST_PIN, ...REPLAY_HOST_USERS.keys()])
    expect(classes.get(path)).toBe('production');
  // Rule 11 starts from the cycle core's modules: a moved core would pass vacuously.
  expect(classes.get('apps/server/src/services/cycle/core/machine.ts')).toBe('production');
  // Rule 10's listed cycles name the daemon's production modules: a moved one would pass vacuously.
  for (const path of KNOWN_IMPORT_CYCLES.flat()) expect(classes.get(path)).toBe('production');
  // Run by a package script, and imported by its own test.
  expect(classes.get('apps/server/src/db-verify.ts')).toBe('production');
  expect(classes.get('apps/web/src/test-setup.ts')).toBe('test');
  expect(classes.get('apps/server/test/execution-test-support.ts')).toBe('test-support');
  // Test support by what imports it, not by its name.
  expect(classes.get('packages/storage/test/migration-preservation.ts')).toBe('test-support');
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

describe('the gaps the verification review found', () => {
  /**
   * `process` and `globalThis` are read only as `.name` of a member that loads nothing; any
   * other use (an alias, a destructure, an argument, a computed member) could reach a loader.
   * `node:module`, a URL specifier and a `.constructor(…)` call load code by other names (L-1).
   */
  it('catches every other way to reach a loader or run text', () => {
    const at = (file) => `apps/server/src/${file}`;
    const root = workspace({
      [at('alias.ts')]:
        "const p = process;\nexport const a = (p as any)['getBuiltin' + 'Module']('x');\n",
      [at('destructure.ts')]: 'const { binding } = process as any;\nexport { binding };\n',
      [at('argument.ts')]:
        "export const d = Object.getOwnPropertyDescriptor(process, 'binding');\n",
      [at('global-process.ts')]: "export const c = (globalThis as any).process.binding('x');\n",
      [at('global-text.ts')]: [
        "export const g = globalThis.eval('1');",
        "export const h = new globalThis.Function('return 1');",
        'const t = globalThis;',
        "export const i = (() => {}).constructor('return 1');",
        '',
      ].join('\n'),
      [at('module.ts')]:
        "import { Module } from 'node:module';\nexport const e = (Module as any)._load('x');\n",
      [at('data.ts')]: [
        "import 'data:text/javascript,1';",
        "export const j = await import('data:text/javascript,export default 1');",
        '',
      ].join('\n'),
      [at('plain.ts')]: [
        'export const home = process.env.HOME;',
        "export const argv = process['argv'];",
        'process.exitCode = 0;',
        "export const node = typeof process !== 'undefined';",
        'export type Env = typeof process.env;',
        'export const later = globalThis.setTimeout;',
        '',
      ].join('\n'),
    });
    expect(runCheck(root).sort()).toEqual(
      [
        computed(at('alias.ts'), 1, 'process as a value'),
        computed(at('destructure.ts'), 1, 'process as a value'),
        computed(at('argument.ts'), 1, 'process as a value'),
        computed(at('global-process.ts'), 1, 'process.binding'),
        computed(at('global-text.ts'), 1, 'globalThis.eval'),
        computed(at('global-text.ts'), 2, 'globalThis.Function'),
        computed(at('global-text.ts'), 3, 'globalThis as a value'),
        computed(at('global-text.ts'), 4, 'constructor()'),
        capability(at('module.ts'), 'node:module'),
        capability(at('data.ts'), 'data:text/javascript,1'),
        capability(at('data.ts'), 'data:text/javascript,export default 1'),
      ].sort(),
    );
  });

  /**
   * A dev-only package with no `source` condition, imported by a test and by production: the
   * import reaches its source whether it is unlinked, or linked and built (M-1).
   */
  it.each(['unlinked', 'linked and built'])(
    'follows a %s package import back to its source',
    (shape) => {
      const files = {
        'packages/devpkg/package.json': JSON.stringify({
          name: '@craftingtable/devpkg',
          main: './dist/index.js',
        }),
        'packages/devpkg/src/index.ts':
          "import { spawn } from 'node:child_process';\nexport { spawn };\n",
        'apps/server/package.json': JSON.stringify({
          name: '@craftingtable/server',
          devDependencies: { '@craftingtable/devpkg': 'workspace:*' },
        }),
        // A test reaches the package's source by path, so only production's import makes it
        // production.
        'apps/server/test/devpkg.test.ts':
          "import { spawn } from '../../../packages/devpkg/src/index.js';\nexport { spawn };\n",
        'apps/server/src/usedev.ts':
          "import { spawn } from '@craftingtable/devpkg';\nexport { spawn };\n",
      };
      if (shape === 'linked and built') {
        files['packages/devpkg/dist/index.d.ts'] = "export { spawn } from 'node:child_process';\n";
        files['packages/devpkg/dist/index.js'] = "export { spawn } from 'node:child_process';\n";
      }
      const root = workspace(files);
      if (shape === 'linked and built') {
        mkdirSync(join(root, 'apps/server/node_modules/@craftingtable'), { recursive: true });
        symlinkSync(
          '../../../../packages/devpkg',
          join(root, 'apps/server/node_modules/@craftingtable/devpkg'),
        );
      }
      const { findings, classes } = inspectWorkspace(root);
      expect(classes.get('packages/devpkg/src/index.ts')).toBe('production');
      expect(findings).toEqual([capability('packages/devpkg/src/index.ts', 'node:child_process')]);
    },
  );
});

describe('when the check cannot read the workspace (L-2)', () => {
  const script = fileURLToPath(new URL('./check-forbidden-scope.mjs', import.meta.url));
  const spawning = "import { spawn } from 'node:child_process';\nexport { spawn };\n";
  /** The command's failure: non-zero, said plainly, with no stack trace. */
  const refused = (root, env = process.env) => {
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8', env });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Forbidden-scope check could not run: ');
    expect(run.stderr).not.toMatch(/TypeError|\n\s+at /);
    return run.stderr;
  };

  it('fails, not passes, when Git lists nothing under apps/ and packages/', () => {
    // A root inside a directory its enclosing repository ignores.
    const outer = mkdtempSync(join(tmpdir(), 'craftingtable-scope-'));
    roots.push(outer);
    writeFileSync(join(outer, '.gitignore'), 'inner/\n');
    expect(spawnSync('git', ['init', '-q'], { cwd: outer }).status).toBe(0);
    const root = join(outer, 'inner');
    workspace({ 'apps/server/src/index.ts': spawning }, { root, git: false });
    expect(refused(root)).toContain('no TypeScript project');
  });

  it('says so when the root is not a Git checkout, or Git is not on PATH', () => {
    const outside = workspace({ 'apps/server/src/index.ts': spawning }, { git: false });
    expect(refused(outside)).toContain('git ls-files');
    const checkout = workspace({ 'apps/server/src/index.ts': spawning });
    expect(refused(checkout, { ...process.env, PATH: '/nonexistent' })).toContain('needs git');
  });
});
