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
 * `cycles/:id/control` shares its last segment with the roadmap and finalization `control`
 * routes, so a path built in pieces cannot be told apart by its text (R-A6 review). Every
 * `/control` is instead confined to the cycle's module and the two helpers that post the
 * roadmap's and a finalization's own commands.
 */
it('posts a control command only from the cycle module and the roadmap and finalization helpers', () => {
  const allowed = [
    join(src, 'decisions', 'cycle') + sep,
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
