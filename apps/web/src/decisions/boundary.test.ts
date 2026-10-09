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
    },
  },
];

/** Last segments several routes share, and the whole routes a URL ending in one may name. */
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
  readonly exported: boolean;
}
interface Module {
  /** Relative to `src`, with `/` separators. */
  readonly path: string;
  readonly source: string;
  readonly declarations: readonly Declaration[];
  /** Relative imports: the local name, the name it was exported as, its module unextended. */
  readonly imports: readonly { local: string; imported: string; from: string }[];
  /** Every URL or path text, outside JSX attributes, by where it starts. */
  readonly urls: readonly { readonly text: string; readonly at: number }[];
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
const posix = (path: string) => path.split(sep).join('/');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The names a top-level statement declares, and whether it exports them. */
function declared(statement: Node): Declaration[] {
  const exported = statement.type === 'ExportNamedDeclaration';
  const inner =
    exported || statement.type === 'ExportDefaultDeclaration'
      ? (statement.declaration as Node | null)
      : statement;
  if (!inner) return [];
  const span = { start: statement.start, end: statement.end };
  const id = (inner.id as Node | null | undefined)?.name;
  if (inner.type === 'FunctionDeclaration' || inner.type === 'ClassDeclaration')
    return [{ name: typeof id === 'string' ? id : 'default', exported, ...span }];
  if (inner.type === 'VariableDeclaration')
    return (inner.declarations as Node[]).flatMap((d) => {
      const name = (d.id as Node).name;
      return typeof name === 'string' ? [{ name, exported, ...span }] : [];
    });
  return [];
}

/** A module's path without its extension, as an import names it. */
const unextended = (path: string) => path.replace(/\.(tsx?|js)$/, '');

export function analyse(absolute: string, source = readFileSync(absolute, 'utf8')): Module {
  const { program } = parseSync(absolute, source) as unknown as { program: Node };
  const body = program.body as Node[];
  const declarations = body.flatMap(declared);
  const imports = body.flatMap((statement) => {
    const from = (statement.source as Node | undefined)?.value;
    if (statement.type !== 'ImportDeclaration' || typeof from !== 'string' || !from.startsWith('.'))
      return [];
    return (statement.specifiers as Node[]).map((s) => ({
      local: (s.local as Node).name as string,
      imported: s.type === 'ImportSpecifier' ? ((s.imported as Node).name as string) : 'default',
      from: unextended(posix(relative(src, join(dirname(absolute), from)))),
    }));
  });
  const urls: { text: string; at: number }[] = [];
  const walk = (node: Node): void => {
    // An attribute's own text (an id, a class) is not a URL; a handler inside one may hold one.
    if (node.type === 'JSXAttribute' && (node.value as Node | null)?.type === 'Literal') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('/'))
      urls.push({ text: node.value, at: node.start });
    if (
      node.type === 'TemplateLiteral' &&
      (node.quasis as Node[]).some((q) => String((q.value as { raw: string }).raw).includes('/'))
    )
      urls.push({
        text: (node.quasis as Node[])
          .map((q) => (q.value as { cooked: string | null }).cooked ?? '')
          .join('*'),
        at: node.start,
      });
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) walk(child);
    }
  };
  walk(program);
  return { path: posix(relative(src, absolute)), source, declarations, imports, urls };
}

const component = (name: string) => /^[A-Z]/.test(name);
const mentions = (module: Module, d: Declaration, name: string) =>
  new RegExp(`\\b${name}\\b`).test(module.source.slice(d.start, d.end));

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
  const imported = declaration.exported
    ? [...modules.values()].flatMap((other) =>
        other.imports
          .filter((i) => i.from === unextended(module.path) && i.imported === declaration.name)
          .flatMap((i) =>
            other.declarations
              .filter((d) => mentions(other, d, i.local))
              .map((d) => [other, d] as const),
          ),
      )
    : [];
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

const modules = new Map(
  files(src).map((path) => {
    const module = analyse(path);
    return [module.path, module] as const;
  }),
);

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
      const unnamed = [...modules.values()].flatMap((module) =>
        module.urls
          .filter((url) => url.text.endsWith(`/${segment}`))
          .filter((url) => !routes.some((route) => route.test(url.text)))
          .map((url) => `${module.path}: ${url.text}`),
      );
      expect(unnamed).toEqual([]);
    },
  );
});

/** Whether a component's own source names an action as a string literal. */
function names(all: ReadonlyMap<string, Module>, poster: string, action: string): boolean {
  const [path, name] = poster.split('#') as [string, string];
  const module = all.get(path);
  const declaration = module?.declarations.find((d) => d.name === name);
  return (
    !!module &&
    !!declaration &&
    new RegExp(`['"\`]${action}['"\`]`).test(
      module.source.slice(declaration.start, declaration.end),
    )
  );
}

/**
 * The detector itself: a planted second poster, a helper reached from two components, a URL
 * held in a handler attribute, and an attribute's own text, which is not a URL.
 */
describe('the poster detector', () => {
  const plant = (files: Record<string, string>) =>
    new Map(
      Object.entries(files).map(([path, source]) => {
        const module = analyse(join(src, path), source);
        return [module.path, module] as const;
      }),
    );
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
