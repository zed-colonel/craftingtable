#!/usr/bin/env node
/**
 * Forbidden-scope check (work-items/CT-01.md, AGENTS.md): CraftingTable must
 * not gain runtime dependencies on the Exo Stack (ActionQueue, WorldInterface,
 * Exoskeleton). Scans every workspace manifest's dependency fields and every
 * import/require specifier under the src directories of apps and packages.
 *
 * Exported functions are unit-tested in check-forbidden-scope.test.mjs; keep
 * the recognized module syntax and those tests in lockstep.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_PATTERNS = [/action-?queue/i, /world-?interface/i, /exoskeleton/i];

/**
 * Modules that would give CraftingTable a CT-04-or-later capability
 * (work-items/CT-03/CT-03.md §9, CT03-A70): real Git, worktrees, process and
 * shell execution, and vendor coding-agent SDKs. Checked against production
 * source only; tests may still exercise fakes.
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
 * Packages that exist as future or test seams only. Production source must not
 * import them (AGENTS.md, CT-03 §4).
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

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

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

/** Returns every module specifier the source imports. */
export function findImports(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

/** True for test and test-support modules, which may use wider capabilities. */
export function isTestModule(path) {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || /test-support\.[cm]?[jt]sx?$/.test(path);
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
      walk(join(packageDir, 'src'), (path) => {
        if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
          return;
        }
        const source = readFileSync(path, 'utf8');
        const relativePath = relative(root, path);
        for (const specifier of findForbiddenImports(source)) {
          violations.push(`${relativePath}: imports forbidden module "${specifier}"`);
        }
        if (isTestModule(path)) {
          return;
        }
        for (const specifier of findImports(source)) {
          if (isForbiddenCapability(specifier)) {
            violations.push(`${relativePath}: imports CT-04+ capability module "${specifier}"`);
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
      });
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
    'Forbidden-scope check passed: no Exo Stack dependency, no CT-04+ capability module,\n' +
      'no non-production seam in production source, and the planning package stays pure.',
  );
}
