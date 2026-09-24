#!/usr/bin/env node
/**
 * Forbidden-scope check (AGENTS.md).
 *
 * Mechanically enforces the durable boundaries that a review could miss:
 *
 * 1. No runtime dependency on the Exo Stack (ActionQueue, WorldInterface,
 *    Exoskeleton) anywhere in the workspace.
 * 2. Process authority lives only in the named adapter modules. Every other
 *    production source file is forbidden from spawning processes or importing
 *    Git or vendor-agent libraries.
 * 3. The planning package stays pure: no filesystem, process, network,
 *    database, or UI imports.
 * 4. The domain package depends on nothing but itself.
 * 5. The daemon and the browser never branch on human-readable text: no prefix, substring
 *    or regex tests on a `reason` or `message` (program rule 4, R-A3). Stops carry typed
 *    codes; `packages/domain/src/attention-legacy.ts` is the one place that maps text
 *    written by earlier releases to codes.
 *
 * Exported functions are unit-tested in check-forbidden-scope.test.mjs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_PATTERNS = [/action-?queue/i, /world-?interface/i, /exoskeleton/i];

/** Modules that grant process, Git, shell, or vendor-agent authority. */
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
 * The only production modules allowed to spawn a process, each with its
 * reason. Adding one is a reviewed decision, not a convenience.
 */
export const PROCESS_AUTHORITY = new Map([
  [
    'packages/agents/src/native-environment.ts',
    'Fixed native host audit and bounded user-service lifecycle (ADR-054)',
  ],
  ['packages/agents/src/local-check.ts', 'Scoped checks and bounded local act execution (ADR-053)'],
  ['packages/git/src/operations.ts', 'worktree creation, removal, and diffing'],
  ['packages/agents/src/process.ts', 'Agent backend process supervision'],
  [
    'packages/agents/src/pinned-cargo.ts',
    'Pinned Cargo execution in the agent process group (ADR-047)',
  ],
]);

/** The pure planning boundary (ADR-012). */
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
  /^@craftingtable\/(storage|server|web|agents|git)$/,
];

/** The domain package may import nothing but itself. */
export const DOMAIN_FORBIDDEN_PATTERNS = [/^node:/, /^@craftingtable\//, /^[a-z@]/];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const APPLICATION_GROUPS = ['apps', 'packages'];

const IMPORT_PATTERN =
  /(?:\bimport\b[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\b[^'"]*?\bfrom\s*)['"]([^'"]+)['"]/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

export function findImports(source) {
  const specifiers = [];
  for (const match of stripComments(source).matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

export function nodeBuiltinName(specifier) {
  const prefixed = specifier.startsWith('node:');
  const root = (prefixed ? specifier.slice('node:'.length) : specifier).split('/')[0];
  if (root.length === 0) {
    return undefined;
  }
  return prefixed || builtinModules.includes(root) ? root : undefined;
}

export function isForbiddenName(value) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

export function isForbiddenCapability(specifier) {
  return FORBIDDEN_CAPABILITY_PATTERNS.some((pattern) => pattern.test(specifier));
}

export function isTestSource(relativePath) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
    /(?:^|\/)test\//.test(relativePath) ||
    /test-support/.test(relativePath) ||
    /(?:^|\/)fixtures\//.test(relativePath)
  );
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      yield path;
    }
  }
}

function manifestFindings(root) {
  const findings = [];
  const manifests = [join(root, 'package.json')];
  for (const group of APPLICATION_GROUPS) {
    let entries = [];
    try {
      entries = readdirSync(join(root, group), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        manifests.push(join(root, group, entry.name, 'package.json'));
      }
    }
  }
  for (const manifest of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(parsed[field] ?? {})) {
        if (isForbiddenName(name)) {
          findings.push(`${relative(root, manifest)}: forbidden dependency "${name}"`);
        }
        if (isForbiddenCapability(name) && !name.startsWith('@craftingtable/')) {
          findings.push(`${relative(root, manifest)}: forbidden capability dependency "${name}"`);
        }
      }
    }
  }
  return findings;
}

/**
 * Classifies one source file's imports. Exported for the unit tests, which
 * feed synthetic paths and sources.
 */
export function sourceFindings(relativePath, source) {
  const findings = [];
  if (source.includes('\0')) {
    findings.push(`${relativePath}: contains a NUL byte`);
    return findings;
  }
  const production = !isTestSource(relativePath);
  const planning = relativePath.startsWith('packages/planning/src/');
  const domain = relativePath.startsWith('packages/domain/src/');
  for (const specifier of findImports(source)) {
    if (isForbiddenName(specifier)) {
      findings.push(`${relativePath}: forbidden import "${specifier}"`);
    }
    if (production && isForbiddenCapability(specifier)) {
      const authority = PROCESS_AUTHORITY.get(relativePath);
      const isSpawn = /child_process$/i.test(specifier);
      if (!(isSpawn && authority !== undefined)) {
        findings.push(
          `${relativePath}: capability import "${specifier}" is permitted only in a listed process authority`,
        );
      }
    }
    if (planning && production && PLANNING_FORBIDDEN_PATTERNS.some((p) => p.test(specifier))) {
      findings.push(`${relativePath}: planning package imports impure module "${specifier}"`);
    }
    if (
      domain &&
      production &&
      !specifier.startsWith('.') &&
      DOMAIN_FORBIDDEN_PATTERNS.some((p) => p.test(specifier))
    ) {
      findings.push(`${relativePath}: domain package imports external module "${specifier}"`);
    }
  }
  return findings;
}

/** Text matching on a reason or message: `x.reason.startsWith(`, `/…/.test(x.message)`. */
export const PROSE_BRANCH_PATTERNS = [
  /\b(?:reason|message)\??\.(?:startsWith|endsWith|includes|match|search)\(/,
  /\.test\([^()]*\b(?:reason|message)\)/,
];

/** Production sources in the daemon and browser apps must branch on codes, not prose. */
export function proseFindings(relativePath, source) {
  if (isTestSource(relativePath)) return [];
  if (!/^apps\/(?:server|web)\/src\//.test(relativePath)) return [];
  const findings = [];
  // Blank comments out in place so reported line numbers stay right.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  for (const [index, line] of code.split('\n').entries())
    if (PROSE_BRANCH_PATTERNS.some((pattern) => pattern.test(line)))
      findings.push(
        `${relativePath}:${index + 1}: branches on human-readable text; use a typed code`,
      );
  return findings;
}

export function runCheck(root) {
  const findings = manifestFindings(root);
  for (const group of APPLICATION_GROUPS) {
    let path;
    try {
      path = join(root, group);
      readdirSync(path);
    } catch {
      continue;
    }
    for (const file of walk(path)) {
      const relativePath = relative(root, file).split('\\').join('/');
      const source = readFileSync(file, 'utf8');
      findings.push(
        ...sourceFindings(relativePath, source),
        ...proseFindings(relativePath, source),
      );
    }
  }
  return findings;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const findings = runCheck(root);
  if (findings.length > 0) {
    console.error('Forbidden-scope check failed:');
    for (const finding of findings) {
      console.error(`  - ${finding}`);
    }
    process.exit(1);
  }
  console.log(
    'Forbidden-scope check passed: no Exo Stack dependency, process authority confined to',
    `${PROCESS_AUTHORITY.size} listed modules, planning and domain packages pure, no branching on reason or message text.`,
  );
}
