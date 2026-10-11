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
 * The test reads every module's syntax tree and folds the texts it builds: string and template
 * literals, concatenations, joins, constants (in any scope, or imported) and calls to URL helpers,
 * a part it cannot read standing as `*`. A command is found by its route at the end of a URL, up
 * to its query; the top-level declaration holding the URL is its poster, and a helper that is not
 * a component posts through every component that reaches it (in its module, through imports,
 * aliases, re-exports, namespaces and dynamic `import()`). Each command must resolve to its one
 * owner, a component in `decisions/<kind>/`. Requests are recognised by binding: a request whose
 * URL cannot be read, or whose last segment is built at run time, must be listed and classified,
 * and `request` or `fetch` may only be called, never passed on.
 *
 * It guards against an accidental second poster, not a deliberate one (R-A6 review and its
 * re-checks): `request` re-exported under another name, `XMLHttpRequest`, `eval`, computed
 * members and code outside `src` are known limits of a static check. The daemon's own checks
 * (CSRF, expected versions, and `cycleActions` and `finalizationActions` refusing what they do
 * not offer) and code review stand behind it.
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
 * The requests whose URL's last segment is built at run time, each read here, so a new one fails
 * the test until it is classified (R-A6 review M2, second re-check R3). None posts a decision.
 */
const DYNAMIC_TAILS: readonly string[] = [
  // Reads of one record by id.
  'lib/runtime-evidence-api.ts: */checkpoint-recovery/*',
  'lib/runtime-evidence-api.ts: */submissions/*',
  'lib/execution-api.ts: /api/workspaces/*/runs/*',
  'lib/package-import-api.ts: /api/workspaces/*/concurrency-definitions/*',
  'lib/planning-api.ts: /api/workspaces/*/plan-artifacts/*',
  'lib/planning-api.ts: /api/workspaces/*/projects/*',
  'lib/planning-api.ts: /api/workspaces/*/projects/*/plan-versions/*',
  'lib/roadmap-api.ts: /api/workspaces/*/roadmaps/*/definitions/*',
  'lib/roadmap-api.ts: /api/workspaces/*/roadmaps/*/graph/*',
  // A roadmap's save, by id: configuration.
  'lib/roadmap-api.ts: /api/workspaces/*/roadmaps/*',
];

/**
 * The requests whose URL the detector cannot read (R-A6 second re-check R3): only the
 * transports, which send the URL their callers built and every caller of which is read above.
 */
const OPAQUE_REQUESTS: readonly string[] = [
  // `request`'s own `fetch(url)`.
  'lib/api-client.ts: <not a text>',
  // The plan-archive upload's `fetch(url)`, given its URL by its callers.
  'lib/package-import-api.ts: <not a text>',
];

const AMBIGUOUS: readonly { readonly segment: string; readonly routes: readonly RegExp[] }[] = [
  {
    segment: 'control',
    routes: [
      /\/cycles\/\*\/control$/,
      /\/finalizations\/\*\/control$/,
      // A roadmap's start, pause, resume, stop and re-verify: manual controls.
      /\/roadmaps\/\*\/control$/,
      // Manual controls folded into one route each (R-H5, H5-2): a run's message, end and
      // cancel; a worktree's retarget, update and removal; a work item's admission, removal from
      // the agenda and completion; storage's scan, clean and backup.
      /\/runs\/\*\/control$/,
      /\/worktrees\/\*\/control$/,
      /\/work-items\/\*\/control$/,
      /\/storage\/control$/,
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
  /** Top-level arrow helpers whose body folds to a text, by name. */
  readonly helpers: ReadonlyMap<string, string>;
  /**
   * Each `request(…)` or `fetch(…)` call's first argument as it folds (undefined when nothing
   * does), by where the call sits (R-A6 second re-check R3).
   */
  readonly calls: readonly { readonly url: string | undefined; readonly at: number }[];
  /**
   * References to `request` or `fetch` that are not calls (passed on, stored, wrapped): any
   * could post any command unseen (R-A6 third re-check R4).
   */
  readonly escapes: readonly { readonly name: string; readonly at: number }[];
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

/**
 * A name's text when it is a constant the module can see; none otherwise. With `call`, the text
 * a helper `(…) => \`…\`` returns, its parameters read as `*` (R-A6 second re-check R3).
 */
type Resolve = (name: string, call?: boolean) => string | undefined;

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
      if (callee.type === 'Identifier') return resolve(callee.name as string, true);
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
    case 'ConditionalExpression': {
      // `id ? url(id) : undefined` builds one text; two different ones build none here (each
      // branch is read on its own where it matters, a request's URL).
      const absent = (n: Node) =>
        (n.type === 'Identifier' && n.name === 'undefined') ||
        (n.type === 'Literal' && n.value === null);
      const [yes, no] = [node.consequent as Node, node.alternate as Node];
      if (absent(no)) return f(yes);
      if (absent(yes)) return f(no);
      const [a, b] = [f(yes), f(no)];
      return a === b ? a : undefined;
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

/** An imported constant's text, or a helper's (`call`): the exporting module's, when known. */
type External = (from: string, name: string, call?: boolean) => string | undefined;

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
  const helpers = new Map<string, string>();
  const imported = new Map(imports.map((i) => [i.local, i] as const));
  const resolve: Resolve = (name, call = false) => {
    const local = (call ? helpers : constants).get(name);
    if (local !== undefined) return local;
    const i = imported.get(name);
    return i && i.imported !== '*' ? external(i.from, i.imported, call) : undefined;
  };
  // Every `const` of the module, in any scope, whose name it declares once (as the scope check's
  // rule 7 resolves names): a function's own `const base = …` resolves too (second re-check R3).
  const declarators: Node[] = [];
  /** Every declarator, `let` and `var` too: any of them can alias a sender. */
  const allDeclarators: Node[] = [];
  const counts = new Map<string, number>();
  const gather = (node: Node): void => {
    if (node.type === 'VariableDeclaration')
      for (const d of node.declarations as Node[]) {
        const name = nameOf(d.id);
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        if (node.kind === 'const') declarators.push(d);
        allDeclarators.push(d);
      }
    else if (
      (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
      nameOf(node.id)
    )
      counts.set(nameOf(node.id)!, (counts.get(nameOf(node.id)!) ?? 0) + 1);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) gather(child);
    }
  };
  gather(program);
  // A parameter or a second declaration makes a name ambiguous: it is left unresolved.
  const params = new Set<string>();
  const collectParams = (node: Node): void => {
    if (FUNCTIONS.has(node.type) || node.type === 'ArrowFunctionExpression')
      for (const param of (node.params as Node[] | undefined) ?? []) {
        const name = nameOf(param);
        if (name) params.add(name);
      }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (isNode(child)) collectParams(child);
    }
  };
  collectParams(program);
  const unique = (d: Node) => {
    const name = nameOf(d.id);
    return !!name && counts.get(name) === 1 && !params.has(name);
  };
  // Resolve in passes, so a constant may name one declared after it.
  for (let pass = 0; pass < 3; pass++)
    for (const d of declarators.filter(unique)) {
      const name = nameOf(d.id);
      const init = d.init as Node | null;
      if (!name || !init) continue;
      // A helper whose body is an expression: what it returns, its parameters unknown.
      if (
        init.type === 'ArrowFunctionExpression' &&
        (init.body as Node).type !== 'BlockStatement'
      ) {
        const text = fold(init.body as Node, resolve);
        if (text !== undefined) helpers.set(name, text);
        continue;
      }
      const text = fold(init, resolve);
      if (text !== undefined) constants.set(name, text);
    }
  const texts: { text: string; at: number }[] = [];
  const dynamicImports: { from: string; at: number }[] = [];
  const calls: { url: string | undefined; at: number }[] = [];
  const escapes: { name: string; at: number }[] = [];
  // The names a request goes out through, by binding, not by spelling (third re-check R4): the
  // browser's `fetch` (unless the module declares its own), `request` unless it is imported
  // under another binding, any import of `request` under any alias, and any `const` alias.
  const senders = new Set<string>([
    ...(counts.has('fetch') ? [] : ['fetch']),
    // `request` declared here (api-client), or not bound at all: unknown, so it counts.
    ...(!imported.has('request') ? ['request'] : []),
    ...imports.filter((i) => i.imported === 'request').map((i) => i.local),
  ]);
  for (let pass = 0; pass < 3; pass++)
    for (const d of allDeclarators) {
      const init = d.init as Node | null;
      const name = nameOf(d.id);
      if (name && init?.type === 'Identifier' && senders.has(init.name as string))
        senders.add(name);
    }
  // `api.request` on a namespace import of the API client, and `window.fetch` and its kin
  // (fourth re-check R5): senders reached through a member.
  const clients = new Set(
    imports
      .filter((i) => i.imported === '*' && /(^|\/)api-client$/.test(i.from))
      .map((i) => i.local),
  );
  const GLOBALS = new Set(['window', 'globalThis', 'self']);
  const memberSender = (n: Node) =>
    n.type === 'MemberExpression' &&
    !n.computed &&
    (n.object as Node).type === 'Identifier' &&
    ((clients.has((n.object as Node).name as string) && nameOf(n.property) === 'request') ||
      (GLOBALS.has((n.object as Node).name as string) && nameOf(n.property) === 'fetch'));
  /** Identifiers of senders seen in a position that sends, or that only names an alias. */
  const handled = new WeakSet<object>();
  // A URL is matched up to its query or fragment, which the daemon's routes ignore.
  const path = (url: string | undefined) => url?.split(/[?#]/)[0];
  const walk = (node: Node): void => {
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'VariableDeclarator' && (node.init as Node | null)?.type === 'Identifier')
      handled.add(node.init as Node);
    if (node.type === 'CallExpression') {
      const callee = node.callee as Node;
      const args = node.arguments as Node[];
      // `send(url)`, or `send.call(self, url)` and `send.apply(self, [url])`.
      const direct =
        (callee.type === 'Identifier' && senders.has(callee.name as string)) ||
        memberSender(callee);
      const object = callee.type === 'MemberExpression' ? (callee.object as Node) : undefined;
      const via =
        object?.type === 'Identifier' && senders.has(object.name as string)
          ? nameOf(callee.property)
          : undefined;
      const first = direct
        ? args[0]
        : via === 'call'
          ? args[1]
          : via === 'apply'
            ? ((args[1] as Node | undefined)?.elements as Node[] | undefined)?.[0]
            : undefined;
      if (direct) handled.add(callee);
      if (via === 'call' || via === 'apply') handled.add(object!);
      // A conditional URL is each of its branches.
      const branches = (n: Node): Node[] =>
        n.type === 'ConditionalExpression'
          ? [...branches(n.consequent as Node), ...branches(n.alternate as Node)]
          : [n];
      if (direct || via === 'call' || via === 'apply')
        for (const branch of first ? branches(first) : [])
          calls.push({ url: path(fold(branch, resolve)), at: node.start });
    }
    if (node.type === 'Identifier' && senders.has(node.name as string) && !handled.has(node))
      escapes.push({ name: node.name as string, at: node.start });
    if (memberSender(node) && !handled.has(node)) {
      escapes.push({ name: nameOf(node.property) ?? '', at: node.start });
      return;
    }
    // An attribute's own text (an id, a class) is not a URL; a handler inside one may hold one.
    if (node.type === 'JSXAttribute' && (node.value as Node | null)?.type === 'Literal') return;
    if (node.type === 'ImportExpression') {
      const from = fold(node.source as Node, resolve);
      if (from?.startsWith('.')) dynamicImports.push({ from: relativeTo(from), at: node.start });
    }
    if (FOLDED.has(node.type) || node.type === 'Identifier') {
      const text = path(fold(node, resolve));
      if (text !== undefined) texts.push({ text, at: node.start });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      // A declared name, a property's key and a member's name are not references.
      if (key === 'id' && (node.type === 'VariableDeclarator' || FUNCTIONS.has(node.type)))
        continue;
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
    helpers,
    calls,
    escapes,
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
    // A declaration that imports the module at run time reaches every export of it (the lazy
    // routes; a helper that returns the module, R-A6 second re-check R3).
    ...[...modules.values()].flatMap((other) =>
      other.dynamicImports
        .filter((i) => i.from === unextended(module.path))
        .flatMap((i) =>
          other.declarations
            .filter((d) => d.start <= i.at && i.at < d.end)
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

/** Requests whose URL's last segment is built at run time: any command could be posted so. */
export function dynamicTails(all: ReadonlyMap<string, Module>): string[] {
  return [...all.values()].flatMap((module) =>
    module.calls
      .filter((call) => call.url?.endsWith('/*'))
      .map((call) => `${module.path}: ${call.url}`),
  );
}

/**
 * Requests whose URL the detector cannot read as a path: it folds to nothing, or to a text with
 * no `/` (`*decide`, a prefix it could not resolve). Any of them could post any command.
 */
export function opaqueRequests(all: ReadonlyMap<string, Module>): string[] {
  return [...all.values()].flatMap((module) =>
    module.calls
      .filter((call) => call.url === undefined || !call.url.includes('/'))
      .map((call) => `${module.path}: ${call.url ?? '<not a text>'}`),
  );
}

/** References to a sender that do not send: each is a way to post unseen. */
export function senderEscapes(all: ReadonlyMap<string, Module>): string[] {
  return [...all.values()].flatMap((module) =>
    module.escapes.map((use) => `${module.path}: ${use.name}`),
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
  const external: External = (from, name, call) =>
    (call ? first.get(from)?.helpers : first.get(from)?.constants)?.get(name);
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

  /**
   * The rules above read URLs; a request whose URL is not readable at all fails closed: each is
   * listed here, so a new one must be classified (R-A6 second re-check R3).
   */
  it('lists every request whose URL it cannot read', () => {
    expect(opaqueRequests(modules).sort()).toEqual([...OPAQUE_REQUESTS].sort());
  });

  /** `request` and `fetch` are only ever called: never passed on, stored or wrapped. */
  it('finds no other use of request or fetch', () => {
    expect(senderEscapes(modules)).toEqual([]);
  });
});

/**
 * The daemon's routes as its generated inventory lists them (`docs/api-routes.md`, R-H5): each
 * route's method, path under `/api/` and tag. The decision commands above are the routes it tags
 * `decision`, so a route the daemon calls a decision cannot go unowned here (H5-4).
 */
export function inventoryRoutes(
  markdown: string,
): readonly { method: string; path: string; tag: string }[] {
  return markdown
    .split('\n')
    .filter((line) => /^\| (GET|POST) \| `/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      return { method: cells[1]!, path: cells[2]!.replaceAll('`', ''), tag: cells[4]! };
    });
}
const INVENTORY = inventoryRoutes(
  readFileSync(fileURLToPath(new URL('../../../../docs/api-routes.md', import.meta.url)), 'utf8'),
);
/** A route's path as a URL the detector folds: each parameter a `*`. */
const asUrl = (path: string) => `/api/${path.replace(/:[A-Za-z]+/g, '*')}`;

describe('the decision commands are the routes the daemon tags decision (R-H5, H5-4)', () => {
  const covering = [...COMMANDS.map((c) => c.route), ...SHARED.map((s) => s.route)];
  const decisions = INVENTORY.filter((route) => route.tag === 'decision');

  it('reads the inventory', () => {
    expect(INVENTORY.length).toBeGreaterThan(100);
    expect(decisions.length).toBeGreaterThan(20);
  });

  it('names one owner for each route tagged decision', () => {
    expect(
      decisions
        .filter((route) => covering.filter((c) => c.test(asUrl(route.path))).length !== 1)
        .map((route) => route.path),
    ).toEqual([]);
  });

  it('lists no command the daemon does not tag decision', () => {
    expect(
      covering.filter((c) => !decisions.some((route) => c.test(asUrl(route.path)))).map(String),
    ).toEqual([]);
    expect(
      INVENTORY.filter((route) => route.method === 'POST' && route.tag !== 'decision')
        .filter((route) => covering.some((c) => c.test(asUrl(route.path))))
        .map((route) => route.path),
    ).toEqual([]);
  });
});

/** Where a request may be built and sent (R-H5): a `lib/*-api.ts` module, or the transport. */
const API_MODULE = /^lib\/[a-z][a-z-]*-api\.ts$/;
const TRANSPORT = 'lib/api-client.ts';

/**
 * The string and template literals a module writes itself, a template's substitutions as `*`
 * (an address a lib helper builds for it is not one of them).
 */
function ownLiterals(module: Module): string[] {
  const { program } = parseSync(module.path, module.source) as unknown as { program: Node };
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isNode(node)) return;
    if (node.type === 'Literal' && typeof node.value === 'string') found.push(node.value);
    if (node.type === 'TemplateLiteral')
      found.push(
        (node.quasis as Node[])
          .map((q) => (q.value as { cooked?: string; raw: string }).cooked ?? '')
          .join('*'),
      );
    for (const [key, value] of Object.entries(node))
      if (key !== 'type' && key !== 'start' && key !== 'end') visit(value);
  };
  visit(program);
  return found;
}

/** Every request sent, and every API address written, outside the API modules. */
export function requestsOutsideApiModules(all: ReadonlyMap<string, Module>): string[] {
  const api = (text: string) => /(^|[^a-z])\/api(\/|$)/.test(text);
  return [...all.values()]
    .filter((module) => !API_MODULE.test(module.path))
    .flatMap((module) =>
      module.path === TRANSPORT
        ? // The transport sends what its callers built, and writes only its own step-up.
          ownLiterals(module)
            .filter((text) => api(text) && text !== '/api/auth/step-up')
            .map((text) => `${module.path}: builds ${text}`)
        : [
            ...module.calls.map((call) => `${module.path}: sends ${call.url ?? '<not a text>'}`),
            ...ownLiterals(module)
              .filter(api)
              .map((text) => `${module.path}: builds ${text}`),
          ],
    );
}

/**
 * Every request the browser sends is built and sent in a `lib/*-api.ts` module (R-H5): a page,
 * panel or decision component calls a named function there and never writes an API address or
 * calls `request` or `fetch` itself. The decision commands' functions live there too, each
 * reached from its one owner (the poster rules above follow imports).
 */
describe('every request goes through a lib/*-api.ts module (R-H5)', () => {
  it('finds no request or API address anywhere else', () => {
    expect(requestsOutsideApiModules(modules)).toEqual([]);
  });

  it('reports a planted request and a planted address outside them', () => {
    const plant = (files: Record<string, string>) =>
      analyseAll(new Map(Object.entries(files).map(([path, source]) => [join(src, path), source])));
    const planted = plant({
      'features/Planted.tsx':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        "import { request } from '../lib/api-client.js';\nexport function Planted() { return request(`/api/workspaces/${id}/runs`); }",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
      'features/Link.tsx': 'export function Link() { return `/api/workspaces/${id}/runs/${run}`; }',
      'features/Linked.tsx':
        "import { runs } from '../lib/runs-api.js';\nexport function Linked() { return runs('w'); }",
      'lib/runs-api.ts':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
        "import { request } from './api-client.js';\nexport const runs = (id: string) => request(`/api/workspaces/${id}/runs`);",
      'lib/route.ts': "export const page = '/workspaces/api/settings';",
      'lib/api-client.ts':
        "export async function request(url: string) { await fetch('/api/auth/step-up'); return fetch(url); }\nexport const me = () => request('/api/auth/session');",
    });
    expect(requestsOutsideApiModules(planted).sort()).toEqual([
      'features/Link.tsx: builds /api/workspaces/*/runs/*',
      'features/Planted.tsx: builds /api/workspaces/*/runs',
      'features/Planted.tsx: sends /api/workspaces/*/runs',
      'lib/api-client.ts: builds /api/auth/session',
    ]);
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
    [
      'a URL prefix held in a function-local constant',
      {
        'features/A.tsx': [
          'export function A() {',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
          '  const r = `/api/${id}/runtime/`;',
          "  return request(r + 'decide');",
          '}',
        ].join('\n'),
      },
    ],
    [
      'a helper that returns a dynamically imported module',
      {
        'lib/commands.ts': `export const decideIt = (id: string) => ${helper};`,
        'features/A.tsx': [
          "const lazy = () => import('../lib/commands.js');",
          "export async function A() { return (await lazy()).decideIt('a'); }",
        ].join('\n'),
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
  it('lists a request whose URL it cannot read: a prefix through a barrel or a namespace member', () => {
    const planted = plant({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
      'lib/base.ts': 'export const r = `/api/${id}/runtime/`;',
      'lib/barrel.ts': "export { r } from './base.js';",
      'features/A.tsx':
        "import { r } from '../lib/barrel.js';\nexport function A() { return request(r + 'decide'); }",
      'features/B.tsx':
        "import * as b from '../lib/base.js';\nexport function B() { return request(b.r + 'decide'); }",
    });
    expect(opaqueRequests(planted)).toEqual(['features/A.tsx: *decide', 'features/B.tsx: *decide']);
  });
  // The third re-check's probes (R4) and its self-test gaps (O3, O5, O6, O9).
  const ns = "import * as b from '../lib/base.js';\n";
  const base = {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
    'lib/base.ts': 'export const r = `/api/${id}/runtime/`;',
  };
  it.each([
    [
      'an aliased import of request (Q1)',
      `${ns}import { request as send } from '../lib/api-client.js';\nexport function A() { return send(b.r + 'decide'); }`,
    ],
    [
      'a const alias of request (Q2)',
      `${ns}const send = request;\nexport function A() { return send(b.r + 'decide'); }`,
    ],
    [
      'request.call (Q4)',
      `${ns}export function A() { return request.call(null, b.r + 'decide'); }`,
    ],
    ['request.apply', `${ns}export function A() { return request.apply(null, [b.r + 'decide']); }`],
    [
      "a namespace import's api.request (S1)",
      `${ns}import * as api from '../lib/api-client.js';\nexport function A() { return api.request(b.r + 'decide'); }`,
    ],
    ['window.fetch (S3)', `${ns}export function A() { return window.fetch(b.r + 'decide'); }`],
    ['globalThis.fetch', `${ns}export function A() { return globalThis.fetch(b.r + 'decide'); }`],
    [
      'a let alias of request (S8)',
      `${ns}let send = request;\nexport function A() { return send(b.r + 'decide'); }`,
    ],
    [
      'the second branch of a conditional URL (O3)',
      `${ns}export function A() { return request(c ? \`/api/\${id}/x\` : b.r + 'decide'); }`,
    ],
    [
      'a prefix a parameter shadows (O6)',
      "const r = '/api/x/runtime/';\nexport function A(r: string) { return request(r + 'decide'); }",
    ],
    [
      'a prefix declared twice (O5)',
      "function one() { const r = '/api/x/runtime/'; return r; }\nexport function A() { const r = String(one()); return request(r + 'decide'); }",
    ],
  ])('lists %s as a request it cannot read', (_name, source) => {
    expect(opaqueRequests(plant({ ...base, 'features/A.tsx': source }))).toEqual([
      'features/A.tsx: *decide',
    ]);
  });
  it.each([
    [
      'a query string (Q3)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
      'export function A() { return request(`/api/${id}/runtime/decide?via=a`); }',
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
    ['a fragment (Q5)', 'export function A() { return request(`/api/${id}/runtime/decide#a`); }'],
    [
      'an imported URL helper (O9)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
      "import { url } from '../lib/urls.js';\nexport function A() { return request(`${url(id)}/decide`); }",
    ],
  ])('finds a poster whose URL carries %s', (_name, source) => {
    const planted = plant({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a planted module's source holds a template literal.
      'lib/urls.ts': 'export const url = (id: string) => `/api/${id}/runtime`;',
      'features/A.tsx': source,
    });
    expect(postersOf(planted, /\/decide$/)).toEqual(['features/A.tsx#A']);
  });
  it('lists request passed on or stored instead of called', () => {
    const planted = plant({
      'features/A.tsx':
        "import { request } from '../lib/api-client.js';\nconst senders = [request];\nexport function A() { return useIt(request); }",
    });
    expect(senderEscapes(planted)).toEqual(['features/A.tsx: request', 'features/A.tsx: request']);
    // A member sender passed on is listed too.
    const member = plant({
      'features/A.tsx':
        "import * as api from '../lib/api-client.js';\nexport function A() { return useIt(api.request, window.fetch); }",
    });
    expect(senderEscapes(member)).toEqual(['features/A.tsx: request', 'features/A.tsx: fetch']);
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
 * Every API module lives in `lib/` (R-H5): a decision kind's commands are functions there that
 * only the kind's component imports (the poster rules above follow imports), so no `*-api.ts`
 * module sits beside a component. Before R-H5 a kind's commands file was private to its
 * directory (R-A6 review); the rules above now hold that boundary wherever the file is.
 */
function apiModulesOutsideLib(paths: readonly string[]): string[] {
  return paths
    .map((path) => posix(relative(src, path)))
    .filter((path) => /-api\.tsx?$/.test(path) && !API_MODULE.test(path));
}

it('keeps every API module in lib (R-H5)', () => {
  expect(apiModulesOutsideLib(files(src))).toEqual([]);
  expect(
    apiModulesOutsideLib([
      join(src, 'decisions', 'design', 'design-api.ts'),
      join(src, 'lib', 'work-cycle-api.ts'),
    ]),
  ).toEqual(['decisions/design/design-api.ts']);
});

/**
 * The modules a directory's modules reach that can send a request: they call `request` or
 * `fetch`, pass one on, or import the API client at all. The walk follows every relative import, re-export and `import()`, so a module
 * the directory reaches only through others still counts.
 */
export function sendersReachedFrom(all: ReadonlyMap<string, Module>, directory: string): string[] {
  const byPath = new Map([...all.values()].map((m) => [unextended(m.path), m]));
  const queue = [...all.values()].filter((m) => m.path.startsWith(directory));
  const seen = new Set<string>();
  while (queue.length) {
    const module = queue.pop()!;
    if (seen.has(module.path)) continue;
    seen.add(module.path);
    for (const from of [
      ...module.imports.map((i) => i.from),
      ...module.reExports.map((r) => r.from),
      ...module.dynamicImports.map((i) => i.from),
    ]) {
      const next = byPath.get(from) ?? byPath.get(`${from}/index`);
      if (next) queue.push(next);
    }
  }
  // A module that imports the API client at all could send through it, however it names it.
  const client = (from: string) => /(^|\/)api-client$/.test(from);
  return [...seen]
    .filter((path) => {
      const module = all.get(path)!;
      return (
        module.calls.length > 0 ||
        module.escapes.length > 0 ||
        module.imports.some((i) => client(i.from)) ||
        module.reExports.some((r) => client(r.from)) ||
        module.dynamicImports.some((i) => client(i.from))
      );
    })
    .sort();
}

/**
 * R-E3b's done-when (e): the roadmap board and its graph post no command. They live in
 * `features/roadmap-board/` and are handed the daemon's reads by the roadmap page, so nothing
 * they import, however indirectly, sends a request: a structural boundary, not a list of routes.
 */
it("the roadmap board's modules reach no request (R-E3b)", () => {
  expect([...modules.keys()].filter((p) => p.startsWith('features/roadmap-board/'))).not.toEqual(
    [],
  );
  expect(sendersReachedFrom(modules, 'features/roadmap-board/')).toEqual([]);
});

/** The reach check itself: a board module two imports away from a sender is reported. */
it('reports a planted board module that reaches a request through another module', () => {
  const planted = analyseAll(
    new Map(
      Object.entries({
        'features/roadmap-board/Planted.tsx':
          "import { helper } from '../../lib/planted-helper.js';\nexport function Planted() { return helper(); }",
        'lib/planted-helper.ts': "export { post as helper } from './planted-api.js';",
        'lib/planted-api.ts':
          "import { request } from './api-client.js';\nexport const post = () => request('/api/x/decide', {});",
        'lib/api-client.ts': 'export async function request() {}',
      }).map(([path, source]) => [join(src, path), source]),
    ),
  );
  expect(sendersReachedFrom(planted, 'features/roadmap-board/')).toEqual(['lib/planted-api.ts']);
  // Reached through `import()`, and a module that only hands `request` on (R-E3b review X01, X03).
  const lazy = analyseAll(
    new Map(
      Object.entries({
        'features/roadmap-board/Lazy.tsx':
          "export function Lazy() { return import('../../lib/planted-handoff.js'); }",
        'lib/planted-handoff.ts':
          "import { request } from './api-client.js';\nexport const send = request;",
        'lib/api-client.ts': 'export async function request() {}',
      }).map(([path, source]) => [join(src, path), source]),
    ),
  );
  expect(sendersReachedFrom(lazy, 'features/roadmap-board/')).toEqual(['lib/planted-handoff.ts']);
});
