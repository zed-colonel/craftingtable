#!/usr/bin/env node
/**
 * Forbidden-scope check (work-items/CT-01.md, AGENTS.md): CraftingTable must
 * not gain runtime dependencies on the Exo Stack (ActionQueue, WorldInterface,
 * Exoskeleton). Scans every workspace manifest's dependency fields and every
 * import/require specifier under the src directories of apps and packages.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const FORBIDDEN = [/actionqueue/i, /action-queue/i, /world-?interface/i, /exoskeleton/i];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

const violations = [];

function isForbidden(specifier) {
  return FORBIDDEN.some((pattern) => pattern.test(specifier));
}

function checkManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (isForbidden(name)) {
        violations.push(`${relative(ROOT, path)}: ${field} contains forbidden package "${name}"`);
      }
    }
  }
}

function checkSourceFile(path) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    if (isForbidden(match[1])) {
      violations.push(`${relative(ROOT, path)}: imports forbidden module "${match[1]}"`);
    }
  }
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

checkManifest(join(ROOT, 'package.json'));
for (const group of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = join(ROOT, group, entry.name);
    checkManifest(join(packageDir, 'package.json'));
    walk(join(packageDir, 'src'), (path) => {
      if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
        checkSourceFile(path);
      }
    });
  }
}

if (violations.length > 0) {
  console.error('Forbidden-scope check FAILED:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log('Forbidden-scope check passed: no Exo Stack runtime dependencies found.');
