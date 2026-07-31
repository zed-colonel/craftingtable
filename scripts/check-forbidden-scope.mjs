#!/usr/bin/env node
/**
 * Forbidden-scope check (work-items/CT-01.md, AGENTS.md): CraftingTable must
 * not gain runtime dependencies on the Exo Stack (ActionQueue, WorldInterface,
 * Exoskeleton). Scans every workspace manifest's dependency fields and every
 * import/require specifier under the src and structural test directories of
 * apps and packages.
 *
 * Exported functions are unit-tested in check-forbidden-scope.test.mjs; keep
 * the recognized module syntax and those tests in lockstep.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_PATTERNS = [/action-?queue/i, /world-?interface/i, /exoskeleton/i];

/**
 * Modules that give CraftingTable process, real-Git, shell, or vendor-agent
 * authority. Production source rejects them except for the single exact
 * CT-04A1 Git runner path; tests may exercise wider fault proxies and fixtures.
 */
export const FORBIDDEN_CAPABILITY_PATTERNS = [
  /^simple-git$/i,
  /^nodegit$/i,
  /^isomorphic-git$/i,
  /^dugite$/i,
  /^node:child_process$/i,
  /^child_process$/i,
  /^execa$/i,
  /^cross-spawn$/i,
  /^shelljs$/i,
  /^node-pty$/i,
  /^@openai\/.*$/i,
  /^openai$/i,
  /^@anthropic-ai\/.*$/i,
  /^@modelcontextprotocol\/.*$/i,
];

/**
 * Packages that remain uncomposed future/test/authority seams. Composed
 * production packages must not import them (AGENTS.md, CT-04A1).
 */
export const NON_PRODUCTION_PACKAGES = [
  '@craftingtable/agents',
  '@craftingtable/git',
  '@craftingtable/testing',
];

/**
 * The pure planning boundary. It may hash, but it must not reach the
 * filesystem, a process, a socket, a database, or a UI (ADR-012).
 */
export const PLANNING_FORBIDDEN_PATTERNS = [
  /^node:fs(\/.*)?$/,
  /^node:path$/,
  /^node:child_process$/,
  /^node:net$/,
  /^node:http(s)?$/,
  /^node:worker_threads$/,
  /^fastify$/,
  /^@fastify\/.*$/,
  /^react(-dom)?$/,
  /^better-sqlite3$/,
  /^@craftingtable\/(storage|server|web|agents|git|testing)$/,
];

/**
 * CT-04A2a remains an authority-free domain/contracts/storage slice.
 *
 * Node builtins are governed by an allowlist rather than a denylist: a denylist
 * silently admits every builtin nobody thought to name, so bare `fs`, `dns`,
 * `dgram`, `vm`, and `worker_threads` would all pass. A2a production imports
 * exactly one builtin, so the closed set is also the smaller one.
 */
export const A2A_ALLOWED_NODE_BUILTINS = ['crypto'];

/** Structural tests may additionally read fixtures such as the migration SQL. */
export const A2A_TEST_FIXTURE_NODE_BUILTINS = ['fs', 'os', 'path'];

export const A2A_FORBIDDEN_PATTERNS = [
  /^@craftingtable\/git$/,
  /^fastify$/,
  /^@fastify\/.*$/,
  /^@craftingtable\/server$/,
  /^@craftingtable\/web$/,
  /^react(-dom)?$/,
  /(?:^|\/)routes?(?:\/|\.|$)/,
  /(?:^|\/)workspace-events?(?:\/|\.|$)/,
  /(?:^|\/)notifier(?:\/|\.|$)/,
];

/**
 * The builtin a specifier resolves to, or undefined for a package/relative
 * specifier. `node:fs/promises` and bare `fs/promises` both yield `fs`. Any
 * `node:` specifier counts even if this Node release does not list it, so a
 * future builtin cannot enter through the gap.
 */
export function nodeBuiltinName(specifier) {
  const prefixed = specifier.startsWith('node:');
  const root = (prefixed ? specifier.slice('node:'.length) : specifier).split('/')[0];
  if (root.length === 0) {
    return undefined;
  }
  return prefixed || builtinModules.includes(root) ? root : undefined;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
/**
 * The single production Git process authority. `apps` and `packages` ship in
 * the daemon and browser; `scripts` is development and gate tooling that the
 * shipped application must never import. Keeping the two tiers separate is what
 * lets the production claim stay exactly one path.
 */
const GIT_PROCESS_AUTHORITY = 'packages/git/src/command-runner.ts';
const APPLICATION_GROUPS = ['apps', 'packages'];
const DEVELOPMENT_TOOLING_DIRECTORY = 'scripts';

/**
 * Development tooling permitted to spawn a process, each pinned to an exact
 * path and a stated reason. This is gate tooling, not shipped behaviour, so it
 * is deliberately listed separately from the production Git authority.
 */
const DEVELOPMENT_PROCESS_AUTHORITY = new Map([
  [
    'scripts/check-ct04-protected-package.mjs',
    'read-only git lineage resolution for the CT-04A2a A2-PROC-003 control',
  ],
]);
const EXISTING_TEST_CAPABILITY_MODULES = [
  'packages/planning/src/test-support.ts',
  'packages/storage/src/test-support.ts',
  'packages/storage/src/planning-test-support.ts',
  'apps/server/src/test-support.ts',
  'apps/server/src/multipart-test-support.ts',
];

/**
 * Matches the module specifier in all supported syntax:
 *   import x from 'mod';   import { y } from 'mod';   export * from 'mod';
 *   import 'mod';          import('mod')              require('mod')
 * Source comments are removed before this pattern runs so punctuation in a
 * comment cannot hide a real dependency edge and commented-out code cannot
 * create a spurious edge.
 */
export const IMPORT_PATTERN =
  /(?:\bimport\s+(?:type\s+)?(?:[^;'"]*?\s+from\s+)?|\bexport\s+(?:type\s+)?[^;'"]*?\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * B1's complete production target is closed by exact path and exact module
 * specifier. This checks dependency edges only; route/service/command absence
 * is proved separately by the CT-04 protected-package inventory check.
 */
export const B1_ALLOWED_IMPORTS = new Map([
  ['packages/domain/src/workspace-events.ts', new Set(['./ids.js', './repository.js'])],
  [
    'packages/contracts/src/workspace-event.ts',
    new Set(['@craftingtable/domain', 'zod', './ids.js', './repository.js']),
  ],
  [
    'packages/storage/src/types.ts',
    new Set(['@craftingtable/domain', './planning-types.js', './repository-types.js']),
  ],
  [
    'packages/storage/src/repositories/workspace-events.ts',
    new Set(['@craftingtable/domain', 'better-sqlite3', '../types.js']),
  ],
  [
    'apps/web/src/lib/workspace-projection.ts',
    new Set(['@craftingtable/contracts', '@craftingtable/domain']),
  ],
  [
    'apps/web/src/components/ActivityPanel.tsx',
    new Set(['@craftingtable/contracts', '../lib/workspace-projection.js']),
  ],
  [
    'apps/web/src/App.tsx',
    new Set([
      '@craftingtable/contracts',
      '@craftingtable/domain',
      'react',
      './components/ActivityPanel.js',
      './components/AuditPanel.js',
      './components/LoginPage.js',
      './components/SessionPanel.js',
      './components/StatusRegions.js',
      './components/WorkspaceShell.js',
      './features/planning/ImportPlanPage.js',
      './features/planning/PlanVersionPage.js',
      './features/planning/ProjectCards.js',
      './features/planning/ProjectPage.js',
      './features/planning/SourceText.js',
      './features/planning/WorkItemPage.js',
      './lib/api-client.js',
      './lib/auth-state.js',
      './lib/planning-api.js',
      './lib/route.js',
      './lib/use-route.js',
      './lib/use-workspace-event-stream.js',
      './lib/workspace-projection.js',
    ]),
  ],
]);

export function b1DisallowedImports(relativePath, source) {
  const normalized = relativePath.split('\\').join('/');
  const allowed = B1_ALLOWED_IMPORTS.get(normalized);
  if (allowed === undefined) {
    return [];
  }
  return findImports(source).filter((specifier) => !allowed.has(specifier));
}

export function isForbidden(specifier) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier));
}

export function isForbiddenCapability(specifier) {
  return FORBIDDEN_CAPABILITY_PATTERNS.some((pattern) => pattern.test(specifier));
}

export function isNonProductionPackage(specifier) {
  return NON_PRODUCTION_PACKAGES.includes(specifier);
}

export function isForbiddenInPlanning(specifier) {
  return PLANNING_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier));
}

export function isForbiddenInA2a(specifier) {
  const builtin = nodeBuiltinName(specifier);
  if (builtin !== undefined) {
    return !A2A_ALLOWED_NODE_BUILTINS.includes(builtin);
  }
  return A2A_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier));
}

export function isA2aTestFixtureBuiltin(specifier) {
  const builtin = nodeBuiltinName(specifier);
  return builtin !== undefined && A2A_TEST_FIXTURE_NODE_BUILTINS.includes(builtin);
}

export function isA2aSource(path) {
  const normalized = path.split('\\').join('/');
  return (
    /packages\/domain\/src\/repository(?:\.test)?\.ts$/.test(normalized) ||
    /packages\/contracts\/src\/repository(?:\.test)?\.ts$/.test(normalized) ||
    /packages\/storage\/src\/repository[^/]*\.ts$/.test(normalized) ||
    /packages\/storage\/src\/repositories\/repository-registry\/.*\.ts$/.test(normalized)
  );
}

/** True for repository-root development and gate tooling under `scripts/`. */
export function isDevelopmentToolingModule(relativePath) {
  const normalized = relativePath.split('\\').join('/');
  return normalized === DEVELOPMENT_TOOLING_DIRECTORY
    ? false
    : normalized.startsWith(`${DEVELOPMENT_TOOLING_DIRECTORY}/`);
}

/**
 * True when a relative specifier resolves into `scripts/`. Resolved rather than
 * pattern-matched so a package's own `src/scripts/` directory is unaffected and
 * no amount of `../` can smuggle tooling into the shipped application.
 */
export function resolvesIntoDevelopmentTooling(root, importingFile, specifier) {
  if (!specifier.startsWith('.')) {
    return false;
  }
  const target = resolve(dirname(resolve(root, importingFile)), specifier);
  const toolingRoot = resolve(root, DEVELOPMENT_TOOLING_DIRECTORY);
  return target === toolingRoot || target.startsWith(`${toolingRoot}/`);
}

export function hasLiteralCurrentMigrationAssertion(source) {
  return /migrationStatus\.currentVersion\)\.toBe\(\s*\d+\s*\)/.test(source);
}

/**
 * Replaces JavaScript/TypeScript comments with whitespace while preserving
 * newlines and quoted text. Preserving source shape keeps import matching
 * predictable, and preserving quoted text retains the module specifiers that
 * IMPORT_PATTERN extracts. This is intentionally a lexical preprocessing pass,
 * not a second import grammar.
 */
export function stripComments(source) {
  let result = '';
  let state = 'code';
  let quote = '';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        result += character;
        state = 'code';
      } else {
        result += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'code';
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }

    if (state === 'quoted') {
      result += character;
      if (character === '\\' && next !== undefined) {
        result += next;
        index += 1;
      } else if (character === quote) {
        state = 'code';
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      result += character;
      quote = character;
      state = 'quoted';
    } else if (character === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block-comment';
    } else {
      result += character;
    }
  }

  return result;
}

/** Returns every module specifier the source imports. */
export function findImports(source) {
  return [...stripComments(source).matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

/**
 * A NUL byte makes Git classify a text file as binary, which silently removes
 * it from diffs, blame, and merge review. Tracked source must stay reviewable
 * (CT03-R7).
 */
export function findNulByte(buffer) {
  return buffer.indexOf(0);
}

/**
 * True only for structurally placed tests. A production filename containing
 * "test-support" does not acquire test authority.
 */
export function isTestModule(path) {
  const normalized = path.split('\\').join('/');
  return (
    /(?:^|\/)packages\/[^/]+\/test\//.test(normalized) ||
    /\.test\.[cm]?[jt]sx?$/.test(normalized) ||
    EXISTING_TEST_CAPABILITY_MODULES.some(
      (existing) => normalized === existing || normalized.endsWith(`/${existing}`),
    )
  );
}

/** Returns every forbidden module specifier referenced by the source text. */
export function findForbiddenImports(source) {
  return findImports(source).filter((specifier) => isForbidden(specifier));
}

export function findManifestViolations(manifest) {
  const violations = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (isForbidden(name)) {
        violations.push({ field, name });
      }
    }
  }
  return violations;
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}

/** Scans the whole workspace rooted at `root`; returns violation strings. */
export function runCheck(root) {
  const violations = [];

  const checkManifest = (path) => {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    for (const { field, name } of findManifestViolations(manifest)) {
      violations.push(`${relative(root, path)}: ${field} contains forbidden package "${name}"`);
    }
  };

  checkManifest(join(root, 'package.json'));

  const migrations = join(root, 'packages', 'storage', 'migrations');
  if (existsSync(migrations)) {
    walk(migrations, (path) => {
      const nul = findNulByte(readFileSync(path));
      if (nul !== -1) {
        violations.push(
          `${relative(root, path)}: contains a NUL byte at offset ${nul}, which makes Git treat this source as binary`,
        );
      }
    });
  }
  const toolingRoot = join(root, DEVELOPMENT_TOOLING_DIRECTORY);
  if (existsSync(toolingRoot)) {
    walk(toolingRoot, (path) => {
      if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
        return;
      }
      const bytes = readFileSync(path);
      const relativePath = relative(root, path).split('\\').join('/');
      const nul = findNulByte(bytes);
      if (nul !== -1) {
        violations.push(
          `${relativePath}: contains a NUL byte at offset ${nul}, which makes Git treat this source as binary`,
        );
      }
      // A tooling test carries forbidden-looking specifiers as fixtures — that
      // is precisely what this checker's own tests assert against — so only
      // non-test tooling is import-scanned. Both tiers keep the NUL check.
      if (isTestModule(path)) {
        return;
      }
      const source = bytes.toString('utf8');
      for (const specifier of findForbiddenImports(source)) {
        violations.push(`${relativePath}: imports forbidden module "${specifier}"`);
      }
      for (const specifier of findImports(source)) {
        if (!isForbiddenCapability(specifier)) {
          continue;
        }
        const anchored =
          nodeBuiltinName(specifier) === 'child_process' &&
          DEVELOPMENT_PROCESS_AUTHORITY.has(relativePath);
        if (!anchored) {
          violations.push(
            `${relativePath}: development tooling imports unanchored capability module "${specifier}"`,
          );
        }
      }
    });
  }

  for (const group of APPLICATION_GROUPS) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = join(root, group, entry.name);
      checkManifest(join(packageDir, 'package.json'));
      const isPlanningPackage = group === 'packages' && entry.name === 'planning';
      // The seams themselves may reference each other; only *production*
      // packages must stay clear of them.
      const isSeamPackage =
        group === 'packages' && ['agents', 'git', 'testing'].includes(entry.name);
      const checkSource = (path) => {
        if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
          return;
        }
        const bytes = readFileSync(path);
        const relativePath = relative(root, path);
        const nul = findNulByte(bytes);
        if (nul !== -1) {
          violations.push(
            `${relativePath}: contains a NUL byte at offset ${nul}, which makes Git treat this source as binary`,
          );
        }
        const source = bytes.toString('utf8');
        for (const specifier of b1DisallowedImports(relativePath, source)) {
          violations.push(
            `${relativePath}: CT-04A2b1 exact-path source imports unapproved module "${specifier}"`,
          );
        }
        for (const specifier of findForbiddenImports(source)) {
          violations.push(`${relativePath}: imports forbidden module "${specifier}"`);
        }
        if (isA2aSource(relativePath)) {
          for (const specifier of findImports(source)) {
            if (
              isForbiddenInA2a(specifier) &&
              !(isTestModule(path) && isA2aTestFixtureBuiltin(specifier))
            ) {
              violations.push(
                `${relativePath}: CT-04A2a authority-free source imports "${specifier}"`,
              );
            }
          }
        }
        if (isTestModule(path) && hasLiteralCurrentMigrationAssertion(source)) {
          violations.push(
            `${relativePath}: asserts a literal current migration version instead of the discovered supported version`,
          );
        }
        for (const specifier of findImports(source)) {
          if (resolvesIntoDevelopmentTooling(root, relativePath, specifier)) {
            violations.push(
              `${relativePath}: application source imports development tooling "${specifier}"`,
            );
          }
        }
        if (isTestModule(path)) {
          return;
        }
        for (const specifier of findImports(source)) {
          if (isForbiddenCapability(specifier)) {
            const isAnchoredGitProcessAuthority =
              specifier === 'node:child_process' && relativePath === GIT_PROCESS_AUTHORITY;
            if (!isAnchoredGitProcessAuthority) {
              violations.push(`${relativePath}: imports CT-04+ capability module "${specifier}"`);
            }
          }
          if (!isSeamPackage && isNonProductionPackage(specifier)) {
            violations.push(
              `${relativePath}: production source imports non-production seam "${specifier}"`,
            );
          }
          if (isPlanningPackage && isForbiddenInPlanning(specifier)) {
            violations.push(
              `${relativePath}: the pure planning package must not import "${specifier}"`,
            );
          }
        }
      };
      for (const directory of ['src', 'test']) {
        const path = join(packageDir, directory);
        if (existsSync(path)) {
          walk(path, checkSource);
        }
      }
    }
  }

  return violations;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const violations = runCheck(root);
  if (violations.length > 0) {
    console.error('Forbidden-scope check FAILED:');
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  console.log(
    'Forbidden-scope check passed: no Exo Stack dependency, exactly one production\n' +
      'Git process authority, development tooling scanned and separated from the\n' +
      'shipped application, no non-production seam in composed source,\n' +
      'no NUL byte in tracked source, and\n' +
      'the planning package and CT-04A2a repository model stay pure, while\n' +
      'CT-04A2b1 production dependency edges match exact path allowlists.',
  );
}
