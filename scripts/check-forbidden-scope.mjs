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
      walk(join(packageDir, 'src'), (path) => {
        if (!SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
          return;
        }
        for (const specifier of findForbiddenImports(readFileSync(path, 'utf8'))) {
          violations.push(`${relative(root, path)}: imports forbidden module "${specifier}"`);
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
  console.log('Forbidden-scope check passed: no Exo Stack runtime dependencies found.');
}
