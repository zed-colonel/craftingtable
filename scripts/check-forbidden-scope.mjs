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
 * 6. Nothing test-only is built into a production package's `dist` (R-I4): no test (one
 *    vitest runs, or one named as a test), no module that imports a test runner or references
 *    its types, and only modules a declared entry (a production package's manifest, a page)
 *    reaches. An entry in a package's `test/` (the e2e daemon a script starts) is a test to
 *    it. The one thing it cannot tell: a harness a manifest script starts from `src` is a
 *    declared entry like the operator's CLI; harnesses live in `test/`.
 *
 * 7. Map vocabulary is written in one module (R-F2): the reviewer roles, resource ids, profile
 *    id, maturity token and attested contract wording the controller gives a meaning to are the
 *    string and regular-expression literals of `V03_VOCABULARY` in
 *    `packages/domain/src/map-capabilities.ts`, read from its syntax tree. No other production
 *    module writes one, or an identifier R-F2 retired (`RETIRED_MAP_IDENTIFIERS`), in a
 *    constant text: a string, a template, JSX text, a regular expression's pattern, a `+` of
 *    constant parts, or a template whose substitutions are constant, a name declared once in
 *    the module, by a `const`, included. It asks that module what a map declares. Tests,
 *    fixtures and the legacy mapping (text earlier releases wrote) may. It guards against
 *    reintroduction by mistake, not against evasion: text built at run time (`join`,
 *    `toLowerCase`, a parameter, a name declared more than once), another spelling of a
 *    pattern (`/^INDEPENDENT\b/i`, `/^independent/`) and a prefix test
 *    (`startsWith('independent')`) pass it; the self-test pins each of these as a known miss.
 * 8. The domain, contracts and storage packages export only what another module uses (DATA-15):
 *    every export a production module of their `src` declares is taken by name by some other
 *    module (production, a test, test support, a module under `scripts/` or `e2e/`, or a
 *    declaration file). It is imported (`{ a }`, a default, `import('x').A`), or read from a
 *    namespace the module binds (`* as ns`, `import ns = require('x')`, the value of `import()` or
 *    `require()`, a name exported as `export * as ns`): `ns.a`, `ns['a']`, the type `ns.A`,
 *    `(typeof ns)['a']`, `const { a } = ns`, in a use the compiler resolves to that binding (a
 *    parameter of the same name is not the namespace). The compiler resolves each name in the
 *    module it is taken from, through re-exports and barrels, to the declaration. A re-export
 *    (`export { a } from`, `export *`) takes nothing: a module importing the name through it takes
 *    the declaration, and a finding names the modules that only re-export it. A namespace used
 *    whole (`Object.entries(ns)`, a spread) names no export. The only exceptions are
 *    `EMITTED_EXPORTS`, each with its reason; one that is no longer an unimported export of its
 *    module is a finding too. Not read, so a use only in one of these forms is a false finding
 *    (drop an `export` something needs, and the build fails), never a false pass: a namespace
 *    bound to another name or passed on (`const n = ns`, `f(ns)`, `.then((m) => m.a)`), a
 *    computed member (`ns[key]`), a nested destructure (`const { inner: { a } } = ns`), a
 *    re-export the compiler cannot follow (a workspace package that is not linked), and a module
 *    outside `apps/`, `packages/`, `scripts/` and `e2e/` (the root configs).
 * 9. Route parameters are read once, by the route layer (R-H7): no production module but
 *    `apps/server/src/routes/route-access.ts`, which parses every route's declared parameters,
 *    reads a request's path parameters. A read is a member named `params` (`x.params`,
 *    `x?.params`, `x['params']`, or destructured, `const { params } = x` or a parameter
 *    `({ params }: …)`) that the compiler resolves to the `params` property Fastify's
 *    `FastifyRequest` declares, whatever the request is called: another object's `params` is not
 *    one. Handlers read the parsed values with `paramsOf`. A route's parameters typed as `Params`
 *    are reported too: a type argument of a generic Fastify declares (`app.get<…>`,
 *    `FastifyRequest<…>`, `extends FastifyRequest<…>`) whose type, as the compiler reads it, has a
 *    `Params` property declared outside Fastify (its own `RouteGenericInterface` types nothing),
 *    written in place or through an alias, an interface or an intersection.
 *    Typing them is what lets a handler, or a helper typed by shape that it hands the request,
 *    read them unparsed. Like rule 7 it guards
 *    against a mistake, not evasion: a member it cannot name (a computed key, `Reflect.get`)
 *    passes, and the self-test pins that.
 * 10. The daemon's modules import one another without cycles (R-B7, CTRL-13): no production
 *    module of `apps/server/src` reaches itself through what it imports, a type-only import
 *    (`import type`, an `import('…')` type) included, since a type cycle still ties the modules
 *    together. A finding names every module of the cycle and the shortest path round it from
 *    the first. None is allowed: R-B7's scheduler half removed the last
 *    (`roadmap-service` and `cross-project-service`). The packages' own cycles are outside it.
 * 11. The cycle's decision core stays a core (R-B7): no module of `apps/server/src` that a module
 *    of `apps/server/src/services/cycle/core/` reaches by value imports (a type-only import, an
 *    `import('…')` type or named bindings all `type`, does not count) imports the file system or
 *    processes (`fs`, `fs/promises`, `child_process`), and none is a service (`*-service.ts`).
 *    The core decides; the services act. A finding names the path from the core. The packages are
 *    left alone (the core reaches `@craftingtable/agents`' pure digest), and the rule claims
 *    capabilities only: the core reads storage, through the transaction it is given. The merge
 *    gate (`apps/server/src/services/merge/gate.ts`) is held to the same rule (R-B7).
 * 12. Only the replay tool pins the host a replay runs as (R-B4b): no production module but
 *    `REPLAY_HOST_USERS` imports `apps/server/src/services/replay-host.ts`, by value, by type or
 *    through a re-export, and each of those takes only its own binding by name (the replay tool
 *    `pinReplayHost`, the workstation `replayHost`), with no namespace and no re-export of it, so
 *    the daemon compares a native approval with the live host digest. Like rule 7 it guards
 *    against a mistake, not evasion: a binding passed on as a value is not followed.
 * 13. Only the operator-wait measure decodes text written before codes (R-B4b): migration 0047
 *    coded every stored record, so the daemon and the browser read stored codes, and no
 *    production module but `LEGACY_DECODER_USERS` imports `packages/domain/src/attention-legacy.ts`
 *    (the domain's `attention-legacy` entry, which its index does not re-export). The audit
 *    trail is never rewritten; R-C1's measure decodes its rows there. Tests may import it.
 * 14. The cycle side reads roadmap policy through the scheduler's answer (R-B7, CTRL-13): no
 *    production module of `apps/server/src/services/cycle/` or `apps/server/src/services/run/`,
 *    nor `work-cycle-service.ts`, `agent-run-service.ts`, `workflow-policy.ts` or
 *    `cycle-priority.ts`, imports by value `cycle-ownership.ts` or `roadmap-delegation-policy.ts`,
 *    or `roadmapCarriesRound` from `scope-recovery-policy.ts`: each asks `OwnerPolicy`
 *    (`roadmap/owner-policy.ts`). Outside it by design: `agent-profile-policy.ts` (ADR-064's
 *    layering of a cycle's agents), the scope recovery wait and the launch's scan of decision
 *    preparations (they read every roadmap of the workspace, not an owner) and
 *    `runtime-evidence-service.ts` (R-B7's third part).
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
 *   types. No comment stripping and no quote-only patterns. Rule 8 also reads the modules Git
 *   lists under `scripts/` and `e2e/`, and every declaration file it lists, for what they import
 *   only.
 * - **Tests** are what vitest runs: the `include`, `setupFiles` and `globalSetup` entries of
 *   `vitest.config.ts`, read from its syntax tree. **Test support** is every module that only
 *   tests reach on the resolved import graph. Everything else is production, whatever its name:
 *   a module reached from a production entry (a module nothing imports, or a package's
 *   manifest entry) is production even when it is called `…-test-support.ts`.
 * - **What a build ships** is production too: every module a project of a package production
 *   runs compiles without `noEmit`, which a clean `tsc -b` writes into `dist`. Tests and their
 *   support live in each package's `test/`, which only a `noEmit` project compiles (R-I4,
 *   TS-M14). So a test, a module importing the test runner, or one no declared entry reaches,
 *   built into `dist`, is a finding (rule 6), and such a module is checked as production.
 *
 * Exported functions are tested in check-forbidden-scope.test.mjs on throwaway workspaces.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFlags, SyntaxKind } from 'typescript/unstable/ast';
import { API, SymbolFlags } from 'typescript/unstable/sync';

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
  [
    'packages/git/src/runner.ts',
    'The Git adapter: every daemon Git command, bounded and hardened (R-G10)',
  ],
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

/** The one module that reads a request's path parameters: it parses them for every route (R-H7). */
export const PARAMETER_PARSER = 'apps/server/src/routes/route-access.ts';
export const PROSE_LEGACY_MAPPING_PATH = 'packages/domain/src/attention-legacy.ts';

/**
 * The replays' host pin (rule 12, R-B4b), and the only production modules that import it, each
 * with the one binding it may take: the replay tool sets the pin, the workstation reads it.
 */
export const REPLAY_HOST_PIN = 'apps/server/src/services/replay-host.ts';
export const REPLAY_HOST_USERS = new Map([
  ['apps/server/src/controller-replay.ts', 'pinReplayHost'],
  ['apps/server/src/services/workstation.ts', 'replayHost'],
]);

/**
 * The decoders of text written before codes (rule 13, R-B4b), and the one production module that
 * imports them: the operator-wait measure, for audit rows written before codes.
 */
export const LEGACY_DECODER_USERS = new Set(['apps/server/src/services/operator-wait-service.ts']);
/** The decoders' package entry: matched by name too, as the browser resolves it to `dist`. */
export const LEGACY_DECODER_ENTRY = '@craftingtable/domain/attention-legacy';
const LEGACY_DECODER_FILES = new Set([
  PROSE_LEGACY_MAPPING_PATH,
  'packages/domain/dist/attention-legacy.js',
  'packages/domain/dist/attention-legacy.d.ts',
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
/** Where rule 11 starts: the cycle's decision core and the merge gate (R-B7). */
const CORE_SOURCES = [
  'apps/server/src/services/cycle/core/',
  // The merge gate is pure too (R-B7's scheduler half): the merge executor acts on its answers.
  'apps/server/src/services/merge/gate.ts',
];
/** What no module the cycle core reaches may import (rule 11): the file system and processes. */
const CORE_FORBIDDEN = /^(?:node:)?(?:fs|fs\/promises|child_process)$/;

/** Where rule 10 applies: the daemon's modules (R-B7). */
const CYCLE_FREE_SOURCES = 'apps/server/src/';
/** Rule 14: the modules that read a cycle's owning roadmap only through `OwnerPolicy` (R-B7). */
const OWNER_POLICY_READERS = {
  roots: ['apps/server/src/services/cycle/', 'apps/server/src/services/run/'],
  files: new Set([
    'apps/server/src/services/work-cycle-service.ts',
    'apps/server/src/services/agent-run-service.ts',
    'apps/server/src/services/workflow-policy.ts',
    // The pass's priority, a reader `OwnerPolicy` answers (the review of R-B7's increment 8).
    'apps/server/src/services/cycle-priority.ts',
  ]),
};
/** What those modules may not import by value: the owning roadmap's record and policy. */
export const OWNER_POLICY_SOURCES = new Set([
  'apps/server/src/services/cycle-ownership.ts',
  'apps/server/src/services/roadmap-delegation-policy.ts',
]);
const ROUND_CARRY = {
  module: 'apps/server/src/services/scope-recovery-policy.ts',
  name: 'roadmapCarriesRound',
};
const readsOwnerPolicyOnly = (path) =>
  OWNER_POLICY_READERS.files.has(path) ||
  OWNER_POLICY_READERS.roots.some((root) => path.startsWith(root));

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
const PROSE_LEGACY_MAPPING = PROSE_LEGACY_MAPPING_PATH;
/** The one module that writes map vocabulary, and the table it writes it in (rule 7, R-F2). */
const MAP_VOCABULARY_MODULE = 'packages/domain/src/map-capabilities.ts';
const MAP_VOCABULARY_TABLE = 'V03_VOCABULARY';
/**
 * Identifiers R-F2 retired, which no production module may key on again (rule 7): the plan
 * checkpoint's id, now found by kind and owner, matched anywhere in a text; and the role the
 * undeclared reviewer bypass let through, matched as a whole text, since `review` alone is an
 * agent-run role everywhere.
 */
export const RETIRED_MAP_IDENTIFIERS = [
  { text: 'STACK-PLAN-ACCEPTED', whole: false },
  { text: 'independent-reviewer', whole: true },
];

/** Where rule 8 applies: the packages whose exports read as the vocabulary others use (DATA-15). */
const EXPORTING_SOURCES = /^packages\/(?:domain|contracts|storage)\/src\//;
/** Outside `apps/` and `packages/`, the modules rule 8 reads for what they import. */
const CONSUMER_GROUPS = ['scripts', 'e2e'];
const namedBy = (functions) =>
  `the inferred return types of ${functions} in apps/server/src/services name it`;
/**
 * The exports rule 8 keeps although no other module imports them, by module, name and reason:
 * each is a type a function the server exports names in its inferred return type, so the server's
 * declaration emit (`tsc -b`) must be able to name it (TS4053, TS4058). Adding one is a reviewed
 * decision. Listed rather than detected: the compiler API emits no declarations, and telling which
 * export a declaration error needs means re-checking the server without each one (a type check
 * per export) or reading the error's message text.
 */
export const EMITTED_EXPORTS = new Map([
  [
    'packages/domain/src/execution-scope.ts',
    new Map([
      [
        'RecordedScopeEvidence',
        namedBy('scopeEvidenceIndex and scopeEvidenceLedger (execution-scope.ts)'),
      ],
    ]),
  ],
  [
    'packages/domain/src/execution.ts',
    new Map([['AgentRunEventBase', namedBy('scopeRepairSource (scope-repair.ts)')]]),
  ],
  [
    'packages/domain/src/review.ts',
    new Map([
      ['ReviewReport', namedBy('scopeRepairPacket and scopeRepairSource (scope-repair.ts)')],
    ]),
  ],
  [
    'packages/domain/src/roadmap.ts',
    new Map([['RetiredRoadmapAttempt', namedBy('RoadmapService.page (roadmap-service.ts)')]]),
  ],
  [
    'packages/domain/src/runtime-evidence.ts',
    new Map([
      ...['GeneratedPlanEvidenceV1', 'GeneratedPlanEvidenceV2'].map((name) => [
        name,
        namedBy(
          'scopeEvidenceIndex (execution-scope.ts), submissionSummary and RuntimeEvidenceService methods (runtime-evidence-service.ts)',
        ),
      ]),
      [
        'ArchitectureDecision',
        namedBy(
          'architectureDecisionPacket and decisionPacketEntries (architecture-decision-policy.ts), scopeEvidenceLedger and scopeEvidenceIndex (execution-scope.ts)',
        ),
      ],
    ]),
  ],
]);

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
 * The names a list of specifiers or binding elements takes (`a` of `a as b`), each with the
 * identifier it is bound to (`b`).
 */
const takenNames = (elements) =>
  elements
    .filter((element) => !element.dotDotDotToken)
    .map((element) => ({
      name: (element.propertyName ?? element.name).text,
      local: element.name.kind === SyntaxKind.Identifier ? element.name : undefined,
    }))
    .filter(({ name }) => typeof name === 'string');

/** The node a namespace is read through: past parentheses, `await`, and `typeof` in a type. */
function namespaceUse(node) {
  let outer = node;
  while (
    outer.parent?.kind === SyntaxKind.ParenthesizedExpression ||
    outer.parent?.kind === SyntaxKind.AwaitExpression ||
    outer.parent?.kind === SyntaxKind.ParenthesizedType ||
    (outer.parent?.kind === SyntaxKind.TypeQuery && outer.parent.exprName === outer)
  )
    outer = outer.parent;
  return outer;
}

/**
 * The names a read of a module's namespace takes (rule 8): `ns.a`, `ns['a']`, the type `ns.A`,
 * `(typeof ns)['a']`, and `const { a } = ns`. Each comes with the node, or the binding, its value
 * is read through, for a name that is a namespace itself (`export * as inner`, then
 * `ns.inner.a`). A namespace used whole (`Object.entries(ns)`, a spread, an argument) names none.
 */
function namespaceReads(node) {
  const outer = namespaceUse(node);
  const parent = outer.parent;
  switch (parent?.kind) {
    case SyntaxKind.PropertyAccessExpression:
      return parent.expression === outer ? [{ name: parent.name.text, node: parent }] : [];
    case SyntaxKind.ElementAccessExpression:
      return parent.expression === outer && isLiteral(parent.argumentExpression)
        ? [{ name: parent.argumentExpression.text, node: parent }]
        : [];
    case SyntaxKind.QualifiedName:
      return parent.left === outer ? [{ name: parent.right.text, node: parent }] : [];
    case SyntaxKind.IndexedAccessType:
      return parent.objectType === outer &&
        parent.indexType.kind === SyntaxKind.LiteralType &&
        isLiteral(parent.indexType.literal)
        ? [{ name: parent.indexType.literal.text, node: parent }]
        : [];
    case SyntaxKind.VariableDeclaration:
      return parent.initializer === outer && parent.name.kind === SyntaxKind.ObjectBindingPattern
        ? takenNames(parent.name.elements)
        : [];
    default:
      return [];
  }
}

/**
 * What a module takes by name from a module it imports (rule 8): the names it imports
 * (`{ a, b as c }`, `default`, `import('x').A`, `(typeof import('x'))['a']`, and the reads of an
 * `import()` or `require()` value, `const { a } = await import('x')` or `(await import('x')).a`),
 * and the binding of a namespace (`* as ns`, `const ns = await import('x')`,
 * `import ns = require('x')`) whose reads (`namespaceMembers`) it takes too. A named re-export
 * (`export { a } from`) takes nothing: it is recorded, so a finding can name it.
 */
function taken(node) {
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration: {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      return {
        names: [
          ...(clause?.name ? [{ name: 'default', local: clause.name }] : []),
          ...(bindings?.kind === SyntaxKind.NamedImports ? takenNames(bindings.elements) : []),
        ],
        namespace: bindings?.kind === SyntaxKind.NamespaceImport ? bindings.name : undefined,
      };
    }
    case SyntaxKind.ExportDeclaration:
      return {
        reexports:
          node.exportClause?.kind === SyntaxKind.NamedExports
            ? takenNames(node.exportClause.elements).map(({ name }) => name)
            : [],
      };
    case SyntaxKind.ImportEqualsDeclaration:
      return { names: [], namespace: node.name };
    case SyntaxKind.ImportType: {
      let name = node.qualifier;
      while (name?.kind === SyntaxKind.QualifiedName) name = name.left;
      return { names: name ? [{ name: name.text, node: name }] : namespaceReads(node) };
    }
    default: {
      // `import(…)` or `require(…)`: its value, awaited, is the module's namespace.
      const outer = namespaceUse(node);
      const parent = outer.parent;
      return {
        names: namespaceReads(node),
        namespace:
          parent?.kind === SyntaxKind.VariableDeclaration &&
          parent.initializer === outer &&
          parent.name.kind === SyntaxKind.Identifier
            ? parent.name
            : undefined,
      };
    }
  }
}

/**
 * The reads (`namespaceReads`) of each namespace binding a module declares (rule 8): of each use
 * of its name the compiler resolves to that binding, so another binding of the same name (a
 * parameter, a local, a member) is not read as the namespace.
 */
function namespaceMembers(sourceFile, checker, bindings) {
  const members = new Map(bindings.map((binding) => [binding, []]));
  const names = new Set(bindings.map((binding) => binding.text));
  const uses = [];
  const visit = (node) => {
    if (node.kind === SyntaxKind.Identifier && names.has(node.text) && !members.has(node))
      uses.push(node);
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  if (uses.length === 0) return members;
  const symbols = checker.getSymbolAtLocation([...bindings, ...uses]);
  const bound = new Map();
  bindings.forEach((binding, index) => {
    if (symbols[index] !== undefined) bound.set(symbols[index].id, binding);
  });
  uses.forEach((use, index) => {
    const binding = bound.get(symbols[bindings.length + index]?.id);
    if (binding !== undefined) members.get(binding).push(...namespaceReads(use));
  });
  return members;
}

/**
 * Whether an import or export declaration brings in types alone (rule 11): `import type`,
 * `export type`, or named bindings that are every one `type`. A bare `import './x.js'`, a default
 * or namespace import and `export *` load the module's values.
 */
function typeOnlyDeclaration(node) {
  if (node.kind === SyntaxKind.ExportDeclaration)
    return (
      node.isTypeOnly ||
      (node.exportClause?.kind === SyntaxKind.NamedExports &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly))
    );
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.phaseModifier === SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings?.kind === SyntaxKind.NamedImports &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
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
  const reference = (node, kind, names, typeOnly = false) => {
    if (isLiteral(node)) references.push({ specifier: node.text, node, kind, typeOnly, ...names });
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
        if (node.moduleSpecifier)
          reference(node.moduleSpecifier, 'import', taken(node), typeOnlyDeclaration(node));
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node.moduleReference.kind === SyntaxKind.ExternalModuleReference)
          reference(node.moduleReference.expression, 'require', taken(node), node.isTypeOnly);
        break;
      case SyntaxKind.ImportType:
        if (node.argument?.kind === SyntaxKind.LiteralType && isLiteral(node.argument.literal))
          references.push({
            specifier: node.argument.literal.text,
            node: node.argument.literal,
            typeOnly: true,
            ...taken(node),
          });
        break;
      case SyntaxKind.CallExpression:
        if (node.expression.kind === SyntaxKind.ImportKeyword)
          reference(node.arguments[0], 'import()', taken(node));
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

/** A regular-expression literal's pattern, without its slashes and flags. */
const regexSource = (text) => text.slice(1, text.lastIndexOf('/'));
const isTemplatePart = (node) =>
  node.kind === SyntaxKind.TemplateHead ||
  node.kind === SyntaxKind.TemplateMiddle ||
  node.kind === SyntaxKind.TemplateTail;

/**
 * The texts the vocabulary table's literals match (rule 7): each string, and each regular
 * expression's pattern. Property names are keys, not vocabulary. Undefined when the module
 * declares no such table.
 */
function mapVocabulary(sourceFile) {
  let table;
  const find = (node) => {
    if (
      node.kind === SyntaxKind.VariableDeclaration &&
      node.name.kind === SyntaxKind.Identifier &&
      node.name.text === MAP_VOCABULARY_TABLE
    )
      table = node.initializer;
    else node.forEachChild(find);
  };
  sourceFile.forEachChild(find);
  if (table === undefined) return undefined;
  const texts = [];
  const collect = (node) => {
    if (node.kind === SyntaxKind.PropertyAssignment) return collect(node.initializer);
    if (isLiteral(node)) texts.push(node.text);
    else if (node.kind === SyntaxKind.RegularExpressionLiteral) texts.push(regexSource(node.text));
    node.forEachChild(collect);
  };
  collect(table);
  return [...new Set(texts.filter((text) => text !== ''))];
}

/** Declarations whose name binds an identifier in its scope (rule 7 counts them). */
const DECLARATIONS = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.BindingElement,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.ImportClause,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportEqualsDeclaration,
]);

/**
 * The names rule 7 resolves to constant text: each declared exactly once in the module, by a
 * `const`. A name declared again anywhere (another `const` in another function, a parameter,
 * a `let`, a function, class or import) is left unresolved, since this check reads no scopes.
 */
function constBindings(sourceFile) {
  const declared = new Map();
  const consts = new Map();
  const visit = (node) => {
    if (DECLARATIONS.has(node.kind) && node.name?.kind === SyntaxKind.Identifier) {
      const name = node.name.text;
      declared.set(name, (declared.get(name) ?? 0) + 1);
      if (
        node.kind === SyntaxKind.VariableDeclaration &&
        node.initializer !== undefined &&
        node.parent?.kind === SyntaxKind.VariableDeclarationList &&
        (node.parent.flags & NodeFlags.Const) !== 0
      )
        consts.set(name, node.initializer);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return new Map([...consts].filter(([name]) => declared.get(name) === 1));
}

/**
 * The text of a constant expression, or undefined: a string or template literal, JSX text, a
 * `+` of constant parts, a template whose substitutions are constant, parentheses, or a name
 * `constBindings` resolves to one.
 */
function constantText(node, bindings, seen = new Set()) {
  switch (node?.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.JsxText:
      return node.text;
    case SyntaxKind.ParenthesizedExpression:
      return constantText(node.expression, bindings, seen);
    case SyntaxKind.BinaryExpression: {
      if (node.operatorToken.kind !== SyntaxKind.PlusToken) return undefined;
      const left = constantText(node.left, bindings, seen);
      const right = left === undefined ? undefined : constantText(node.right, bindings, seen);
      return right === undefined ? undefined : left + right;
    }
    case SyntaxKind.TemplateExpression: {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = constantText(span.expression, bindings, seen);
        if (part === undefined) return undefined;
        text += part + span.literal.text;
      }
      return text;
    }
    case SyntaxKind.Identifier: {
      if (seen.has(node.text) || !bindings.has(node.text)) return undefined;
      return constantText(bindings.get(node.text), bindings, new Set([...seen, node.text]));
    }
    default:
      return undefined;
  }
}

/** The vocabulary or retired identifier a constant text holds, if any. */
function vocabularyIn(text, vocabulary) {
  return (
    vocabulary.find((v) => text.includes(v)) ??
    RETIRED_MAP_IDENTIFIERS.find((r) => (r.whole ? text === r.text : text.includes(r.text)))?.text
  );
}

/**
 * The constant texts in a module that write map vocabulary or a retired identifier (rule 7),
 * with what each holds: the outermost constant expression is read, so a concatenation is
 * reported once; template parts and regular-expression patterns are read where nothing folds.
 */
function vocabularyLiterals(sourceFile, vocabulary) {
  const bindings = constBindings(sourceFile);
  const found = [];
  const visit = (node) => {
    // A name is read where its `const` is declared, not again at every use.
    const folded = node.kind === SyntaxKind.Identifier ? undefined : constantText(node, bindings);
    const text =
      folded ??
      (isTemplatePart(node)
        ? node.text
        : node.kind === SyntaxKind.RegularExpressionLiteral
          ? regexSource(node.text)
          : undefined);
    const word = text === undefined ? undefined : vocabularyIn(text, vocabulary);
    if (word !== undefined) {
      found.push({ node, word });
      return;
    }
    // A folded constant's parts hold nothing its whole does not.
    if (folded === undefined) node.forEachChild(visit);
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
 * file no TypeScript project compiles is still checked, and ignored build output is not; and
 * those under `scripts/` and `e2e/`, which rule 8 reads for what they import.
 */
function workspaceFiles(root) {
  const listed = spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...APPLICATION_GROUPS,
      ...CONSUMER_GROUPS,
    ],
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
  const listed = workspaceFiles(root);
  const isSource = (path) =>
    SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) && !isDeclarationFile(path);
  // Rule 8's other readers: the scripts and the end-to-end tests, and every declaration file Git
  // lists (rules 1-7 read none).
  const consumerFiles = listed.filter(
    (path) =>
      (CONSUMER_GROUPS.includes(placeOf(root, path)) && isSource(path)) || isDeclarationFile(path),
  );
  const files = listed.filter((path) => !CONSUMER_GROUPS.includes(placeOf(root, path)));
  // Every project, nested ones (`packages/storage/test/tsconfig.json`) included.
  const configs = files.filter((path) => /^tsconfig.*\.json$/.test(basename(path)));
  const sources = files.filter(isSource);
  const vitestConfig = join(root, VITEST_CONFIG);
  const workspaceEntries = new Map();
  for (const entry of workspaceManifests(root))
    if (typeof entry.manifest.name === 'string')
      workspaceEntries.set(entry.manifest.name, packageEntries(root, entry));
  const api = new API({ cwd: root });
  try {
    let snapshot = api.updateSnapshot({
      openProjects: configs,
      openFiles: [...(existsSync(vitestConfig) ? [vitestConfig] : []), ...consumerFiles],
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
    // The scripts, the end-to-end tests and the declaration files, read in the project the compiler
    // gives each.
    const consumers = [];
    for (const file of consumerFiles) {
      const project = snapshot.getDefaultProjectForFile(file);
      const sourceFile = project?.program.getSourceFile(file);
      if (sourceFile)
        consumers.push({
          file,
          project,
          sourceFile,
          ...readModule(sourceFile),
          imports: new Set(),
        });
    }
    // Resolve every literal specifier and every `require`, one compiler call per project.
    const byProject = new Map();
    for (const module of [...modules.values(), ...consumers]) {
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
            module.references.push({
              specifier: call.arguments[0].text,
              node: call.arguments[0],
              ...taken(call),
            });
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
        ref.target = target;
        if (target !== undefined) module.imports.add(target);
      });
    }
    // A module named by `new URL(…, import.meta.url)` is loaded by the one naming it.
    for (const module of modules.values())
      for (const url of module.urls) {
        const target = onDisk(module.file, url);
        if (target !== undefined && modules.has(target)) module.imports.add(target);
      }
    // Rule 8: what each module exports, resolved by the compiler through re-exports and barrels to
    // the declaration (its source module and name), read once per module. A name that resolves to
    // a module (`export * as inner`, or an imported namespace exported again) is that module's
    // namespace, read by name in turn.
    const tables = new Map();
    const exportTable = (file) => {
      if (tables.has(file)) return tables.get(file);
      const table = new Map();
      tables.set(file, table);
      const module = modules.get(file);
      if (module === undefined) return table;
      const { checker } = module.project;
      const symbol = checker.getSymbolAtLocation(module.sourceFile);
      for (const exported of symbol === undefined ? [] : checker.getExportsOfModule(symbol)) {
        const declared =
          exported.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const declaration = declared.declarations?.[0];
        const source =
          declaration?.path &&
          (sourceModule(declaration.path, projects, modules) ?? declaration.path);
        if (source)
          table.set(exported.name, {
            file: source,
            key: `${source}#${declared.name}`,
            namespace: declaration.kind === SyntaxKind.SourceFile,
          });
      }
      return table;
    };
    // What each module of the domain, contracts and storage packages declares and exports.
    const exported = new Map();
    for (const file of modules.keys())
      if (EXPORTING_SOURCES.test(posix(relative(root, file))))
        exported.set(
          file,
          [...exportTable(file)]
            .filter(([, declared]) => declared.file === file)
            .map(([name, declared]) => ({ name, key: declared.key })),
        );
    // The declarations other modules take by name. A named re-export (`export { a } from`) takes
    // nothing: a module importing the name through it takes the declaration, which the compiler
    // resolves through it. Who re-exports each one is kept for the finding.
    const consumed = new Set();
    const reexported = new Map();
    for (const module of [...modules.values(), ...consumers]) {
      // Each binding of a module's namespace, and that module.
      const namespaces = new Map();
      const take = (target, reads) => {
        for (const { name, node, local } of reads) {
          const declared = exportTable(target).get(name);
          if (declared === undefined || declared.file === module.file) continue;
          if (!declared.namespace) consumed.add(declared.key);
          else {
            if (node !== undefined) take(declared.file, namespaceReads(node));
            if (local !== undefined) namespaces.set(local, declared.file);
          }
        }
      };
      for (const ref of module.references) {
        if (ref.target === undefined) continue;
        for (const name of ref.reexports ?? []) {
          const declared = exportTable(ref.target).get(name);
          if (declared === undefined || declared.file === module.file) continue;
          if (!reexported.has(declared.key)) reexported.set(declared.key, new Set());
          reexported.get(declared.key).add(posix(relative(root, module.file)));
        }
        if (ref.namespace !== undefined) namespaces.set(ref.namespace, ref.target);
        take(ref.target, ref.names ?? []);
      }
      // Read each namespace's names; one taken from it may be a namespace in turn
      // (`const { inner } = ns`), read in another pass.
      const read = new Set();
      for (;;) {
        const bindings = [...namespaces.keys()].filter((binding) => !read.has(binding));
        if (bindings.length === 0) break;
        for (const binding of bindings) read.add(binding);
        const members = namespaceMembers(module.sourceFile, module.project.checker, bindings);
        for (const [binding, reads] of members) take(namespaces.get(binding), reads);
      }
    }
    let tests = [];
    if (existsSync(vitestConfig)) {
      const project = snapshot.getDefaultProjectForFile(vitestConfig);
      const sourceFile = project?.program.getSourceFile(vitestConfig);
      if (sourceFile) tests = vitestEntries(sourceFile);
    }
    // Rule 9 asks the compiler what each `params` member is, while it is still open.
    for (const module of modules.values()) module.parameterReads = requestParameterReads(module);
    return { projects, modules, tests, exported, consumed, reexported };
  } finally {
    api.close();
  }
}

/**
 * What a build ships (R-I4): every module a project of a package production runs compiles and
 * emits (no `noEmit`), mapped to where it is emitted. A clean `tsc -b` writes exactly these
 * into the packages' `dist`.
 */
function builtModules(root, projects, modules) {
  const running = productionPackages(workspaceManifests(root));
  const built = new Map();
  for (const project of projects) {
    const { noEmit, outDir } = project.compilerOptions;
    if (noEmit === true) continue;
    for (const file of project.rootFiles)
      if (modules.has(file) && running.has(placeOf(root, file)))
        built.set(file, outDir === undefined ? 'its own directory' : posix(relative(root, outDir)));
  }
  return built;
}

/**
 * Which modules are production: everything reached on the import graph from a production
 * entry. An entry is the manifest entry of a package production runs (`productionPackages`),
 * the module a page loads, a module a production build emits (`builtModules`), or a module
 * that is not a test and that no module imports (an application entry, a launcher's target, or
 * dead code). What only tests and vitest's setup modules reach is test support; what nothing
 * reaches is production too. For rule 6, `onlyTestsReach` is what tests and `test/` harnesses
 * reach and no declared entry does, and `unreached` what neither reaches: among built modules,
 * each is a finding of `buildFindings`.
 */
function productionModules(root, projects, modules, tests, built) {
  const testFiles = new Set(
    [...modules.keys()].filter((file) => isTestEntry(posix(relative(root, file)), tests)),
  );
  const imported = new Set();
  for (const module of modules.values()) for (const target of module.imports) imported.add(target);
  const unimported = [...modules.keys()].filter(
    (file) => !imported.has(file) && !testFiles.has(file),
  );
  // The entries the workspace declares: production packages' manifests, and pages.
  const declared = [];
  const manifests = workspaceManifests(root);
  const running = productionPackages(manifests);
  for (const { directory, manifest } of manifests) {
    for (const entry of running.has(directory) ? manifestEntries(manifest) : []) {
      // A manifest names the build output; its module is the source the project compiles.
      const source = sourceModule(resolve(root, directory, entry), projects, modules);
      if (source !== undefined) declared.push(source);
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
      if (modules.has(path)) declared.push(path);
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
  const entries = [...unimported, ...declared];
  // Rule 6 starts only from the entries the workspace declares, never from a module merely
  // because nothing imports it: an unimported module in `src` is dead code or a harness, and
  // the build would ship it. A built module named as a test that vitest does not run (one left
  // in `src` by a move) is a test to it, and so is a declared entry in a package's `test/`
  // (the e2e daemon a manifest script starts): what only they reach is test-only.
  const strayTests = new Set(
    [...built.keys()].filter((file) => !testFiles.has(file) && TEST_NAME.test(file)),
  );
  const harnesses = new Set(
    declared.filter((file) => TEST_DIRECTORY.test(posix(relative(root, file)))),
  );
  const testOnly = (file) => testFiles.has(file) || strayTests.has(file) || harnesses.has(file);
  const fromTests = reach([...testFiles, ...strayTests, ...harnesses]);
  const supportOutside = (fromEntries) =>
    new Set([...fromTests].filter((file) => !fromEntries.has(file) && !testOnly(file)));
  const fromDeclared = reach(declared.filter((file) => !harnesses.has(file)));
  // What tests alone reach among the modules a build ships: by the graph it is test support.
  const onlyTestsReach = supportOutside(fromDeclared);
  // What a build ships that neither a declared entry nor a test reaches.
  const unreached = new Set(
    [...built.keys()].filter(
      (file) => !fromDeclared.has(file) && !fromTests.has(file) && !strayTests.has(file),
    ),
  );
  // A module a production build ships is production, whoever imports it (R-I4): so a module
  // loaded only through a path built at runtime, and imported by a test, is checked too.
  const fromEntries = reach([...entries, ...[...built.keys()].filter((f) => !testFiles.has(f))]);
  // Fail closed: test support is what tests reach and no entry does. Whatever neither reaches
  // (a module that imports itself, a cycle nothing else imports) is checked as production.
  const support = supportOutside(fromEntries);
  const production = new Set(
    [...modules.keys()].filter(
      (file) => fromEntries.has(file) || (!testFiles.has(file) && !support.has(file)),
    ),
  );
  return { production, tests: testFiles, strayTests, onlyTestsReach, unreached };
}

/** The test runners: vitest, and the two a test might reach for instead. */
const TEST_RUNNER = /^(?:vitest|@vitest\/[^/]+|@playwright\/test|node:test)(?:\/.*)?$/;
/** A module named as a test (`x.test.ts`, `x.spec.tsx`), whether or not vitest runs it. */
const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** A package's `test/` directory, where its tests and test support live (R-I4). */
const TEST_DIRECTORY = /^(?:apps|packages)\/[^/]+\/test\//;

/**
 * Nothing test-only in what a production build ships (R-I4, TS-M14): no test, no module that
 * imports the test runner, and no module only tests import. Tests and their support live in
 * each package's `test/`, which no production build emits.
 */
function buildFindings(root, modules, classified, built) {
  const findings = [];
  for (const [file, outDir] of built) {
    const path = posix(relative(root, file));
    // Already in `test/`: the fix is the production project, which must not compile it.
    const keepOut = TEST_DIRECTORY.test(path)
      ? "keep the package's test/ directory out of its production tsconfig.json"
      : undefined;
    if (classified.tests.has(file) || classified.strayTests.has(file)) {
      const what = classified.tests.has(file)
        ? 'a test'
        : 'named as a test, though vitest does not run it,';
      findings.push(
        `${path}: ${what} built into ${outDir}; ${keepOut ?? "tests live in the package's test/ directory"}`,
      );
      continue;
    }
    // A `/// <reference types="vitest" />` names the runner as an import type does.
    for (const { fileName } of modules.get(file).sourceFile.typeReferenceDirectives ?? [])
      if (TEST_RUNNER.test(fileName))
        findings.push(
          `${path}: references the test runner's types "${fileName}" and is built into ${outDir}`,
        );
    for (const { specifier } of modules.get(file).references)
      if (TEST_RUNNER.test(specifier))
        findings.push(
          `${path}: imports the test runner "${specifier}" and is built into ${outDir}`,
        );
    if (classified.unreached.has(file))
      findings.push(
        `${path}: no declared entry reaches it, yet it is built into ${outDir}; import it from production, name it with new URL(…, import.meta.url) from the module that loads it, or move it to the package's test/ directory`,
      );
    if (classified.onlyTestsReach.has(file))
      findings.push(
        `${path}: only tests import it, yet it is built into ${outDir}; ${keepOut ?? "move it to the package's test/ directory, or name it with new URL(…, import.meta.url) from the module that loads it"}`,
      );
  }
  return findings;
}

/**
 * Rule 10: the strongly connected sets of the daemon's import graph (Tarjan's algorithm, without
 * recursion), each a finding with one path round it.
 */
function cycleFindings(root, modules, production) {
  const name = (file) => posix(relative(root, file));
  const nodes = [...production]
    .filter((file) => modules.has(file) && name(file).startsWith(CYCLE_FREE_SOURCES))
    .sort();
  const inGraph = new Set(nodes);
  const edges = new Map(
    nodes.map((file) => [
      file,
      [...modules.get(file).imports].filter((t) => inGraph.has(t)).sort(),
    ]),
  );
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const sets = [];
  let next = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, at] = frame;
      const targets = edges.get(node);
      if (at < targets.length) {
        frame[1] += 1;
        const target = targets[at];
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next++);
          stack.push(target);
          onStack.add(target);
          work.push([target, 0]);
        } else if (onStack.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) !== index.get(node)) continue;
      const set = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        set.push(member);
        if (member === node) break;
      }
      if (set.length > 1 || edges.get(node).includes(node)) sets.push(set.sort());
    }
  }
  /** The shortest path from a set's first module back to it, through the set. */
  const round = (set) => {
    const members = new Set(set);
    const from = new Map([[set[0], undefined]]);
    const queue = [set[0]];
    while (queue.length > 0) {
      const node = queue.shift();
      for (const target of edges.get(node)) {
        if (!members.has(target)) continue;
        if (target === set[0]) {
          const path = [node];
          while (from.get(path[0]) !== undefined) path.unshift(from.get(path[0]));
          return [...path, set[0]].map(name);
        }
        if (!from.has(target)) {
          from.set(target, node);
          queue.push(target);
        }
      }
    }
    return set.map(name);
  };
  const findings = [];
  for (const set of sets)
    findings.push(
      `${name(set[0])}: import cycle among ${set.length} module${set.length === 1 ? '' : 's'} (${set.map(name).join(', ')}), one path round it ${round(set).join(' → ')}; move what they share into a module none of them imports back (R-B7)`,
    );
  return findings;
}

/**
 * Rule 11: what the cycle core reaches by value imports within the daemon, breadth first so each
 * finding names the shortest path from the core; a service, or an import of the file system or
 * processes, is a finding.
 */
function coreFindings(root, modules, production) {
  const name = (file) => posix(relative(root, file));
  const starts = [...production]
    .filter(
      (file) => modules.has(file) && CORE_SOURCES.some((start) => name(file).startsWith(start)),
    )
    .sort();
  const from = new Map(starts.map((file) => [file, undefined]));
  const queue = [...starts];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const ref of modules.get(file).references) {
      const target = ref.target;
      if (ref.typeOnly || target === undefined || from.has(target) || !modules.has(target))
        continue;
      if (!name(target).startsWith(CYCLE_FREE_SOURCES)) continue;
      from.set(target, file);
      queue.push(target);
    }
  }
  const path = (file) => {
    const chain = [];
    for (let at = file; at !== undefined; at = from.get(at)) chain.unshift(name(at));
    return chain.join(' → ');
  };
  const findings = [];
  for (const file of [...from.keys()].sort()) {
    if (file.endsWith('-service.ts'))
      findings.push(
        `${name(file)}: a service the cycle core or the merge gate reaches by value imports (${path(file)}); the core decides and the services act, so take what it needs from a module of its own (R-B7)`,
      );
    for (const ref of modules.get(file).references)
      if (!ref.typeOnly && CORE_FORBIDDEN.test(ref.specifier))
        findings.push(
          `${name(file)}: imports "${ref.specifier}", and the cycle core or the merge gate reaches it by value imports (${path(file)}); keep file and process access out of the core's reach (R-B7)`,
        );
  }
  return findings;
}

/** The workspace package (`packages/storage`) or top-level directory a path is in. */
function placeOf(root, path) {
  const [group, name] = posix(relative(root, path)).split('/');
  return APPLICATION_GROUPS.includes(group) ? `${group}/${name}` : group;
}

/**
 * Rule 9 (R-H7): the nodes of a module that read a request's path parameters (a member named
 * `params` the compiler resolves to the property Fastify's `FastifyRequest` declares), and those
 * that type them (a type argument of a generic Fastify declares whose type has `Params`).
 */
function requestParameterReads(module) {
  const { sourceFile, project } = module;
  const named = [];
  const destructured = [];
  // Each generic given type arguments, by the name its declaration is found from: a call
  // (`app.get<…>(…)`), a type (`FastifyRequest<…>`) or a heritage clause (`extends X<…>`).
  const generics = [];
  const visit = (node) => {
    if (node.typeArguments?.length) {
      const owner =
        node.kind === SyntaxKind.CallExpression ||
        node.kind === SyntaxKind.ExpressionWithTypeArguments
          ? node.expression
          : node.kind === SyntaxKind.TypeReference
            ? node.typeName
            : undefined;
      const name =
        owner?.kind === SyntaxKind.PropertyAccessExpression
          ? owner.name
          : owner?.kind === SyntaxKind.QualifiedName
            ? owner.right
            : owner;
      if (name?.kind === SyntaxKind.Identifier) generics.push([node, name]);
    }
    if (node.kind === SyntaxKind.PropertyAccessExpression && node.name.text === 'params')
      named.push([node, node.name]);
    else if (
      node.kind === SyntaxKind.ElementAccessExpression &&
      isLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'params'
    )
      named.push([node, node.argumentExpression]);
    else if (
      node.kind === SyntaxKind.BindingElement &&
      node.parent.kind === SyntaxKind.ObjectBindingPattern &&
      !node.dotDotDotToken &&
      (node.propertyName ?? node.name).kind === SyntaxKind.Identifier &&
      (node.propertyName ?? node.name).text === 'params'
    )
      destructured.push(node);
    node.forEachChild(visit);
  };
  visit(sourceFile);
  if (named.length === 0 && destructured.length === 0 && generics.length === 0)
    return { reads: [], typed: [] };
  const checker = project.checker;
  const fastifyDeclared = (symbol) => {
    const target =
      symbol !== undefined && symbol.flags & SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    return (
      target?.declarations.some((declaration) =>
        posix(declaration.path).includes('/node_modules/fastify/'),
      ) === true
    );
  };
  const isRequestParams = (symbol) =>
    symbol !== undefined &&
    symbol.name === 'params' &&
    symbol.getParent()?.name === 'FastifyRequest' &&
    symbol.declarations.some((declaration) =>
      posix(declaration.path).includes('/node_modules/fastify/'),
    );
  const reads = [];
  const symbols = named.length ? checker.getSymbolAtLocation(named.map(([, name]) => name)) : [];
  named.forEach(([node], index) => {
    if (isRequestParams(symbols[index])) reads.push(node);
  });
  for (const node of destructured) {
    const type = checker.getTypeAtLocation(node.parent);
    if (type !== undefined && isRequestParams(checker.getPropertyOfType(type, 'params')))
      reads.push(node);
  }
  const owners = generics.length
    ? checker.getSymbolAtLocation(generics.map(([, name]) => name))
    : [];
  const typed = [];
  generics.forEach(([node], index) => {
    if (!fastifyDeclared(owners[index])) return;
    for (const argument of node.typeArguments) {
      const type = checker.getTypeFromTypeNode(argument);
      const params = type === undefined ? undefined : checker.getPropertyOfType(type, 'Params');
      // Fastify's own route generic declares an optional `Params`; only a route's own counts.
      if (
        params?.declarations.some(
          (declaration) => !posix(declaration.path).includes('/node_modules/fastify/'),
        )
      )
        typed.push(argument);
    }
  });
  return { reads, typed };
}

/**
 * Rule 12 (R-B4b): what a production module's reference to the replays' host pin may be. Only a
 * listed user may import it, by name and only its own binding; a namespace or a re-export would
 * hand the pin on to modules the rule cannot see.
 */
function replayHostFindings(path, reference) {
  const allowed = REPLAY_HOST_USERS.get(path);
  if (allowed === undefined)
    return [
      `${path}: imports the replay host pin (${REPLAY_HOST_PIN}); only the replay tool sets it and only the workstation reads it, so the daemon compares native approvals with the live host digest (R-B4b)`,
    ];
  const names = (reference.names ?? []).map(({ name }) => name);
  if (
    reference.reexports !== undefined ||
    reference.namespace !== undefined ||
    names.length === 0 ||
    names.some((name) => name !== allowed)
  )
    return [
      `${path}: takes more of the replay host pin (${REPLAY_HOST_PIN}) than its own \`${allowed}\`, or hands it on; import that binding by name alone (R-B4b)`,
    ];
  return [];
}

/**
 * Rule 12's other half: a listed user re-exports none of the pin's bindings it imported
 * (`export { replayHost }`, `export default replayHost`).
 */
function replayHostReexports(path, module, root) {
  if (!REPLAY_HOST_USERS.has(path)) return [];
  const local = new Set(
    module.references
      .filter(
        (r) => r.resolved !== undefined && posix(relative(root, r.resolved)) === REPLAY_HOST_PIN,
      )
      .flatMap((r) => (r.names ?? []).map(({ local, name }) => local?.text ?? name)),
  );
  const findings = [];
  for (const statement of module.sourceFile.statements) {
    const names =
      statement.kind === SyntaxKind.ExportDeclaration && !statement.moduleSpecifier
        ? statement.exportClause?.kind === SyntaxKind.NamedExports
          ? statement.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
          : []
        : statement.kind === SyntaxKind.ExportAssignment &&
            statement.expression.kind === SyntaxKind.Identifier
          ? [statement.expression.text]
          : [];
    if (names.some((name) => local.has(name)))
      findings.push(
        `${path}:${lineOf(module.sourceFile, statement)}: re-exports the replay host pin's binding; it must not leave this module (R-B4b)`,
      );
  }
  return findings;
}

/** One module's findings under rules 1-5, 7, 9, 12, 13 and 14. */
function moduleFindings(root, module, production, vocabulary) {
  const findings = [];
  const path = posix(relative(root, module.file));
  const { sourceFile } = module;
  if (sourceFile.text.includes('\0')) return [`${path}: contains a NUL byte`];
  const owningPackage = placeOf(root, module.file);
  const authority = PROCESS_AUTHORITY.has(path);
  for (const reference of module.references) {
    const { specifier, resolved } = reference;
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
    if (targetPath === REPLAY_HOST_PIN) findings.push(...replayHostFindings(path, reference));
    if (
      !reference.typeOnly &&
      targetPath !== undefined &&
      readsOwnerPolicyOnly(path) &&
      (OWNER_POLICY_SOURCES.has(targetPath) ||
        (targetPath === ROUND_CARRY.module &&
          (reference.namespace !== undefined ||
            (reference.names ?? []).some(({ name }) => name === ROUND_CARRY.name) ||
            // A re-export of it, or of the whole module (`export *`, which records no names).
            (reference.reexports !== undefined &&
              (reference.reexports.length === 0 ||
                reference.reexports.includes(ROUND_CARRY.name))))))
    )
      findings.push(
        `${path}: imports the owning roadmap's policy from ${targetPath}; the cycle side asks the scheduler's answer, \`ownerPolicy\` (apps/server/src/services/roadmap/owner-policy.ts) (R-B7)`,
      );
    if (
      (specifier === LEGACY_DECODER_ENTRY ||
        (targetPath !== undefined && LEGACY_DECODER_FILES.has(targetPath))) &&
      !LEGACY_DECODER_USERS.has(path)
    )
      findings.push(
        `${path}: imports the decoders of text written before codes (${PROSE_LEGACY_MAPPING_PATH}); every stored record is coded since migration 0047, so read its stored code, as only the operator-wait measure decodes audit rows (R-B4b)`,
      );
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
  findings.push(...replayHostReexports(path, module, root));
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
  if (path !== PARAMETER_PARSER) {
    const { reads, typed } = module.parameterReads;
    const lines = new Set(reads.map((node) => lineOf(sourceFile, node)));
    for (const line of [...lines].sort((a, b) => a - b))
      findings.push(
        `${path}:${line}: reads a request's path parameters; read the values the daemon parsed with paramsOf (R-H7)`,
      );
    const typedLines = new Set(typed.map((node) => lineOf(sourceFile, node)));
    for (const line of [...typedLines].sort((a, b) => a - b))
      findings.push(
        `${path}:${line}: types a request's path parameters (\`Params\`); declare them in the route's config and read them with paramsOf (R-H7)`,
      );
  }
  if (path !== MAP_VOCABULARY_MODULE && path !== PROSE_LEGACY_MAPPING)
    for (const { node, word } of vocabularyLiterals(sourceFile, vocabulary))
      findings.push(
        `${path}:${lineOf(sourceFile, node)}: writes map vocabulary "${word}"; ask ${MAP_VOCABULARY_MODULE} what the map declares`,
      );
  return findings;
}

/**
 * Rule 8 (DATA-15): each export a production module of the domain, contracts and storage packages
 * declares is taken by another module, or kept by an exception that gives its reason. An exception
 * for a production module that does not export that name unimported is a finding too. A finding
 * names the modules that only re-export the name, which must go with the `export`.
 */
function exportFindings(root, exported, consumed, reexported, production, exceptions) {
  const findings = [];
  const kept = new Set();
  for (const [file, declarations] of exported) {
    if (!production.has(file)) continue;
    const path = posix(relative(root, file));
    for (const { name, key } of declarations) {
      if (consumed.has(key)) continue;
      const reason = exceptions.get(path)?.get(name);
      const reexports = [...(reexported.get(key) ?? [])].sort().map((file) => `\`${file}\``);
      if (reason === undefined)
        findings.push(
          reexports.length === 0
            ? `\`${name}\` is exported by \`${path}\` but no other module imports it; drop the \`export\` (DATA-15)`
            : `\`${name}\` is exported by \`${path}\` but no other module imports it, only re-exports it (${reexports.join(', ')}); drop the re-exports and the \`export\` (DATA-15)`,
        );
      else {
        kept.add(`${path}#${name}`);
        if (typeof reason !== 'string' || reason.trim() === '')
          findings.push(
            `\`${name}\` is kept exported by \`${path}\` without a reason; say what needs it, or drop the \`export\` (DATA-15)`,
          );
      }
    }
  }
  for (const [path, names] of exceptions)
    if (production.has(join(root, path)))
      for (const name of names.keys())
        if (!kept.has(`${path}#${name}`))
          findings.push(
            `\`${name}\` is kept exported by \`${path}\`, which exports no such declaration that no other module imports; drop the exception (DATA-15)`,
          );
  return findings;
}

/**
 * Checks a workspace. Returns the findings, how each module was classified (its path from
 * the root mapped to `production`, `test` or `test-support`) and the map vocabulary rule 7
 * read, so tests can see what was read. Rule 8 keeps the `exceptions` given (by default,
 * `EMITTED_EXPORTS`).
 */
export function inspectWorkspace(root, exceptions = EMITTED_EXPORTS) {
  const absoluteRoot = realpathSync(resolve(root));
  const findings = manifestFindings(absoluteRoot);
  const { projects, modules, tests, exported, consumed, reexported } = readWorkspace(absoluteRoot);
  const built = builtModules(absoluteRoot, projects, modules);
  const classified = productionModules(absoluteRoot, projects, modules, tests, built);
  findings.push(...buildFindings(absoluteRoot, modules, classified, built));
  findings.push(
    ...exportFindings(
      absoluteRoot,
      exported,
      consumed,
      reexported,
      classified.production,
      exceptions,
    ),
  );
  findings.push(...cycleFindings(absoluteRoot, modules, classified.production));
  findings.push(...coreFindings(absoluteRoot, modules, classified.production));
  // Rule 7 reads the vocabulary where it is declared; a workspace without the module has none.
  const vocabularyModule = [...modules.values()].find(
    (module) => posix(relative(absoluteRoot, module.file)) === MAP_VOCABULARY_MODULE,
  );
  const vocabulary = vocabularyModule && mapVocabulary(vocabularyModule.sourceFile);
  if (vocabularyModule && !vocabulary?.length)
    findings.push(
      `${MAP_VOCABULARY_MODULE}: declares no ${MAP_VOCABULARY_TABLE} literals, so map vocabulary cannot be confined`,
    );
  const classes = new Map();
  for (const module of modules.values()) {
    const production = classified.production.has(module.file);
    classes.set(
      posix(relative(absoluteRoot, module.file)),
      production ? 'production' : classified.tests.has(module.file) ? 'test' : 'test-support',
    );
    findings.push(...moduleFindings(absoluteRoot, module, production, vocabulary ?? []));
  }
  return { findings, classes, vocabulary: vocabulary ?? [] };
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
    `${PROCESS_AUTHORITY.size} listed modules, planning and domain packages pure, no branching on reason or message text, map vocabulary only in ${MAP_VOCABULARY_MODULE}, request path parameters read only in ${PARAMETER_PARSER}, every export of domain, contracts and storage imported elsewhere or listed (${[...EMITTED_EXPORTS.values()].reduce((n, names) => n + names.size, 0)} kept for declaration emit), no import cycle among the daemon's modules, the cycle core free of services and of file and process access, the replays' host pin imported only by the replay tool and the workstation, the decoders of text before codes imported only by the operator-wait measure, the cycle side reading roadmap policy only through OwnerPolicy, and dist holds no test or test-runner import and only modules a manifest or page entry reaches.`,
  );
}
