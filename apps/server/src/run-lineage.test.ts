import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * A question stop's investigation works beside its cycle (R-C16): `listForWorktree` and
 * `latestIdForWorktree` leave it out, and `liveForWorktree` includes it. A live-run check
 * written against `listForWorktree` would miss a live investigation and let a command, a
 * launch or a worktree change run beside it, so this fails on any such check.
 */
const SOURCE = join(import.meta.dirname);
const LIVE = /isTerminalAgentRunStatus|'finished', 'failed', 'cancelled', 'interrupted'|\blive\(/;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });
}

/** Live checks a listing feeds, chained on it or through the variable it is assigned to. */
export function liveChecksOnLineage(text: string): string[] {
  const found: string[] = [];
  // Chained: `.listForWorktree(…)` then, within the same expression, a live test.
  for (const match of text.matchAll(/\.listForWorktree\(([^()]*)\)([\s\S]{0,240})/g)) {
    const chain = match[2]!.split(/;\n|\n\s*\n/)[0]!;
    if (/^\s*(?:\[0\])?\s*\.(?:some|filter|find|every)\(/.test(chain) && LIVE.test(chain))
      found.push(`listForWorktree(${match[1]})${chain.slice(0, 80)}`);
  }
  // Through a variable: `const runs = …listForWorktree(…)`, later `runs.some(… live …)`.
  for (const match of text.matchAll(/const (\w+) =[^;]*?\.listForWorktree\(/g)) {
    const name = match[1]!;
    const uses = text.matchAll(
      new RegExp(`\\b${name}\\s*\\.\\s*(?:some|filter|find|every)\\(([^;]{0,200})`, 'g'),
    );
    for (const use of uses) if (LIVE.test(use[1]!)) found.push(`${name}.${use[1]!.slice(0, 80)}`);
  }
  return found;
}

it('checks live runs on a worktree with liveForWorktree, which includes investigations (R-C16)', () => {
  const offenders = sources(SOURCE).flatMap((path) =>
    liveChecksOnLineage(readFileSync(path, 'utf8')).map((found) => `${path}: ${found}`),
  );
  expect(offenders).toEqual([]);
});

it('finds live checks on the lineage listing, chained or through a variable', () => {
  expect(
    liveChecksOnLineage(
      `const live = tx.execution.runs\n  .listForWorktree(ws, tree)\n  .some((run) => !isTerminalAgentRunStatus(run.status));`,
    ),
  ).toHaveLength(1);
  expect(
    liveChecksOnLineage(
      `const runs = this.storage.execution.runs.listForWorktree(ws, tree);\nif (runs.some((r) => !['finished', 'failed', 'cancelled', 'interrupted'].includes(r.status))) {}`,
    ),
  ).toHaveLength(1);
  expect(
    liveChecksOnLineage(
      `const runs = this.storage.execution.runs.listForWorktree(ws, tree);\nconst run = runs[0];\nif (runs.length === 0 || run.status === 'finished') {}`,
    ),
  ).toEqual([]);
});
