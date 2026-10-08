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
 * from, the records table is named only by the evidence repository and by `db:verify`
 * (`record-scan.ts`: its record sources and `evidenceHeadProblems`). Inside the repository, a
 * statement that names it is either the insert in `addSubmission` or the read in `submission`.
 *
 * Before matching, adjacent string literals joined with `+` and literals interpolated into a
 * template are folded together, so `'evidence_' + 'submissions'` and `` `evidence_${'submissions'}` ``
 * are seen as the table. A name that starts `evidence_` and goes on through an expression
 * (`'evidence_' + table`, `` `evidence_${table}` ``) fails outright, since nothing reads a table
 * that way legitimately. Limits, pinned here: a name assembled without the `evidence_` prefix in
 * one literal and without `+` between literals (from character codes, `join`, or a variable
 * holding `'evidence'`) is not seen; the server's decode test (`server-evidence-heads.test.ts`)
 * covers the views and checks behaviourally.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_ROOTS = ['apps', 'packages', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', 'test', 'tests', 'e2e', 'migrations', 'fixtures']);
const RECORDS = /\bevidence_submissions\b/;
/** `evidence_` followed by anything but more of an identifier: a name built at run time. */
const DYNAMIC = /\bevidence_(?![A-Za-z0-9_])/;
const REPOSITORY = 'packages/storage/src/repositories/runtime-evidence.ts';
const DB_VERIFY = 'packages/storage/src/record-scan.ts';
/** The top-level declarations of `record-scan.ts` that are `db:verify`. */
const DB_VERIFY_DECLARATIONS = new Set(['SOURCES', 'evidenceHeadProblems']);

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (SKIP.has(name) || name.startsWith('.')) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

/**
 * Folds `'a' + 'b'` into `'ab'` and `` `a${'b'}` `` into `` `ab` ``. A fold across lines joins them,
 * so a later line number in a report can be off by the lines joined.
 */
function foldLiterals(text: string): string {
  let folded = text;
  for (let previous = ''; previous !== folded; ) {
    previous = folded;
    folded = folded
      .replace(/(['"`])\s*\+\s*(['"`])/g, '')
      .replace(/\$\{\s*(['"])([^'"`\n]*)\1\s*\}/g, '$2');
  }
  return folded;
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

/** The top-level declaration a line belongs to. */
function enclosingDeclaration(lines: readonly string[], index: number): string | undefined {
  for (let line = index; line >= 0; line--) {
    const match = /^(?:export )?(?:const|function|class|let) (\w+)/.exec(lines[line] ?? '');
    if (match) return match[1];
  }
  return undefined;
}

/** Each place `file` names the evidence records, classified. */
function usesIn(file: string, text: string): string[] {
  const uses: string[] = [];
  const lines = foldLiterals(text).split('\n');
  lines.forEach((line, index) => {
    if (DYNAMIC.test(line)) {
      uses.push(`${file}:${index + 1}: builds an evidence table name at run time`);
      return;
    }
    if (!RECORDS.test(line)) return;
    if (file === DB_VERIFY) {
      const declaration = enclosingDeclaration(lines, index);
      uses.push(
        DB_VERIFY_DECLARATIONS.has(declaration ?? '')
          ? `${file}: db:verify`
          : `${file}:${index + 1}: ${declaration ?? 'top level'} names the records`,
      );
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
  return uses;
}

it('reads evidence records only in submission(id) and db:verify (R-H4)', () => {
  const uses: string[] = [];
  for (const root of SOURCE_ROOTS)
    for (const path of sources(join(ROOT, root)))
      uses.push(...usesIn(relative(ROOT, path), readFileSync(path, 'utf8')));
  expect([...new Set(uses)].sort()).toEqual([
    `${DB_VERIFY}: db:verify`,
    `${REPOSITORY}: addSubmission writes`,
    `${REPOSITORY}: submission(id) reads`,
  ]);
});

it('sees a table name split across literals or built at run time, and pins what it cannot see', () => {
  const read = (file: string, line: string) => usesIn(file, line);
  // Folded, then judged by place.
  expect(
    read('apps/server/src/x.ts', "db.prepare('SELECT record_json FROM evidence_' + 'submissions')"),
  ).toEqual(['apps/server/src/x.ts:1: outside the repository']);
  expect(
    read(
      'packages/storage/src/storage.ts',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test.
      "db.prepare(`SELECT * FROM evidence_${'submissions'}`)",
    ),
  ).toEqual(['packages/storage/src/storage.ts:1: outside the repository']);
  expect(
    read(
      REPOSITORY,
      "  submissions(ws: string) {\n    return this.db.prepare(\n      'SELECT record_json FROM evidence_' +\n        'submissions WHERE workspace_id=?',\n    );",
    ),
  ).toEqual([`${REPOSITORY}:3: submissions names the records`]);
  // A name that continues through an expression fails wherever it is.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test.
  for (const dynamic of ["'evidence_' + table", '`evidence_${table}`'])
    expect(read(REPOSITORY, `  submission() { return ${dynamic}; }`)).toEqual([
      `${REPOSITORY}:1: builds an evidence table name at run time`,
    ]);
  // Inside db:verify's module, only its record sources and head check may name the records.
  expect(
    read(DB_VERIFY, 'export function other() {\n  return "SELECT 1 FROM evidence_submissions";\n}'),
  ).toEqual([`${DB_VERIFY}:2: other names the records`]);
  // Not seen: a name with no `evidence_` literal and no `+` between literals.
  expect(read('apps/server/src/x.ts', "['evidence', 'submissions'].join('_')")).toEqual([]);
  // Plan-format fields and the other evidence tables are not the records.
  expect(read('apps/server/src/x.ts', 'p.evidence_profile; "evidence_submission_heads"')).toEqual(
    [],
  );
});
