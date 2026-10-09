import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Each daemon decision command is posted from exactly one component (R-A6; P3's exit criterion).
 * A decision command is R-A6's table plus every command that resolves an operator-owned stop
 * (operator decision 2026-10-06, A1). Configuration and manual controls are not on the list.
 *
 * The test reads every module's syntax tree. A command is found by its route at the end of a URL:
 * a string or template literal holding a `/` (a substitution reads as `*`), outside the text of a
 * JSX attribute. The top-level declaration holding the URL is its poster; a helper
 * that is not a component posts through every component that references it, in its own module
 * or, when exported, in a module that imports it. Each command must resolve to its one owner,
 * a component in `decisions/<kind>/`.
 */
type Command = {
  readonly command: string;
  /** Matched against a whole URL or path text. */
  readonly route: RegExp;
  /** `decisions/<kind>/<File>.tsx#Component`. */
  readonly owner: string;
};
const tail = (path: string) => new RegExp(`/${path}$`);
const COMMANDS: readonly Command[] = [
  {
    command: 'runtime/decide',
    route: tail('decide'),
    owner: 'decisions/evidence/EvidenceDecision.tsx#EvidenceDecision',
  },
  {
    command: 'runtime/propose-decision',
    route: tail('propose-decision'),
    owner: 'decisions/architecture/SaveProposal.tsx#SaveProposal',
  },
  {
    command: 'roadmaps/:id/prepare-decision',
    route: tail('prepare-decision'),
    owner: 'decisions/preparation/PrepareDecisionBrief.tsx#PrepareDecisionBrief',
  },
  {
    command: 'roadmaps/:id/decision-preparation-grant',
    route: tail('decision-preparation-grant'),
    owner: 'decisions/preparation/PrepareDecisionBrief.tsx#StandingPreparation',
  },
  {
    command: 'repositories/:id/checks/adopt',
    route: tail('checks/adopt'),
    owner: 'decisions/checks/CheckAdoption.tsx#AdoptChecks',
  },
  {
    command: 'worktrees/:id/merge',
    route: tail('worktrees/\\*/merge'),
    owner: 'decisions/merge/MergeApproval.tsx#MergeApproval',
  },
  {
    command: 'cycles/:id/integration-resolution',
    route: tail('integration-resolution'),
    owner: 'decisions/integration/IntegrationConflict.tsx#IntegrationConflict',
  },
  {
    command: 'cycles/:id/design-recovery',
    route: tail('design-recovery'),
    owner: 'decisions/design/DesignQuestions.tsx#DesignQuestions',
  },
  {
    command: 'cycles/:id/baseline-preparation',
    route: tail('baseline-preparation'),
    owner: 'decisions/design/BaselinePreparation.tsx#BaselinePreparation',
  },
  {
    command: 'cycles/:id/scope-repair',
    route: tail('scope-repair'),
    owner: 'decisions/scope-repair/ScopeRepair.tsx#ScopeRepair',
  },
  {
    command: 'cycles/:id/investigation',
    route: /\/investigation(\/[a-z-]+)?$/,
    owner: 'decisions/cycle/CycleInvestigation.tsx#CycleInvestigation',
  },
  {
    command: 'runtime/authorize-native and runtime/audit-native',
    route: tail('(authorize|audit)-native'),
    owner: 'decisions/environment/EnvironmentApproval.tsx#EnvironmentApproval',
  },
  {
    command: 'runtime/declare-transitions',
    route: tail('declare-transitions'),
    owner: 'decisions/upstream/UpstreamTransitions.tsx#UpstreamTransitions',
  },
  {
    command: 'runtime/preview-refresh and runtime/refresh',
    route: tail('(preview-)?refresh'),
    owner: 'decisions/refresh/DependencyRefresh.tsx#DependencyRefresh',
  },
  {
    command: 'roadmaps/:id/amendments, its preview and its decision',
    route: /\/amendments(\/[a-z-]+)?$/,
    owner: 'decisions/amendment/AmendmentDecision.tsx#AmendmentDecision',
  },
  {
    command: 'runtime/prepare-checkpoint',
    route: tail('prepare-checkpoint'),
    owner: 'decisions/checkpoint/CheckpointPreparation.tsx#CheckpointPreparation',
  },
  {
    command: 'runtime/generate-plan (plan-acceptance evidence for review)',
    route: tail('generate-plan'),
    owner: 'decisions/plan-acceptance/PlanAcceptance.tsx#PlanAcceptance',
  },
  {
    command: 'runtime/submit (checkpoint or qualification evidence for review)',
    route: tail('submit'),
    owner: 'decisions/evidence/SubmitEvidence.tsx#SubmitEvidence',
  },
  // Commands that resolve an operator-owned stop outside R-A6's table (A1, 2026-10-06).
  {
    command: 'concurrency-definitions/:id/supervision/adopt (scheduling proposals)',
    route: tail('supervision/adopt'),
    owner: 'decisions/adoption/MapAdoption.tsx#MapAdoption',
  },
  {
    command: 'worktrees/:id/scope-evidence',
    route: tail('scope-evidence'),
    owner: 'decisions/scope-evidence/RecordScopeEvidence.tsx#RecordScopeEvidence',
  },
  {
    command: 'work-items/:id/scope-scheduling (early-development authorization)',
    route: tail('scope-scheduling'),
    owner: 'decisions/early-development/AuthorizeEarlyDevelopment.tsx#AuthorizeEarlyDevelopment',
  },
  {
    command: 'roadmaps/:id/delegation',
    route: tail('delegation'),
    owner: 'decisions/delegation/RoadmapDelegation.tsx#RoadmapDelegation',
  },
  {
    command: 'protected-ref-moves/acknowledge',
    route: tail('protected-ref-moves/acknowledge'),
    owner: 'decisions/acknowledge/AcknowledgeMoves.tsx#AcknowledgeMoves',
  },
];

/** Routes whose command is in the body (`action`): their posters, and who names each decision. */
const SHARED: readonly {
  readonly command: string;
  readonly route: RegExp;
  readonly posters: readonly string[];
  readonly decisions: Readonly<Record<string, string>>;
}[] = [
  {
    command: 'cycles/:id/control',
    route: /\/cycles\/\*\/control$/,
    posters: [
      'decisions/cycle/CycleDecisions.tsx#CycleContinuation',
      'decisions/cycle/CycleDecisions.tsx#CycleControlButtons',
      'decisions/cycle/CycleDecisions.tsx#ProviderRetry',
    ],
    decisions: {
      'authorize-remediation': 'decisions/cycle/CycleDecisions.tsx#CycleContinuation',
      'review-again': 'decisions/cycle/CycleDecisions.tsx#CycleContinuation',
      'retry-provider': 'decisions/cycle/CycleDecisions.tsx#ProviderRetry',
    },
  },
  {
    command: 'finalizations/:id/control',
    route: /\/finalizations\/\*\/control$/,
    posters: [
      'decisions/finalization/FinalPromotion.tsx#FinalPromotion',
      'decisions/finalization/FinalizationStep.tsx#FinalizationStep',
      'features/execution/FinalizationPanel.tsx#FinalizationPanel',
    ],
    decisions: {
      merge: 'decisions/finalization/FinalPromotion.tsx#FinalPromotion',
      'select-stage-findings': 'decisions/finalization/FinalizationStep.tsx#FinalizationStep',
      'approve-plan-change': 'decisions/finalization/FinalizationStep.tsx#FinalizationStep',
      'remediate-findings': 'decisions/finalization/FinalizationStep.tsx#FinalizationStep',
      'authorize-remediation': 'decisions/finalization/FinalizationStep.tsx#FinalizationStep',
      resume: 'decisions/finalization/FinalizationStep.tsx#FinalizationStep',
    },
  },
];

/** Last segments several routes share, and the whole routes a URL ending in one may name. */
/**
 * The URLs (and `/`-holding texts) whose last segment is built at run time, each read here, so a
 * new one fails the test until it is classified (R-A6 review M2). None posts a decision command.
 */
const DYNAMIC_TAILS: readonly string[] = [
  // Address prefixes that a command or read spells its own route after.
  'decisions/amendment/AmendmentDecision.tsx: /api/workspaces/*/roadmaps/*',
  'decisions/cycle/investigation-api.ts: /api/workspaces/*/cycles/*',
  'decisions/design/design-api.ts: /api/workspaces/*/cycles/*',
  'decisions/preparation/PrepareDecisionBrief.tsx: /api/workspaces/*/roadmaps/*',
  'lib/branch-api.ts: /api/workspaces/*/worktrees/*',
  'lib/package-import-api.ts: /api/workspaces/*',
  'lib/planning-api.ts: /api/workspaces/*/projects/*',
  // Reads of one record by id.
  'decisions/checkpoint/CheckpointPreparation.tsx: */checkpoint-recovery/*',
  'decisions/evidence/EvidenceReview.tsx: */submissions/*',
  'features/execution/RunPage.tsx: /api/workspaces/*/runs/*/tool-results/*',
  'lib/execution-api.ts: /api/workspaces/*/runs/*',
  'lib/package-import-api.ts: */concurrency-definitions/*',
  'lib/package-import-api.ts: */import-archives/*',
  'lib/planning-api.ts: /api/workspaces/*/plan-artifacts/*',
  'lib/planning-api.ts: /api/workspaces/*/projects/*/plan-versions/*',
  'lib/roadmap-api.ts: */*/definitions/*',
  // A roadmap's save, by id: configuration.
  'lib/roadmap-api.ts: */*',
  // Typed unions of manual controls: a worktree's retarget or update, storage's scan, clean, backup.
  'lib/branch-api.ts: */*',
  'lib/storage-api.ts: */*',
  // Not URLs: React keys and counts such as `3/4`.
  'features/execution/HistoricalEvidencePanel.tsx: */*',
  'features/planning/RoadmapsPage.tsx: */*',
  'features/planning/RoadmapsPage.tsx: */*',
  'features/planning/RoadmapsPage.tsx: */*',
  'features/workspace/HostSchedulingPanel.tsx: */*',
  'features/workspace/RoadmapCapacityPanel.tsx: */*',
  // The browser's own routes (lib/route.ts builds pages' paths, not API URLs).
  'lib/route.ts: */agenda/*',
  'lib/route.ts: */inbox/*',
  'lib/route.ts: */projects/*',
  'lib/route.ts: */projects/*/plans/*',
  'lib/route.ts: */roadmaps/maps/*',
  'lib/route.ts: */runs/*',
  'lib/route.ts: */work-items/*',
  'lib/route.ts: /*',
  'lib/route.ts: /workspaces/*',
];

const AMBIGUOUS: readonly { readonly segment: string; readonly routes: readonly RegExp[] }[] = [
  {
    segment: 'control',
    routes: [
      /\/cycles\/\*\/control$/,
      /\/finalizations\/\*\/control$/,
      // A roadmap's start, pause, resume, stop and re-verify: manual controls.
      /\/roadmaps\/\*\/control$/,
    ],
  },
  { segment: 'adopt', routes: [/\/checks\/adopt$/, /\/supervision\/adopt$/] },
];

const src = fileURLToPath(new URL('..', import.meta.url));

type Node = { readonly type: string; readonly start: number; readonly end: number } & Record<
  string,
  unknown
>;
interface Declaration {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** The names another module imports it by: its own, an export list's alias, or `default`. */
  readonly exportedAs: readonly string[];
}
interface Module {
  /** Relative to `src`, with `/` separators. */
  readonly path: string;
  readonly source: string;
  readonly declarations: readonly Declaration[];
  /**
   * Relative imports: the local name, the name it was exported as (`*` for a namespace), and
   * the module, unextended.
   */
  readonly imports: readonly { local: string; imported: string; from: string }[];
  /** Re-exports: `export { a as b } from './x'`, and `export * from './x'` as `*`. */
  readonly reExports: readonly { imported: string; exportedAs: string; from: string }[];
  /** Relative `import('./x')` expressions, by where they sit (the lazy routes, for one). */
  readonly dynamicImports: readonly { readonly from: string; readonly at: number }[];
  /** Top-level `const`s whose value folds to a text, by name (R-A6 re-check R1). */
  readonly constants: ReadonlyMap<string, string>;
  /**
   * Every text an expression builds, outside a JSX attribute's own text: a string or template
   * literal, a `+` concatenation or an array `join`, a non-constant part read as `*`.
   */
  readonly texts: readonly { readonly text: string; readonly at: number }[];
  /** The texts holding a `/`: URLs and paths. */
  readonly urls: readonly { readonly text: string; readonly at: number }[];
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
const posix = (path: string) => path.split(sep).join('/');
const nameOf = (node: unknown) =>
  isNode(node) && typeof node.name === 'string'
    ? node.name
    : isNode(node) && typeof node.value === 'string'
      ? node.value
      : undefined;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassExpression',
]);

/** A module's top-level declarations, each with the names it is exported as. */
function declarationsOf(body: readonly Node[]): Declaration[] {
  const found: { name: string; start: number; end: number; exportedAs: string[] }[] = [];
  const later: { local: string; exportedAs: string }[] = [];
  for (const statement of body) {
    const named = statement.type === 'ExportNamedDeclaration';
    const isDefault = statement.type === 'ExportDefaultDeclaration';
    const inner = named || isDefault ? (statement.declaration as Node | null) : statement;
    if (!inner) continue;
    const span = { start: statement.start, end: statement.end };
    if (isDefault && inner.type === 'Identifier') {
      later.push({ local: inner.name as string, exportedAs: 'default' });
      continue;
    }
    if (FUNCTIONS.has(inner.type)) {
      const name = nameOf(inner.id) ?? 'default';
      found.push({ name, ...span, exportedAs: isDefault ? ['default'] : named ? [name] : [] });
    } else if (inner.type === 'VariableDeclaration')
      for (const d of inner.declarations as Node[]) {
        const name = nameOf(d.id);
        if (name) found.push({ name, ...span, exportedAs: named ? [name] : [] });
      }
  }
  // An export list without a source names local declarations: `export { h, g as default }`.
  for (const statement of body)
    if (statement.type === 'ExportNamedDeclaration' && !statement.declaration && !statement.source)
      for (const spec of statement.specifiers as Node[])
        later.push({ local: nameOf(spec.local) ?? '', exportedAs: nameOf(spec.exported) ?? '' });
  for (const { local, exportedAs } of later)
    for (const d of found) if (d.name === local) d.exportedAs.push(exportedAs);
  return found;
}

/** A module's path without its extension, as an import names it. */
const unextended = (path: string) => path.replace(/\.(tsx?|js)$/, '');

/** A name's text when it is a constant the module can see; none otherwise. */
type Resolve = (name: string) => string | undefined;

/**
 * The text an expression builds, a non-constant part read as `*`; none when it builds none. A
 * name bound to a constant text (in the module, or imported) reads as that text.
 */
function fold(node: Node, resolve: Resolve = () => undefined): string | undefined {
  const f = (n: Node) => fold(n, resolve);
  switch (node.type) {
    case 'Identifier':
      return resolve(node.name as string);
    case 'Literal':
      return typeof node.value === 'string' ? node.value : undefined;
    case 'TemplateLiteral': {
      const quasis = node.quasis as Node[];
      const expressions = node.expressions as Node[];
      return quasis
        .map((q, i) => {
          const cooked = (q.value as { cooked: string | null }).cooked ?? '';
          const part = expressions[i];
          return part === undefined ? cooked : cooked + (f(part) ?? '*');
        })
        .join('');
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return undefined;
      const left = f(node.left as Node);
      const right = f(node.right as Node);
      return left === undefined && right === undefined ? undefined : (left ?? '*') + (right ?? '*');
    }
    case 'CallExpression': {
      const callee = node.callee as Node;
      const separator = (node.arguments as Node[])[0];
      if (
        callee.type !== 'MemberExpression' ||
        nameOf(callee.property) !== 'join' ||
        (callee.object as Node).type !== 'ArrayExpression'
      )
        return undefined;
      const by = separator === undefined ? ',' : f(separator);
      if (by === undefined) return undefined;
      return ((callee.object as Node).elements as Node[])
        .map((e) => (isNode(e) ? (f(e) ?? '*') : '*'))
        .join(by);
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return f(node.expression as Node);
    default:
      return undefined;
  }
}
const FOLDED = new Set(['Literal', 'TemplateLiteral', 'BinaryExpression', 'CallExpression']);

/** An imported constant's text: the exporting module's, when it is known. */
type External = (from: string, name: string) => string | undefined;

export function analyse(
  absolute: string,
  source = readFileSync(absolute, 'utf8'),
  external: External = () => undefined,
): Module {
  const { program } = parseSync(absolute, source) as unknown as { program: Node };
  const body = program.body as Node[];
  const declarations = declarationsOf(body);
  const relativeTo = (from: string) =>
    unextended(posix(relative(src, join(dirname(absolute), from))));
  const imports = body.flatMap((statement) => {
    const from = (statement.source as Node | undefined)?.value;
    if (statement.type !== 'ImportDeclaration' || typeof from !== 'string' || !from.startsWith('.'))
      return [];
    return (statement.specifiers as Node[]).map((s) => ({
      local: nameOf(s.local) ?? '',
      imported:
        s.type === 'ImportSpecifier'
          ? (nameOf(s.imported) ?? '')
          : s.type === 'ImportNamespaceSpecifier'
            ? '*'
            : 'default',
      from: relativeTo(from),
    }));
  });
  const reExports = body.flatMap((statement) => {
    const from = (statement.source as Node | undefined)?.value;
    if (typeof from !== 'string' || !from.startsWith('.')) return [];
    if (statement.type === 'ExportAllDeclaration')
      return [
        { imported: '*', exportedAs: nameOf(statement.exported) ?? '*', from: relativeTo(from) },
      ];
    if (statement.type !== 'ExportNamedDeclaration') return [];
    return (statement.specifiers as Node[]).map((spec) => ({
      imported: nameOf(spec.local) ?? '',
      exportedAs: nameOf(spec.exported) ?? '',
      from: relativeTo(from),
    }));
  });
  // Constants: top-level `const` texts, local ones first, then the module's imports'.
  const constants = new Map<string, string>();
  const imported = new Map(imports.map((i) => [i.local, i] as const));
  const resolve: Resolve = (name) => {
    const local = constants.get(name);
    if (local !== undefined) return local;
    const i = imported.get(name);
    return i && i.imported !== '*' ? external(i.from, i.imported) : undefined;
  };
  const declarators = body.flatMap((statement) => {
    const inner =
      statement.type === 'ExportNamedDeclaration'
        ? (statement.declaration as Node | null)
        : statement;
    return inner?.type === 'VariableDeclaration' && inner.kind === 'const'
      ? (inner.declarations as Node[])
      : [];
  });
  // Resolve in passes, so a constant may name one declared after it.
  for (let pass = 0; pass < 3; pass++)
    for (const d of declarators) {
      const name = nameOf(d.id);
      const text = d.init ? fold(d.init as Node, resolve) : undefined;
      if (name && text !== undefined) constants.set(name, text);
    }
  const texts: { text: string; at: number }[] = [];
  const dynamicImports: { from: string; at: number }[] = [];
  const walk = (node: Node): void => {
    // An attribute's own text (an id, a class) is not a URL; a handler inside one may hold one.
    if (node.type === 'JSXAttribute' && (node.value as Node | null)?.type === 'Literal') return;
    if (node.type === 'ImportExpression') {
      const from = fold(node.source as Node, resolve);
      if (from?.startsWith('.')) dynamicImports.push({ from: relativeTo(from), at: node.start });
    }
    if (FOLDED.has(node.type) || node.type === 'Identifier') {
      const text = fold(node, resolve);
      if (text !== undefined) texts.push({ text, at: node.start });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      // A declared name, a property's key and a member's name are not references.
      if (key === 'id' && node.type === 'VariableDeclarator') continue;
      if (key === 'key' && node.type === 'Property' && !node.computed) continue;
      if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) walk(child);
    }
  };
  walk(program);
  const urls = texts.filter((t) => t.text.includes('/'));
  return {
    path: posix(relative(src, absolute)),
    source,
    declarations,
    imports,
    reExports,
    dynamicImports,
    constants,
    texts,
    urls,
  };
}

const component = (name: string) => /^[A-Z]/.test(name);
const mentions = (module: Module, d: Declaration, name: string) =>
  new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}($|[^\\w$])`).test(
    module.source.slice(d.start, d.end),
  );

/**
 * The modules that reach a module's export by a local name: by importing it (by name, by
 * `default`, or as a namespace, whose every use counts), or through a module that re-exports it.
 */
function importersOf(
  modules: ReadonlyMap<string, Module>,
  path: string,
  name: string,
  seen = new Set<string>(),
): { module: Module; local: string }[] {
  const key = `${path}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  return [...modules.values()].flatMap((other) => [
    ...other.imports
      .filter((i) => i.from === unextended(path) && (i.imported === name || i.imported === '*'))
      .map((i) => ({ module: other, local: i.local })),
    ...other.reExports
      .filter((r) => r.from === unextended(path) && (r.imported === name || r.imported === '*'))
      .flatMap((r) =>
        importersOf(modules, other.path, r.imported === '*' ? name : r.exportedAs, seen),
      ),
  ]);
}

/**
 * The components a top-level declaration posts through: itself, when it is one; else every
 * component that references it, in its own module or, when it is exported, an importing one.
 */
export function posters(
  modules: ReadonlyMap<string, Module>,
  module: Module,
  declaration: Declaration,
  seen = new Set<string>(),
): string[] {
  const key = `${module.path}#${declaration.name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  if (component(declaration.name)) return [key];
  const local = module.declarations.filter(
    (d) => d !== declaration && mentions(module, d, declaration.name),
  );
  const imported = declaration.exportedAs.flatMap((name) => [
    ...importersOf(modules, module.path, name).flatMap(({ module: other, local: alias }) =>
      other.declarations.filter((d) => mentions(other, d, alias)).map((d) => [other, d] as const),
    ),
    // A declaration that imports the module at run time and names the export (lazy routes).
    ...[...modules.values()].flatMap((other) =>
      other.dynamicImports
        .filter((i) => i.from === unextended(module.path))
        .flatMap((i) =>
          other.declarations
            .filter((d) => d.start <= i.at && i.at < d.end && mentions(other, d, name))
            .map((d) => [other, d] as const),
        ),
    ),
  ]);
  return [
    ...local.flatMap((d) => posters(modules, module, d, seen)),
    ...imported.flatMap(([other, d]) => posters(modules, other, d, seen)),
  ];
}

/** Every component that holds, or reaches through a helper, a URL matching `route`. */
export function postersOf(modules: ReadonlyMap<string, Module>, route: RegExp): string[] {
  const found = new Set<string>();
  for (const module of modules.values())
    for (const url of module.urls) {
      if (!route.test(url.text)) continue;
      const holder = module.declarations.find((d) => d.start <= url.at && url.at < d.end);
      // A URL outside any declaration (a top-level statement) has no component to name.
      for (const poster of holder ? posters(modules, module, holder) : [`${module.path}#<module>`])
        found.add(poster);
    }
  return [...found].sort();
}

/** URLs whose last segment no text names: any command could be posted through them. */
export function dynamicTails(all: ReadonlyMap<string, Module>): string[] {
  return [...all.values()].flatMap((module) =>
    module.urls
      .filter((url) => url.text.endsWith('/*'))
      .map((url) => `${module.path}: ${url.text}`),
  );
}

/** URLs ending in a shared segment that name none of its whole routes. */
export function unnamedTails(
  all: ReadonlyMap<string, Module>,
  segment: string,
  routes: readonly RegExp[],
): string[] {
  return [...all.values()].flatMap((module) =>
    module.urls
      .filter((url) => url.text.endsWith(`/${segment}`))
      .filter((url) => !routes.some((route) => route.test(url.text)))
      .map((url) => `${module.path}: ${url.text}`),
  );
}

/**
 * The tree's modules, read twice: the first reading finds each module's constants, the second
 * resolves the constants a module imports from another (R-A6 re-check R1).
 */
export function analyseAll(sourcesByPath: ReadonlyMap<string, string>): Map<string, Module> {
  const first = new Map(
    [...sourcesByPath].map(([path, source]) => {
      const module = analyse(path, source);
      return [unextended(module.path), module] as const;
    }),
  );
  const external: External = (from, name) => first.get(from)?.constants.get(name);
  return new Map(
    [...sourcesByPath].map(([path, source]) => {
      const module = analyse(path, source, external);
      return [module.path, module] as const;
    }),
  );
}
const modules = analyseAll(new Map(files(src).map((path) => [path, readFileSync(path, 'utf8')])));

describe('each decision command is posted from exactly one component', () => {
  it.each(COMMANDS)('$command is posted only by $owner', ({ route, owner }) => {
    expect(owner).toMatch(/^decisions\/[^/]+\/[^/]+\.tsx#[A-Z]\w*$/);
    expect(postersOf(modules, route)).toEqual([owner]);
  });

  /**
   * Two routes take their command in the body: a cycle's and a finalization's `control`. Their
   * posters are fixed, and each decision action is named by one of them alone. The rest are
   * manual controls: a cycle's pause, stop and resume of a pause (CycleControlButtons, and the
   * pause beside ProviderRetry), and a finalization's pause, stop and cleanup, which the shared
   * helper's type and runtime refuse decisions for (`lib/finalization-api.ts`, tested there).
   */
  it.each(SHARED)('$command: fixed posters, each decision action named by one', (shared) => {
    expect(postersOf(modules, shared.route)).toEqual([...shared.posters].sort());
    for (const [action, owner] of Object.entries(shared.decisions))
      expect(
        shared.posters.filter((poster) => names(modules, poster, action)),
        `${action} is named only by ${owner}`,
      ).toEqual([owner]);
  });

  /**
   * A last segment that several routes share names its whole route, so a helper that hides
   * the rest of the path (`${base}/adopt`) cannot post a decision unseen.
   */
  it.each(AMBIGUOUS)(
    'every URL ending in /$segment names its whole route',
    ({ segment, routes }) => {
      expect(unnamedTails(modules, segment, routes)).toEqual([]);
    },
  );

  /**
   * A URL whose last segment is built at run time could post any command (`${tree}/${action}`):
   * each one is listed here, with what it reads or posts, so a new one is seen (R-A6 review M2).
   */
  it('lists every URL whose last segment is dynamic', () => {
    expect(dynamicTails(modules).sort()).toEqual([...DYNAMIC_TAILS].sort());
  });
});

/** Whether a component's own source builds an action's name as a text (R-A6 review M2). */
function names(all: ReadonlyMap<string, Module>, poster: string, action: string): boolean {
  const [path, name] = poster.split('#') as [string, string];
  const module = all.get(path);
  const declaration = module?.declarations.find((d) => d.name === name);
  return (
    !!module &&
    !!declaration &&
    module.texts.some(
      (t) => t.text === action && declaration.start <= t.at && t.at < declaration.end,
    )
  );
}

/**
 * The detector itself: a planted second poster, a helper reached from two components, a URL
 * held in a handler attribute, and an attribute's own text, which is not a URL.
 */
describe('the poster detector', () => {
  const plant = (files: Record<string, string>) =>
    analyseAll(new Map(Object.entries(files).map(([path, source]) => [join(src, path), source])));
  it('finds a component that posts a command, and one that posts it through a helper', () => {
    const planted = plant({
      'decisions/evidence/Own.tsx':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        'export function Own() { return request(`/api/x/${id}/runtime/decide`); }',
      'components/Second.tsx': [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        'const post = (id: string) => request(`${base}/runtime/decide`);',
        'export function Second() { return <button onClick={() => post(id)} id="decide" />; }',
        'export function Unrelated() { return <p id="/runtime/decide" />; }',
      ].join('\n'),
    });
    expect(postersOf(planted, /\/decide$/)).toEqual([
      'components/Second.tsx#Second',
      'decisions/evidence/Own.tsx#Own',
    ]);
  });
  it('follows an exported helper into each module that imports it', () => {
    const planted = plant({
      'lib/commands.ts':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        'export const decideIt = (id: string) => request(`/api/${id}/runtime/decide`);',
      'features/A.tsx':
        "import { decideIt } from '../lib/commands.js';\nexport function A() { return decideIt('a'); }",
      'features/B.tsx': [
        "import { decideIt as d } from '../lib/commands.js';",
        "const later = () => d('b');",
        'export function B() { return later(); }',
      ].join('\n'),
    });
    expect(postersOf(planted, /\/decide$/)).toEqual(['features/A.tsx#A', 'features/B.tsx#B']);
  });
  // The review's probes (R-A6 review M2): each second poster below was missed before.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
  const helper = 'request(`/api/${id}/runtime/decide`)';
  const user = (from: string, call = 'decideIt') =>
    `import { ${call} } from '${from}';\nexport function A() { return ${call}('a'); }`;
  it.each([
    [
      'a default export imported by default',
      {
        'lib/commands.ts': `export default function decideIt(id: string) { return ${helper}; }`,
        'features/A.tsx':
          "import decideIt from '../lib/commands.js';\nexport function A() { return decideIt('a'); }",
      },
    ],
    [
      'an export list',
      {
        'lib/commands.ts': `const decideIt = (id: string) => ${helper};\nexport { decideIt };`,
        'features/A.tsx': user('../lib/commands.js'),
      },
    ],
    [
      'a barrel that re-exports it',
      {
        'lib/commands.ts': `export const decideIt = (id: string) => ${helper};`,
        'lib/barrel.ts': "export { decideIt } from './commands.js';",
        'features/A.tsx': user('../lib/barrel.js'),
      },
    ],
    [
      'a barrel that re-exports everything',
      {
        'lib/commands.ts': `export const decideIt = (id: string) => ${helper};`,
        'lib/barrel.ts': "export * from './commands.js';",
        'features/A.tsx': user('../lib/barrel.js'),
      },
    ],
    [
      'a namespace import',
      {
        'lib/commands.ts': `export const decideIt = (id: string) => ${helper};`,
        'features/A.tsx':
          "import * as api from '../lib/commands.js';\nexport function A() { return api.decideIt('a'); }",
      },
    ],
    [
      'a concatenated URL',
      {
        'features/A.tsx': "export function A() { return request(base + '/runtime/' + 'decide'); }",
      },
    ],
    [
      'the command name as a substitution',
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        'features/A.tsx': "export function A() { return request(`${base}/runtime/${'decide'}`); }",
      },
    ],
    [
      'a joined URL',
      {
        'features/A.tsx':
          "export function A() { return request([base, 'runtime', 'decide'].join('/')); }",
      },
    ],
    [
      'a URL prefix held in a constant, completed in a template',
      {
        'features/A.tsx': [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
          'const r = `/api/${id}/runtime/`;',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
          'export function A() { return request(`${r}decide`); }',
        ].join('\n'),
      },
    ],
    [
      'an imported URL prefix, completed by concatenation',
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        'lib/base.ts': 'export const r = `/api/${id}/runtime/`;',
        'features/A.tsx':
          "import { r } from '../lib/base.js';\nexport function A() { return request(r + 'decide'); }",
      },
    ],
    [
      'a helper reached through a dynamic import',
      {
        'lib/commands.ts': `export const decideIt = (id: string) => ${helper};`,
        'features/A.tsx':
          "export async function A() { const m = await import('../lib/commands.js'); return m.decideIt('a'); }",
      },
    ],
  ] as const)('finds a poster through %s', (_name, files) => {
    expect(postersOf(plant(files), /\/decide$/)).toEqual(['features/A.tsx#A']);
  });
  it('lists a URL whose last segment is dynamic, and an unnamed shared segment', () => {
    const planted = plant({
      'lib/commands.ts':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        'export const act = (id: string, a: string) => request(`/api/w/${id}/${a}`);',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
      'lib/adopt.ts': 'export const adopt = () => request(`${base}/adopt`);',
    });
    expect(dynamicTails(planted)).toEqual(['lib/commands.ts: /api/w/*/*']);
    expect(unnamedTails(planted, 'adopt', [/\/checks\/adopt$/])).toEqual(['lib/adopt.ts: */adopt']);
    expect(unnamedTails(planted, 'adopt', [/\/adopt$/])).toEqual([]);
  });
  it('names an action built from pieces inside a component', () => {
    const planted = plant({
      'decisions/cycle/X.tsx':
        "export function Buttons() { return control({ action: ('review' + '-again') as 'stop' }); }\nexport function Other() { return control({ action: 'stop' }); }",
    });
    expect(names(planted, 'decisions/cycle/X.tsx#Buttons', 'review-again')).toBe(true);
    expect(names(planted, 'decisions/cycle/X.tsx#Other', 'review-again')).toBe(false);
    // An action held in a module constant is named where the component uses it.
    const held = plant({
      'decisions/cycle/Y.tsx':
        "const RA = 'review-again';\nexport function Buttons() { return control({ action: RA }); }",
    });
    expect(names(held, 'decisions/cycle/Y.tsx#Buttons', 'review-again')).toBe(true);
  });
});

/**
 * A kind's commands file (`decisions/<kind>/*-api.ts`) is private to its module: nothing outside
 * the kind's directory imports it, so no other component can post its command (R-A6 review).
 */
function privateImports(path: string, source = readFileSync(path, 'utf8')): string[] {
  const decisions = join(src, 'decisions') + sep;
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  return imports
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => join(path, '..', spec))
    .filter((target) => target.startsWith(decisions) && /-api\.js$/.test(target))
    .filter((target) => !path.startsWith(join(target, '..') + sep))
    .map((target) => `${relative(src, path)} -> ${relative(src, target)}`);
}

it('imports a decision kind’s commands only from inside its own directory', () => {
  expect(files(src).flatMap((path) => privateImports(path))).toEqual([]);
});

/**
 * The import detector itself (TS-M11): with it disabled, the test above passes over a clean
 * tree, so this one plants a component outside the kind's directory that imports and re-exports
 * the kind's commands, next to the kind's own panel, which may.
 */
it('reports a planted import of a kind’s commands from outside its directory', () => {
  const planted = [
    "import { recoverDesign } from '../decisions/design/design-api.js';",
    "export { delegateScopeRepair } from '../decisions/scope-repair/scope-repair-api.js';",
  ].join('\n');
  expect(privateImports(join(src, 'components', 'planted.tsx'), planted)).toEqual([
    `${join('components', 'planted.tsx')} -> ${join('decisions', 'design', 'design-api.js')}`,
    `${join('components', 'planted.tsx')} -> ${join('decisions', 'scope-repair', 'scope-repair-api.js')}`,
  ]);
  expect(
    privateImports(
      join(src, 'decisions', 'design', 'planted.tsx'),
      "import { recoverDesign } from './design-api.js';",
    ),
  ).toEqual([]);
});
