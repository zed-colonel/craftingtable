#!/usr/bin/env node
/**
 * Forbidden-scope check (AGENTS.md).
 *
 * Mechanically enforces the durable boundaries that a review could miss:
 *
 * 1. No runtime dependency on the Exo Stack (ActionQueue, WorldInterface, Exoskeleton) in any
 *    workspace manifest or in any module of `apps/` and `packages/`, tests included.
 * 2. Capability modules (`child_process`, `cluster`, `worker_threads`, `vm`, `module`, a module
 *    by URL such as `data:`, Git and vendor-agent libraries) are imported only by the named
 *    adapter modules (`node:module` only by the listed loader authority), and only those load a
 *    module by a name they compute (`import(expression)`, `require`, `createRequire`,
 *    `getBuiltinModule`) or run code from text (`eval`, `Function`, a `.constructor(…)` call).
 *    `process` and `globalThis` are read only as a named member that loads nothing; an alias,
 *    a destructure, an argument or a computed member could reach a loader, so each is a finding
 *    too. A computed name is a capability import this check cannot read.
 * 3. The planning package stays pure: no filesystem, process, network, database, or UI imports,
 *    and no module of a sibling package other than the domain and the contracts.
 * 4. The domain package depends on nothing but itself.
 * 5. The daemon and the browser never branch on human-readable text: no prefix, substring,
 *    regex, equality or `switch` test of a `reason` or `message` against prose (program rule 4,
 *    R-A3). Stops carry typed codes; `packages/domain/src/attention-legacy.ts` is the one
 *    place that maps text written by earlier releases to codes.
 *
 * What it reads is structural, not a directory walk with name patterns (R-I4, TS-M11):
 *
 * - **The files** are every module the workspace's TypeScript projects compile (each
 *   `tsconfig*.json` under `apps/` and `packages/`, nested ones included), and every other
 *   source file there that Git tracks or would add. They are read through the compiler
 *   (TypeScript 7's `typescript/unstable/sync` API); a file no project compiles is read in the
 *   project the compiler infers for it. A directory named `dist` inside `src` is compiled, so it
 *   is checked; ignored build output is not.
 * - **The imports** come from each module's syntax tree, resolved by the compiler: static
 *   imports and re-exports, `import()`, `require`, `import x = require()`, and `import('x')`
 *   types. No comment stripping and no quote-only patterns.
 * - **Tests** are what vitest runs: the `include`, `setupFiles` and `globalSetup` entries of
 *   `vitest.config.ts`, read from its syntax tree. **Test support** is every module that only
 *   tests reach on the resolved import graph. Everything else is production, whatever its name:
 *   a module reached from a production entry (a module nothing imports, or a package's
 *   manifest entry) is production even when it is called `…-test-support.ts`. Until test
 *   support moves out of `src` (R-I4, unit K), this graph is what separates it.
 *
 * Exported functions are tested in check-forbidden-scope.test.mjs on throwaway workspaces.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxKind } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

export const FORBIDDEN_PATTERNS = [/action-?queue/i, /world-?interface/i, /exoskeleton/i];

/** Modules that grant process, Git, shell, or vendor-agent authority. */
export const FORBIDDEN_CAPABILITY_PATTERNS = [
  /^simple-git$/i,
  /^nodegit$/i,
  /^isomorphic-git$/i,
  /^dugite$/i,
  /^node:child_process$/i,
  /^child_process$/i,
  /^(node:)?cluster$/i,
  /^(node:)?worker_threads$/i,
  /^(node:)?vm$/i,
  // `createRequire`, `Module._load` and loader hooks.
  /^(node:)?module$/i,
  // A module by URL (`data:`, `file:`, `https:`) is code this check cannot read; `node:` names
  // a builtin, which the patterns above judge.
  /^(?!node:)[a-z][a-z0-9+.-]*:/i,
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

/**
 * The only production modules allowed to import `node:module` (resolution hooks, `createRequire`),
 * each with its reason. Like a process authority, adding one is a reviewed decision.
 */
export const LOADER_AUTHORITY = new Map([
  [
    'packages/agents/src/source-hooks.ts',
    'Resolves workspace packages to source in checks launched from source (TS-H6); never loaded built',
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
/** The packages whose modules planning may import (ADR-012). */
const PLANNING_MAY_IMPORT = new Set(['packages/planning', 'packages/domain', 'packages/contracts']);

/** The domain package may import nothing but itself. */
export const DOMAIN_FORBIDDEN_PATTERNS = [/^node:/, /^@craftingtable\//, /^[a-z@]/];

/** Where rule 5 applies: the daemon, the browser and the shared packages (R-A3). */
const PROSE_PACKAGES = new Set([
  'apps/server',
  'apps/web',
  'packages/contracts',
  'packages/domain',
  'packages/planning',
  'packages/storage',
]);
/** The one module allowed to read reason text written by earlier releases (ADR-067). */
const PROSE_LEGACY_MAPPING = 'packages/domain/src/attention-legacy.ts';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const APPLICATION_GROUPS = ['apps', 'packages'];
const VITEST_CONFIG = 'vitest.config.ts';

export function isForbiddenName(value) {
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

export function isForbiddenCapability(specifier) {
  return FORBIDDEN_CAPABILITY_PATTERNS.some((pattern) => pattern.test(specifier));
}

const posix = (path) => path.split(sep).join('/');

/** The workspace's package directories (`apps/*`, `packages/*`), relative to the root. */
function packageDirectories(root) {
  return APPLICATION_GROUPS.flatMap((group) => {
    try {
      return readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${group}/${entry.name}`);
    } catch {
      return [];
    }
  }).sort();
}

/** Each workspace package's directory and its manifest (`{}` where it has none). */
function workspaceManifests(root) {
  return packageDirectories(root).map((directory) => {
    try {
      return {
        directory,
        manifest: JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')),
      };
    } catch {
      return { directory, manifest: {} };
    }
  });
}

/** The fields through which a package is installed with whatever depends on it in production. */
const PRODUCTION_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * The packages that run in production: the apps, and every workspace package an app reaches
 * through production dependencies. A package only `devDependencies` reach (a test stack) is not
 * one, so its manifest's entries are not production entries.
 */
function productionPackages(manifests) {
  const byName = new Map(
    manifests
      .filter(({ manifest }) => typeof manifest.name === 'string')
      .map((m) => [m.manifest.name, m]),
  );
  const reached = new Set();
  const pending = manifests.filter(({ directory }) => directory.startsWith('apps/'));
  while (pending.length > 0) {
    const { directory, manifest } = pending.pop();
    if (reached.has(directory)) continue;
    reached.add(directory);
    for (const field of PRODUCTION_DEPENDENCY_FIELDS)
      for (const name of Object.keys(manifest[field] ?? {}))
        if (byName.has(name)) pending.push(byName.get(name));
  }
  return reached;
}

/**
 * What a workspace package's name resolves to, in order: its `source` export condition, then
 * its `main`, `module` and other `exports` of `.`. Build outputs among them are mapped back to
 * source by `sourceModule`.
 */
function packageEntries(root, { directory, manifest }) {
  const exported = manifest.exports;
  const dot =
    typeof exported === 'object' && exported !== null ? (exported['.'] ?? exported) : exported;
  const paths = [];
  const collect = (value) => {
    if (typeof value === 'string') paths.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v);
  };
  if (typeof dot === 'object' && dot !== null) collect(dot.source);
  collect(manifest.main);
  collect(manifest.module);
  collect(dot);
  return paths.map((path) => resolve(root, directory, path));
}

/**
 * The checked module a path is, or is built from: a path under a project's `outDir` (a `.js`
 * or its `.d.ts`) maps back to the source under its `rootDir`.
 */
function sourceModule(path, projects, modules) {
  if (modules.has(path)) return path;
  for (const { outDir, rootDir } of projects.map((project) => project.compilerOptions)) {
    if (!outDir || !rootDir || !path.startsWith(outDir + sep)) continue;
    const stem = join(rootDir, relative(outDir, path)).replace(/(\.d)?\.[cm]?[jt]s$/, '');
    const found = ['.ts', '.tsx', '.mts', '.cts']
      .map((extension) => stem + extension)
      .find((candidate) => modules.has(candidate));
    if (found !== undefined) return found;
  }
  return undefined;
}

function manifestFindings(root) {
  const findings = [];
  const manifests = [
    join(root, 'package.json'),
    ...packageDirectories(root).map((directory) => join(root, directory, 'package.json')),
  ];
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
          findings.push(`${posix(relative(root, manifest))}: forbidden dependency "${name}"`);
        }
        if (isForbiddenCapability(name) && !name.startsWith('@craftingtable/')) {
          findings.push(
            `${posix(relative(root, manifest))}: forbidden capability dependency "${name}"`,
          );
        }
      }
    }
  }
  return findings;
}

const isDeclarationFile = (path) => /\.d\.[cm]?ts$/.test(path);
const isLiteral = (node) =>
  node?.kind === SyntaxKind.StringLiteral ||
  node?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;

/** Identifiers that declare a binding (`const require = …`), rather than use one. */
function isDeclaredName(node) {
  switch (node.parent?.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.BindingElement:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceImport:
      return node.parent.name === node;
    default:
      return false;
  }
}

/** Identifiers that name a declaration's own member or key, not a value in scope. */
function isMemberName(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.kind) {
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.EnumMember:
    case SyntaxKind.QualifiedName:
    case SyntaxKind.JsxAttribute:
      return parent.name === node;
    case SyntaxKind.BindingElement:
      return parent.propertyName === node;
    default:
      return false;
  }
}

/** Names whose only use is loading a module the compiler cannot see. */
const LOADER_NAMES = new Set(['getBuiltinModule', 'createRequire']);
/** `process` members that load native or internal modules. */
const PROCESS_LOADERS = new Set(['binding', '_linkedBinding', 'dlopen']);

/** `globalThis` members that load or run code by name. */
const GLOBAL_LOADERS = new Set(['eval', 'Function', 'require']);

/** The expression a node is inside parentheses, casts and non-null assertions. */
function unwrapped(node) {
  let outer = node;
  while (
    (outer.parent?.kind === SyntaxKind.ParenthesizedExpression ||
      outer.parent?.kind === SyntaxKind.AsExpression ||
      outer.parent?.kind === SyntaxKind.SatisfiesExpression ||
      outer.parent?.kind === SyntaxKind.NonNullExpression ||
      outer.parent?.kind === SyntaxKind.TypeAssertionExpression) &&
    outer.parent.expression === outer
  )
    outer = outer.parent;
  return outer;
}

/**
 * How a use of `process` or `globalThis` could reach a loader, if it could. The only use that
 * cannot is reading (or writing) a named member that loads nothing: `process.env`,
 * `process['argv']`, `globalThis.setTimeout`, and `typeof process`. A loader member
 * (`process.binding`, `globalThis.eval`, also through casts and `globalThis.process`), a
 * computed member, and any other use (an alias, a destructure, an argument) are findings: each
 * can reach a loader by a name this check cannot read.
 */
function globalLoad(node) {
  let name = node.text;
  let outer = unwrapped(node);
  for (;;) {
    const parent = outer.parent;
    if (
      parent?.kind === SyntaxKind.TypeOfExpression ||
      parent?.kind === SyntaxKind.TypeQuery ||
      parent?.kind === SyntaxKind.QualifiedName
    )
      return undefined;
    let member;
    if (parent?.kind === SyntaxKind.PropertyAccessExpression && parent.expression === outer)
      member = parent.name.text;
    else if (parent?.kind === SyntaxKind.ElementAccessExpression && parent.expression === outer) {
      if (!isLiteral(parent.argumentExpression)) return `${name}[…]`;
      member = parent.argumentExpression.text;
    } else return `${name} as a value`;
    if (name === 'globalThis' && member === 'process') {
      name = 'process';
      outer = unwrapped(parent);
      continue;
    }
    const loaders = name === 'process' ? PROCESS_LOADERS : GLOBAL_LOADERS;
    return loaders.has(member) ? `${name}.${member}` : undefined;
  }
}

/**
 * One module's imports and computed loads, from its syntax tree. `require` identifiers are
 * returned for the caller to resolve: a local function called `require` is not module loading.
 */
function readModule(sourceFile) {
  const references = [];
  const loads = [];
  const requires = [];
  // Modules named by `new URL('./x.js', import.meta.url)`: a launcher's or a worker's target.
  const urls = [];
  const reference = (node, kind) => {
    if (isLiteral(node)) references.push({ specifier: node.text, node, kind });
    else loads.push({ node: node ?? sourceFile, what: kind });
  };
  const visit = (node) => {
    // Any function's `constructor` is `Function`: `(() => {}).constructor('…')` runs text.
    if (node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.NewExpression) {
      let callee = node.expression;
      while (callee.kind === SyntaxKind.ParenthesizedExpression) callee = callee.expression;
      if (
        (callee.kind === SyntaxKind.PropertyAccessExpression &&
          callee.name.text === 'constructor') ||
        (callee.kind === SyntaxKind.ElementAccessExpression &&
          isLiteral(callee.argumentExpression) &&
          callee.argumentExpression.text === 'constructor')
      )
        loads.push({ node, what: 'constructor()' });
    }
    switch (node.kind) {
      case SyntaxKind.NewExpression:
        if (
          node.expression.kind === SyntaxKind.Identifier &&
          node.expression.text === 'URL' &&
          node.arguments?.length === 2 &&
          node.arguments[1].kind === SyntaxKind.PropertyAccessExpression &&
          node.arguments[1].expression.kind === SyntaxKind.MetaProperty &&
          node.arguments[1].name.text === 'url'
        ) {
          const target = node.arguments[0];
          const branches =
            target.kind === SyntaxKind.ConditionalExpression
              ? [target.whenTrue, target.whenFalse]
              : [target];
          for (const branch of branches) if (isLiteral(branch)) urls.push(branch.text);
        }
        break;
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.ExportDeclaration:
        if (node.moduleSpecifier) reference(node.moduleSpecifier, 'import');
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node.moduleReference.kind === SyntaxKind.ExternalModuleReference)
          reference(node.moduleReference.expression, 'require');
        break;
      case SyntaxKind.ImportType:
        if (node.argument?.kind === SyntaxKind.LiteralType && isLiteral(node.argument.literal))
          references.push({ specifier: node.argument.literal.text, node: node.argument.literal });
        break;
      case SyntaxKind.CallExpression:
        if (node.expression.kind === SyntaxKind.ImportKeyword)
          reference(node.arguments[0], 'import()');
        break;
      case SyntaxKind.Identifier:
        if (node.text === 'require' && !isMemberName(node)) {
          if (!isDeclaredName(node)) requires.push(node);
        } else if (
          // CommonJS's own loader: `module.require(…)`, `process.mainModule.require(…)`.
          node.text === 'require' &&
          node.parent?.kind === SyntaxKind.PropertyAccessExpression &&
          node.parent.name === node &&
          ((node.parent.expression.kind === SyntaxKind.Identifier &&
            node.parent.expression.text === 'module') ||
            (node.parent.expression.kind === SyntaxKind.PropertyAccessExpression &&
              node.parent.expression.name.text === 'mainModule'))
        )
          loads.push({ node, what: 'module.require' });
        else if (LOADER_NAMES.has(node.text)) loads.push({ node, what: node.text });
        else if (
          (node.text === 'process' || node.text === 'globalThis') &&
          !isMemberName(node) &&
          !isDeclaredName(node)
        ) {
          const what = globalLoad(node);
          if (what !== undefined) loads.push({ node, what });
        } else if (
          // Code run from text: `eval(…)`, `Function(…)`, `new Function(…)`.
          (node.text === 'eval' && !isMemberName(node) && !isDeclaredName(node)) ||
          (node.text === 'Function' &&
            (node.parent?.kind === SyntaxKind.CallExpression ||
              node.parent?.kind === SyntaxKind.NewExpression) &&
            node.parent.expression === node)
        )
          loads.push({ node, what: node.text });
        break;
      case SyntaxKind.ElementAccessExpression:
        if (isLiteral(node.argumentExpression) && LOADER_NAMES.has(node.argumentExpression.text))
          loads.push({ node, what: node.argumentExpression.text });
        break;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return { references, loads, requires, urls };
}

/** Whether a name holds human-readable text: any identifier ending in `reason` or `message`. */
const isProseName = (name) => /(?:reason|message|Reason|Message)$/.test(name);
/** Typed codes are lowercase kebab-case words; anything else in a literal is prose. */
const isCode = (text) => text === '' || /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(text);
/** String methods that return text (or its words) derived from their receiver. */
const STRING_TRANSFORMS = new Set([
  'at',
  'charAt',
  'concat',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'split',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
]);
/** Methods that test text against other text. */
const TEXT_TESTS = new Set([
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'localeCompare',
  'match',
  'matchAll',
  'search',
  'startsWith',
]);
const EQUALITY = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Whether an expression is a reason or a message, or text derived from one: `x.reason`,
 * `x.reason!`, `x['reason']`, `x.reason ?? ''`, `String(x.message)`,
 * `x.reason.toLowerCase()`, `x.reason.split(' ')[0]`.
 */
function isProse(expression) {
  let node = expression;
  for (;;) {
    switch (node?.kind) {
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.NonNullExpression:
      case SyntaxKind.AsExpression:
      case SyntaxKind.SatisfiesExpression:
      case SyntaxKind.TypeAssertionExpression:
        node = node.expression;
        continue;
      case SyntaxKind.BinaryExpression:
        if (
          node.operatorToken.kind !== SyntaxKind.QuestionQuestionToken &&
          node.operatorToken.kind !== SyntaxKind.BarBarToken
        )
          return false;
        node = node.left;
        continue;
      case SyntaxKind.CallExpression: {
        const callee = node.expression;
        if (callee.kind === SyntaxKind.Identifier && callee.text === 'String') {
          node = node.arguments[0];
          continue;
        }
        if (
          callee.kind === SyntaxKind.PropertyAccessExpression &&
          STRING_TRANSFORMS.has(callee.name.text)
        ) {
          node = callee.expression;
          continue;
        }
        return false;
      }
      case SyntaxKind.ElementAccessExpression:
        if (isLiteral(node.argumentExpression)) return isProseName(node.argumentExpression.text);
        node = node.expression;
        continue;
      case SyntaxKind.PropertyAccessExpression:
        return isProseName(node.name.text);
      case SyntaxKind.Identifier:
        return isProseName(node.text);
      default:
        return false;
    }
  }
}

/** A literal (or a template) that holds prose rather than a typed code. */
function isProseLiteral(node) {
  if (node?.kind === SyntaxKind.TemplateExpression) return true;
  return isLiteral(node) && !isCode(node.text);
}

/** A list of literals written in place, as in `['Paused.', …].includes(x.reason)`. */
function proseList(node) {
  let list = node;
  while (list?.kind === SyntaxKind.ParenthesizedExpression) list = list.expression;
  if (list?.kind === SyntaxKind.NewExpression && list.arguments?.length === 1)
    list = list.arguments[0];
  return list?.kind === SyntaxKind.ArrayLiteralExpression && list.elements.some(isProseLiteral);
}

/** The nodes in a module that branch on prose (rule 5). */
function proseBranches(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (node.kind === SyntaxKind.CallExpression) {
      const callee = node.expression;
      if (callee.kind === SyntaxKind.PropertyAccessExpression) {
        const method = callee.name.text;
        if (TEXT_TESTS.has(method) && isProse(callee.expression)) found.push(node);
        else if ((method === 'test' || method === 'exec') && node.arguments.some(isProse))
          found.push(node);
        else if (
          (method === 'includes' || method === 'indexOf' || method === 'has') &&
          proseList(callee.expression) &&
          node.arguments.some(isProse)
        )
          found.push(node);
      }
    } else if (node.kind === SyntaxKind.BinaryExpression && EQUALITY.has(node.operatorToken.kind)) {
      if (
        (isProse(node.left) && isProseLiteral(node.right)) ||
        (isProse(node.right) && isProseLiteral(node.left))
      )
        found.push(node);
    } else if (node.kind === SyntaxKind.SwitchStatement && isProse(node.expression)) {
      if (node.caseBlock.clauses.some((clause) => isProseLiteral(clause.expression)))
        found.push(node);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

const lineStarts = new WeakMap();
/** The 1-based line a node starts on. */
function lineOf(sourceFile, node) {
  let starts = lineStarts.get(sourceFile);
  if (starts === undefined) {
    starts = [0];
    const text = sourceFile.text;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1))
      starts.push(index + 1);
    lineStarts.set(sourceFile, starts);
  }
  const position = node.getStart(sourceFile);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * What a `vitest.config.ts` runs: for each `test: { … }` block, its `include` globs less its
 * `exclude` globs, and its `setupFiles` and `globalSetup` modules. Only a `test` block counts,
 * so a `coverage.include` cannot turn production into tests.
 */
function vitestEntries(sourceFile) {
  const blocks = [];
  const strings = (value) => {
    if (isLiteral(value)) return [value.text];
    if (value?.kind === SyntaxKind.ArrayLiteralExpression)
      return value.elements.filter(isLiteral).map((element) => element.text);
    return [];
  };
  const visit = (node) => {
    if (
      node.kind === SyntaxKind.PropertyAssignment &&
      node.name.kind === SyntaxKind.Identifier &&
      node.name.text === 'test' &&
      node.initializer.kind === SyntaxKind.ObjectLiteralExpression
    ) {
      const block = { include: [], exclude: [], setup: [] };
      for (const property of node.initializer.properties) {
        if (property.kind !== SyntaxKind.PropertyAssignment) continue;
        const name = property.name.kind === SyntaxKind.Identifier ? property.name.text : '';
        if (name === 'include') block.include.push(...strings(property.initializer));
        else if (name === 'exclude') block.exclude.push(...strings(property.initializer));
        else if (name === 'setupFiles' || name === 'globalSetup')
          block.setup.push(...strings(property.initializer));
      }
      blocks.push(block);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return blocks;
}

/** Whether vitest runs a module (its path from the root) as a test or a setup module. */
function isTestEntry(path, blocks) {
  return blocks.some(
    (block) =>
      block.setup.some((entry) => matchesGlob(path, entry)) ||
      (block.include.some((entry) => matchesGlob(path, entry)) &&
        !block.exclude.some((entry) => matchesGlob(path, entry))),
  );
}

/**
 * The paths a package manifest names as its entries: `main`, `module`, `bin`, `exports`, and
 * every word of its `scripts` (`tsx src/db-verify.ts` runs `src/db-verify.ts`). A word that is
 * not a module of the workspace matches nothing.
 */
function manifestEntries(manifest) {
  const entries = [];
  const collect = (value) => {
    if (typeof value === 'string') entries.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) collect(v);
  };
  collect(manifest.main);
  collect(manifest.module);
  collect(manifest.bin);
  collect(manifest.exports);
  for (const script of Object.values(manifest.scripts ?? {}))
    if (typeof script === 'string') entries.push(...script.split(/[\s;&|]+/).filter(Boolean));
  return entries;
}

/**
 * The file a relative specifier names, as `tsc` maps it: `./x.js` is `./x.ts` (or `.tsx`, or
 * a build's `./x.d.ts`) when no `./x.js` exists.
 */
function onDisk(from, specifier) {
  const path = resolve(dirname(from), specifier);
  const stem = path.replace(/\.([cm]?)js$/, '');
  const flavour = /\.([cm]?)js$/.exec(path)?.[1] ?? '';
  const candidates = [
    path,
    `${stem}.${flavour}ts`,
    `${stem}.tsx`,
    `${stem}.d.${flavour}ts`,
    `${path}.ts`,
    `${path}.tsx`,
    join(path, 'index.ts'),
  ];
  return candidates.find(
    (candidate) => existsSync(candidate) && !statSync(candidate).isDirectory(),
  );
}

/**
 * Whether a `require` is declared by the workspace as its own function or value: a function
 * with a body, a variable with an initializer, or a parameter. An ambient `declare` (or no
 * declaration, or Node's types) is Node's loader.
 */
function isLocalFunction(declaration, project) {
  if (declaration === undefined) return false;
  if (declaration.kind === SyntaxKind.Parameter) return true;
  if (
    declaration.kind !== SyntaxKind.FunctionDeclaration &&
    declaration.kind !== SyntaxKind.VariableDeclaration
  )
    return false;
  const node = declaration.resolve(project);
  return node?.kind === SyntaxKind.FunctionDeclaration
    ? node.body !== undefined
    : node?.initializer !== undefined;
}

/** A reason the check cannot run at all: said plainly, and the command fails (L-2). */
class CheckError extends Error {}

/**
 * Every file under `apps/` and `packages/` that Git tracks or would add (not ignored), so a
 * file no TypeScript project compiles is still checked, and ignored build output is not.
 */
function workspaceFiles(root) {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...APPLICATION_GROUPS],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (listed.error !== undefined)
    throw new CheckError(
      `check:scope needs git on PATH to list the workspace's files (${listed.error.message}).`,
    );
  if (listed.status !== 0)
    throw new CheckError(
      `git ls-files could not list the workspace's files: ${(listed.stderr ?? '').trim()}`,
    );
  return [...new Set(listed.stdout.split('\0').filter(Boolean))]
    .map((path) => join(root, path))
    .filter((path) => existsSync(path))
    .sort();
}

/**
 * Reads the workspace through the compiler: every project's modules and every other source
 * file, with their imports resolved, and the test entries `vitest.config.ts` declares.
 */
function readWorkspace(root) {
  const files = workspaceFiles(root);
  // Every project, nested ones (`packages/storage/test/tsconfig.json`) included.
  const configs = files.filter((path) => /^tsconfig.*\.json$/.test(basename(path)));
  const sources = files.filter(
    (path) =>
      SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) && !isDeclarationFile(path),
  );
  const vitestConfig = join(root, VITEST_CONFIG);
  const workspaceEntries = new Map();
  for (const entry of workspaceManifests(root))
    if (typeof entry.manifest.name === 'string')
      workspaceEntries.set(entry.manifest.name, packageEntries(root, entry));
  const api = new API({ cwd: root });
  try {
    let snapshot = api.updateSnapshot({
      openProjects: configs,
      openFiles: existsSync(vitestConfig) ? [vitestConfig] : [],
    });
    let projects = configs.map((config) => snapshot.getProject(config)).filter(Boolean);
    const inRoot = (path) =>
      path.startsWith(root + sep) && !path.includes(`${sep}node_modules${sep}`);
    // Each checked module's owning project: the one whose own files include it.
    const owners = () => {
      const owner = new Map();
      for (const project of projects)
        for (const file of project.rootFiles) if (!owner.has(file)) owner.set(file, project);
      for (const project of projects)
        for (const file of project.program.getSourceFileNames())
          if (inRoot(file) && !isDeclarationFile(file) && !owner.has(file))
            owner.set(file, project);
      return owner;
    };
    let owner = owners();
    // A source file no project compiles is read in the project the compiler infers for it.
    const uncompiled = sources.filter((file) => !owner.has(file));
    if (uncompiled.length > 0) {
      snapshot = api.updateSnapshot({ openFiles: uncompiled });
      projects = configs.map((config) => snapshot.getProject(config)).filter(Boolean);
      owner = owners();
      for (const file of uncompiled) {
        const project = snapshot.getDefaultProjectForFile(file);
        if (project !== undefined && !owner.has(file)) owner.set(file, project);
      }
    }
    if (projects.length === 0)
      throw new CheckError(
        `found no TypeScript project under apps/ or packages/ (Git listed ${files.length} files there): nothing would be checked.`,
      );
    const modules = new Map();
    for (const [file, project] of owner) {
      if (isDeclarationFile(file) || !inRoot(file)) continue;
      const sourceFile = project.program.getSourceFile(file);
      if (!sourceFile) continue;
      modules.set(file, {
        file,
        project,
        sourceFile,
        ...readModule(sourceFile),
        imports: new Set(),
      });
    }
    if (modules.size === 0)
      throw new CheckError('found no module to check under apps/ or packages/.');
    // Resolve every literal specifier and every `require`, one compiler call per project.
    const byProject = new Map();
    for (const module of modules.values()) {
      if (!byProject.has(module.project)) byProject.set(module.project, []);
      byProject.get(module.project).push(module);
    }
    for (const [project, members] of byProject) {
      // `require` first: a call of Node's `require` with a literal is an import to resolve.
      const requires = members.flatMap((m) => m.requires.map((node) => [m, node]));
      const declared =
        requires.length === 0
          ? []
          : project.checker.getSymbolAtLocation(requires.map(([, node]) => node));
      requires.forEach(([module, node], index) => {
        if (isLocalFunction(declared[index]?.declarations?.[0], project)) return;
        const call = node.parent;
        if (call?.kind === SyntaxKind.CallExpression && call.expression === node) {
          if (isLiteral(call.arguments[0]))
            module.references.push({ specifier: call.arguments[0].text, node: call.arguments[0] });
          else module.loads.push({ node, what: 'require()' });
        } else module.loads.push({ node, what: 'require' });
      });
      const specifiers = members.flatMap((m) => m.references.map((r) => [m, r]));
      const symbols = project.checker.getSymbolAtLocation(specifiers.map(([, r]) => r.node));
      specifiers.forEach(([module, ref], index) => {
        // Where it leads, a build output's declarations included: rules 3 and 4 read it. A
        // relative path the compiler does not treat as a module (`require` in a `.cts`) is
        // followed on disk.
        const resolved =
          symbols[index]?.declarations?.[0]?.path ??
          (ref.specifier.startsWith('.') ? onDisk(module.file, ref.specifier) : undefined);
        // The module the import reaches: a build output (`dist/x.js`, `dist/x.d.ts`) maps back
        // to its source; a workspace package the compiler resolves to nothing it checks (no
        // project reference, no link) is followed through its manifest's entries.
        let target = resolved === undefined ? undefined : sourceModule(resolved, projects, modules);
        for (const entry of target === undefined
          ? (workspaceEntries.get(ref.specifier) ?? [])
          : []) {
          target = sourceModule(entry, projects, modules);
          if (target !== undefined) break;
        }
        if (resolved !== undefined && inRoot(resolved)) ref.resolved = resolved;
        else if (target !== undefined) ref.resolved = target;
        if (target !== undefined) module.imports.add(target);
      });
    }
    // A module named by `new URL(…, import.meta.url)` is loaded by the one naming it.
    for (const module of modules.values())
      for (const url of module.urls) {
        const target = onDisk(module.file, url);
        if (target !== undefined && modules.has(target)) module.imports.add(target);
      }
    let tests = [];
    if (existsSync(vitestConfig)) {
      const project = snapshot.getDefaultProjectForFile(vitestConfig);
      const sourceFile = project?.program.getSourceFile(vitestConfig);
      if (sourceFile) tests = vitestEntries(sourceFile);
    }
    return { projects, modules, tests };
  } finally {
    api.close();
  }
}

/**
 * Which modules are production: everything reached on the import graph from a production
 * entry. An entry is the manifest entry of a package production runs (`productionPackages`),
 * the module a page loads, or a module that is not a test and that no module imports (an application entry, a launcher's target, or dead code). What only tests and
 * vitest's setup modules reach is test support; what nothing reaches is production too.
 */
function productionModules(root, projects, modules, tests) {
  const testFiles = new Set(
    [...modules.keys()].filter((file) => isTestEntry(posix(relative(root, file)), tests)),
  );
  const imported = new Set();
  for (const module of modules.values()) for (const target of module.imports) imported.add(target);
  const entries = [...modules.keys()].filter((file) => !imported.has(file) && !testFiles.has(file));
  const manifests = workspaceManifests(root);
  const running = productionPackages(manifests);
  for (const { directory, manifest } of manifests) {
    for (const entry of running.has(directory) ? manifestEntries(manifest) : []) {
      // A manifest names the build output; its module is the source the project compiles.
      const source = sourceModule(resolve(root, directory, entry), projects, modules);
      if (source !== undefined) entries.push(source);
    }
    // The browser app's entry is the module its `index.html` loads (vite's entry).
    let html = '';
    try {
      html = readFileSync(join(root, directory, 'index.html'), 'utf8');
    } catch {
      // No page.
    }
    for (const [, source] of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      const path = join(root, directory, source.startsWith('/') ? `.${source}` : source);
      if (modules.has(path)) entries.push(path);
    }
  }
  const reach = (from) => {
    const reached = new Set();
    const pending = [...from];
    while (pending.length > 0) {
      const file = pending.pop();
      if (reached.has(file)) continue;
      reached.add(file);
      for (const target of modules.get(file).imports) pending.push(target);
    }
    return reached;
  };
  const fromEntries = reach(entries);
  // Fail closed: test support is what tests reach and no entry does. Whatever neither reaches
  // (a module that imports itself, a cycle nothing else imports) is checked as production.
  const support = new Set(
    [...reach(testFiles)].filter((file) => !fromEntries.has(file) && !testFiles.has(file)),
  );
  const production = new Set(
    [...modules.keys()].filter(
      (file) => fromEntries.has(file) || (!testFiles.has(file) && !support.has(file)),
    ),
  );
  return { production, tests: testFiles };
}

/** The workspace package (`packages/storage`) or top-level directory a path is in. */
function placeOf(root, path) {
  const [group, name] = posix(relative(root, path)).split('/');
  return APPLICATION_GROUPS.includes(group) ? `${group}/${name}` : group;
}

/** One module's findings under rules 1-5. */
function moduleFindings(root, module, production) {
  const findings = [];
  const path = posix(relative(root, module.file));
  const { sourceFile } = module;
  if (sourceFile.text.includes('\0')) return [`${path}: contains a NUL byte`];
  const owningPackage = placeOf(root, module.file);
  const authority = PROCESS_AUTHORITY.has(path);
  for (const { specifier, resolved } of module.references) {
    if (isForbiddenName(specifier)) findings.push(`${path}: forbidden import "${specifier}"`);
    if (!production) continue;
    if (
      isForbiddenCapability(specifier) &&
      !(authority && /child_process$/i.test(specifier)) &&
      !(LOADER_AUTHORITY.has(path) && /^(node:)?module$/i.test(specifier))
    )
      findings.push(
        `${path}: capability import "${specifier}" is permitted only in a listed process authority`,
      );
    const targetPackage = resolved === undefined ? undefined : placeOf(root, resolved);
    const targetPath = resolved === undefined ? undefined : posix(relative(root, resolved));
    if (owningPackage === 'packages/planning') {
      if (PLANNING_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier)))
        findings.push(`${path}: planning package imports impure module "${specifier}"`);
      else if (targetPackage !== undefined && !PLANNING_MAY_IMPORT.has(targetPackage))
        findings.push(`${path}: planning package imports "${targetPath}" from ${targetPackage}`);
    }
    if (owningPackage === 'packages/domain') {
      if (
        !specifier.startsWith('.') &&
        DOMAIN_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier))
      )
        findings.push(`${path}: domain package imports external module "${specifier}"`);
      else if (targetPackage !== undefined && targetPackage !== 'packages/domain')
        findings.push(`${path}: domain package imports "${targetPath}" from ${targetPackage}`);
    }
  }
  if (!production) return findings;
  if (!authority)
    for (const { node, what } of module.loads)
      findings.push(
        `${path}:${lineOf(sourceFile, node)}: loads a module by a name it computes (${what}); only a listed process authority may`,
      );
  if (PROSE_PACKAGES.has(owningPackage) && path !== PROSE_LEGACY_MAPPING) {
    const lines = new Set(proseBranches(sourceFile).map((node) => lineOf(sourceFile, node)));
    for (const line of [...lines].sort((a, b) => a - b))
      findings.push(`${path}:${line}: branches on human-readable text; use a typed code`);
  }
  return findings;
}

/**
 * Checks a workspace. Returns the findings, and how each module was classified (its path from
 * the root mapped to `production`, `test` or `test-support`) so tests can see what was read.
 */
export function inspectWorkspace(root) {
  const absoluteRoot = realpathSync(resolve(root));
  const findings = manifestFindings(absoluteRoot);
  const { projects, modules, tests } = readWorkspace(absoluteRoot);
  const classified = productionModules(absoluteRoot, projects, modules, tests);
  const classes = new Map();
  for (const module of modules.values()) {
    const production = classified.production.has(module.file);
    classes.set(
      posix(relative(absoluteRoot, module.file)),
      production ? 'production' : classified.tests.has(module.file) ? 'test' : 'test-support',
    );
    findings.push(...moduleFindings(absoluteRoot, module, production));
  }
  return { findings, classes };
}

export function runCheck(root) {
  return inspectWorkspace(root).findings;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // The repository this script is in; its self-test names a throwaway workspace instead.
  const root =
    process.argv[2] === undefined
      ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
      : resolve(process.argv[2]);
  let findings;
  try {
    findings = runCheck(root);
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(`Forbidden-scope check could not run: ${error.message}`);
    process.exit(2);
  }
  if (findings.length > 0) {
    console.error('Forbidden-scope check failed:');
    for (const finding of findings) {
      console.error(`  - ${finding}`);
    }
    process.exit(1);
  }
  console.log(
    'Forbidden-scope check passed: no Exo Stack dependency, capability imports and computed module loads confined to',
    `${PROCESS_AUTHORITY.size} listed modules, planning and domain packages pure, no branching on reason or message text.`,
  );
}
