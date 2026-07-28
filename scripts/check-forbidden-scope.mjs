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
import { join, relative } from 'node:path';
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

/** CT-04A2a remains an authority-free domain/contracts/storage slice. */
export const A2A_FORBIDDEN_PATTERNS = [
  /^@craftingtable\/git$/,
  /^node:fs(\/.*)?$/,
  /^node:child_process$/,
  /^child_process$/,
  /^node:net$/,
  /^node:http(s)?$/,
  /^fastify$/,
  /^@fastify\/.*$/,
  /^@craftingtable\/server$/,
  /^@craftingtable\/web$/,
  /^react(-dom)?$/,
  /(?:^|\/)routes?(?:\/|\.|$)/,
  /(?:^|\/)workspace-events?(?:\/|\.|$)/,
  /(?:^|\/)notifier(?:\/|\.|$)/,
];

const A2A_TEST_IO_PATTERNS = [/^node:fs(\/.*)?$/, /^node:net$/, /^node:http(s)?$/];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const GIT_PROCESS_AUTHORITY = 'packages/git/src/command-runner.ts';
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
 * Over-matching (e.g. inside comments) is acceptable for a guard; silent
 * under-matching is not (CT01-R4).
 */
export const IMPORT_PATTERN = /(?:\bimport\s*\(?\s*|\bfrom\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

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
  return A2A_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier));
}

function isA2aTestIoCapability(specifier) {
  return A2A_TEST_IO_PATTERNS.some((pattern) => pattern.test(specifier));
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

export function hasLiteralCurrentMigrationAssertion(source) {
  return /migrationStatus\.currentVersion\)\.toBe\(\s*\d+\s*\)/.test(source);
}

/** Returns every module specifier the source imports. */
export function findImports(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
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
  const hits = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    if (isForbidden(match[1])) {
      hits.push(match[1]);
    }
  }
  return hits;
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
  for (const group of ['apps', 'packages']) {
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
        for (const specifier of findForbiddenImports(source)) {
          violations.push(`${relativePath}: imports forbidden module "${specifier}"`);
        }
        if (isA2aSource(relativePath)) {
          for (const specifier of findImports(source)) {
            if (
              isForbiddenInA2a(specifier) &&
              !(isTestModule(path) && isA2aTestIoCapability(specifier))
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
    'Forbidden-scope check passed: no Exo Stack dependency, only the reviewed Git\n' +
      'process authority, no non-production seam in composed source,\n' +
      'no NUL byte in tracked source, and\n' +
      'the planning package and CT-04A2a repository model stay pure.',
  );
}
