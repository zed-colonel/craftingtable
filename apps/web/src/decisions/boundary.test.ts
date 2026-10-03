import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Each daemon decision command is posted from one decision kind's module (R-A6). A kind's
 * command is a private function in `decisions/<kind>/`, so nothing else can import it; this
 * test catches a second copy written by hand. A command is found by its route's last path
 * segment in a URL, or by its name as a string literal, which is how a generic
 * `post(action)` helper names it.
 */
const COMMANDS: readonly {
  readonly kind: string;
  readonly command: string;
  readonly found: RegExp;
}[] = [
  { kind: 'evidence', command: 'runtime/decide', found: /\/decide[`'"]|['"`]decide['"`]/ },
  {
    kind: 'architecture',
    command: 'runtime/propose-decision',
    found: /\/propose-decision[`'"]|['"`]propose-decision['"`]/,
  },
  {
    kind: 'preparation',
    command: 'roadmaps/:id/prepare-decision',
    found: /\/prepare-decision[`'"]|['"`]prepare-decision['"`]/,
  },
  {
    kind: 'preparation',
    command: 'roadmaps/:id/decision-preparation-grant',
    found: /\/decision-preparation-grant[`'"]|['"`]decision-preparation-grant['"`]/,
  },
  {
    kind: 'checks',
    command: 'repositories/:id/checks/adopt',
    // The map's own `adopt` (supervision) is another command, so only the checks route counts.
    found: /\/checks\/adopt[`'"]/,
  },
  { kind: 'merge', command: 'worktrees/:id/merge', found: /\/merge[`'"]/ },
  {
    kind: 'integration',
    command: 'cycles/:id/integration-resolution',
    found: /\/integration-resolution[`'"]/,
  },
  {
    kind: 'design',
    command: 'cycles/:id/design-recovery',
    found: /\/design-recovery[`'"]|['"`]design-recovery['"`]/,
  },
  {
    kind: 'design',
    command: 'cycles/:id/baseline-preparation',
    found: /\/baseline-preparation[`'"]|['"`]baseline-preparation['"`]/,
  },
  { kind: 'scope-repair', command: 'cycles/:id/scope-repair', found: /\/scope-repair[`'"]/ },
  {
    kind: 'finalization',
    command: 'finalizations/:id/control stage, plan adjustment and findings decisions',
    found: /['"`](select-stage-findings|approve-plan-change|remediate-findings)['"`]/,
  },
  {
    kind: 'finalization',
    command: 'finalizations/:id/control merge',
    found: /action: ['"`]merge['"`]/,
  },
  {
    kind: 'environment',
    command: 'runtime/authorize-native and runtime/audit-native',
    found: /\/(authorize|audit)-native[`'"]|['"`](authorize|audit)-native['"`]/,
  },
  {
    kind: 'upstream',
    command: 'runtime/declare-transitions',
    found: /\/declare-transitions[`'"]|['"`]declare-transitions['"`]/,
  },
  {
    kind: 'refresh',
    command: 'runtime/preview-refresh and runtime/refresh',
    // Not backticks around the bare name: a comment names the refresh-signal callback so.
    found: /\/(preview-)?refresh[`'"]|['"](preview-)?refresh['"]/,
  },
  {
    kind: 'amendment',
    command: 'roadmaps/:id/amendments, its preview and its decision',
    found: /\/amendments[`'"/]|['"`]amendments['"`]/,
  },
  {
    kind: 'checkpoint',
    command: 'runtime/prepare-checkpoint',
    found: /\/prepare-checkpoint[`'"]|['"`]prepare-checkpoint['"`]/,
  },
];

const src = fileURLToPath(new URL('..', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it.each(COMMANDS)('posts $command only from decisions/$kind', ({ kind, found }) => {
  const owner = join(src, 'decisions', kind) + sep;
  const posters = sources(src)
    .filter((path) => found.test(readFileSync(path, 'utf8')))
    .map((path) => relative(src, path));
  expect(posters.filter((path) => !join(src, path).startsWith(owner))).toEqual([]);
  expect(posters.length).toBeGreaterThan(0);
});

/**
 * A finalization's decisions share `finalizations/:id/control` with its manual controls, so
 * the shared helper's type and its runtime both refuse them (`lib/finalization-api.ts`,
 * tested there): the panel can post pause, stop and cleanup, never a decision (R-A6 2b review).
 *
 * `cycles/:id/control` shares its last segment with the roadmap and finalization `control`
 * routes, so a path built in pieces cannot be told apart by its text (R-A6 review). Every
 * `/control` is instead confined to the cycle's module and the two helpers that post the
 * roadmap's and a finalization's own commands.
 */
it('posts a control command only from the cycle module and the roadmap and finalization helpers', () => {
  const allowed = [
    join(src, 'decisions', 'cycle') + sep,
    join(src, 'decisions', 'finalization') + sep,
    join(src, 'lib', 'roadmap-api.ts'),
    join(src, 'lib', 'finalization-api.ts'),
  ];
  const posters = sources(src).filter((path) => /\/control\b/.test(readFileSync(path, 'utf8')));
  expect(
    posters
      .filter((path) => !allowed.some((a) => path === a || path.startsWith(a)))
      .map((path) => relative(src, path)),
  ).toEqual([]);
  expect(posters.some((path) => path.startsWith(allowed[0]!))).toBe(true);
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
  expect(sources(src).flatMap((path) => privateImports(path))).toEqual([]);
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
