import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * R-H4 done-when (a): nothing outside `submission(id)` and `db:verify` reads
 * `evidence_submissions.record_json`. Every list, view and policy reads the heads beside the
 * records, so a map's artifact contents are decoded only when one submission is opened.
 *
 * Structurally: across every source file the daemon, the browser app and the scripts are built
 * from, the records table is named only by the evidence repository and by `db:verify`'s scan
 * (`record-scan.ts`). Inside the repository, a statement that names it is either the insert in
 * `addSubmission` or the read in `submission`.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_ROOTS = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', 'test', 'tests', 'e2e', 'migrations', 'fixtures']);
const RECORDS = /\bevidence_submissions\b/;
const REPOSITORY = 'packages/storage/src/repositories/runtime-evidence.ts';
const DB_VERIFY_SCAN = 'packages/storage/src/record-scan.ts';

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (SKIP.has(name) || name.startsWith('.')) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

/** The class method a line belongs to: the nearest method declaration above it. */
function enclosingMethod(lines: readonly string[], index: number): string | undefined {
  for (let line = index; line >= 0; line--) {
    const match = /^ {2}(?:async |private |static )*(\w+)\(/.exec(lines[line] ?? '');
    if (match) return match[1];
    if (/^\S/.test(lines[line] ?? '') && line !== index) return undefined;
  }
  return undefined;
}

it('reads evidence records only in submission(id) and db:verify (R-H4)', () => {
  const uses: string[] = [];
  for (const root of SOURCE_ROOTS)
    for (const path of sources(join(ROOT, root))) {
      const file = relative(ROOT, path);
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!RECORDS.test(line)) return;
        if (file === DB_VERIFY_SCAN) {
          uses.push(`${file}: db:verify`);
          return;
        }
        if (file !== REPOSITORY) {
          uses.push(`${file}:${index + 1}: outside the repository`);
          return;
        }
        const method = enclosingMethod(lines, index);
        const statement = line.slice(line.search(/['"`]/) + 1).trimStart();
        if (method === 'addSubmission' && /^INSERT INTO evidence_submissions /.test(statement))
          uses.push(`${file}: addSubmission writes`);
        else if (
          method === 'submission' &&
          /^SELECT record_json FROM evidence_submissions /.test(statement)
        )
          uses.push(`${file}: submission(id) reads`);
        else uses.push(`${file}:${index + 1}: ${method ?? 'outside a method'} names the records`);
      });
    }
  expect([...new Set(uses)].sort()).toEqual([
    `${DB_VERIFY_SCAN}: db:verify`,
    `${REPOSITORY}: addSubmission writes`,
    `${REPOSITORY}: submission(id) reads`,
  ]);
});
