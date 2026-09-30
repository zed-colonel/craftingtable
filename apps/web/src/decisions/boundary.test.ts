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
}[] = [{ kind: 'evidence', command: 'runtime/decide', found: /\/decide[`'"]|['"`]decide['"`]/ }];

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
