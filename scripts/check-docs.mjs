#!/usr/bin/env node
/**
 * Structural checks that keep the documentation true to the repository (R-I7, DOC-02, DOC-03).
 * `scripts/check-docs.test.mjs` runs each check over this checkout, so `pnpm test` (and with it
 * `pnpm check`) fails when one breaks; `node scripts/check-docs.mjs` prints the problems.
 *
 * - **Links.** Every relative link in `docs/**` and the top-level Markdown files resolves: the
 *   file or directory exists, and an anchor into a Markdown file names one of its headings (by
 *   GitHub's slug rule) or an explicit `<a id>`. Links in fenced code and inline code are text.
 * - **ADRs.** Every file in `docs/decisions/` except the index is `ADR-NNN-<slug>.md` and opens
 *   with the one header format (`# ADR-NNN: Title`, then `- **Status:**`, `- **Date:**` and the
 *   optional relation fields). A superseded ADR names what superseded it, and supersession is
 *   recorded at both ends. The index's table lists every ADR exactly once, with the title,
 *   status, date and relations of its header; `adrIndexRows` renders the expected rows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The Markdown files whose links are checked: the top-level ones and everything under docs/. */
export function markdownFiles(root) {
  const top = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  const docs = existsSync(join(root, 'docs'))
    ? readdirSync(join(root, 'docs'), { recursive: true })
        .map((name) => join('docs', String(name)))
        .filter((path) => path.endsWith('.md') && statSync(join(root, path)).isFile())
    : [];
  return [...top, ...docs].sort();
}

/** Lines outside fenced code blocks, with inline code spans removed: `[number, text]` pairs. */
function proseLines(text) {
  const lines = [];
  let fence;
  text.split('\n').forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      if (fence === undefined) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = undefined;
      return;
    }
    if (fence === undefined) lines.push([index + 1, line.replace(/`+[^`]*`+/g, '')]);
  });
  return lines;
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function headingSlug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The anchors a Markdown file defines: heading slugs (numbered when repeated) and `<a id>`. */
export function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  let fence;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker !== null) {
      if (fence === undefined) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const slug = headingSlug(heading[1]);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${count}`);
    }
    for (const explicit of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(explicit[1]);
  }
  return anchors;
}

/** Every link target on a prose line: inline `](target)` and reference definitions. */
function linkTargets(line) {
  const targets = [];
  for (const match of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g))
    targets.push(match[1].replace(/^<|>$/g, ''));
  const definition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
  if (definition !== null) targets.push(definition[1].replace(/^<|>$/g, ''));
  return targets;
}

/** Problems with relative links in the checked files, as `file:line: message` strings. */
export function checkLinks(root) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsFor = (path) => {
    if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(readFileSync(path, 'utf8')));
    return anchorCache.get(path);
  };
  for (const file of markdownFiles(root)) {
    const source = join(root, file);
    for (const [number, line] of proseLines(readFileSync(source, 'utf8'))) {
      for (const target of linkTargets(line)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const hash = target.indexOf('#');
        const path = hash === -1 ? target : target.slice(0, hash);
        const anchor = hash === -1 ? undefined : target.slice(hash + 1);
        let resolved;
        try {
          resolved = path === '' ? source : resolve(dirname(source), decodeURIComponent(path));
        } catch {
          problems.push(`${file}:${number}: malformed link ${target}`);
          continue;
        }
        if (!existsSync(resolved)) {
          problems.push(`${file}:${number}: ${target} names nothing (${relative(root, resolved)})`);
          continue;
        }
        if (anchor === undefined || anchor === '') continue;
        if (!resolved.endsWith('.md') || !statSync(resolved).isFile()) continue;
        if (!anchorsFor(resolved).has(decodeURIComponent(anchor)))
          problems.push(
            `${file}:${number}: ${target} names no heading in ${relative(root, resolved)}`,
          );
      }
    }
  }
  return problems;
}

export const ADR_STATUSES = ['proposed', 'accepted', 'partly superseded', 'superseded', 'deferred'];
/** The header fields, in the order an ADR lists them; Status and Date come first and once. */
export const ADR_FIELDS = [
  'Status',
  'Date',
  'Supersedes',
  'Superseded by',
  'Superseded in part by',
  'Refines',
  'Amended',
  'Reviewed',
];
const REPEATABLE = new Set(['Amended', 'Reviewed']);
const ADR_FILE = /^ADR-(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
/** What a relation names: other ADRs and register items. */
const REFERENCE = /ADR-\d{3}|R-[A-I]\d+[a-z]?/g;

/**
 * Reads every ADR in `<root>/docs/decisions`: `{ adrs, problems }`, where each ADR is
 * `{ file, number, title, fields }` and `fields` maps a field name to its values in order.
 */
export function readAdrs(root) {
  const directory = join(root, 'docs', 'decisions');
  const adrs = [];
  const problems = [];
  for (const file of readdirSync(directory).sort()) {
    if (file === 'README.md' || !file.endsWith('.md')) continue;
    const name = ADR_FILE.exec(file);
    if (name === null) {
      problems.push(`docs/decisions/${file}: not named ADR-NNN-<slug>.md`);
      continue;
    }
    const where = `docs/decisions/${file}`;
    const lines = readFileSync(join(directory, file), 'utf8').split('\n');
    const title = /^# ADR-(\d{3}): (\S.*)$/.exec(lines[0] ?? '');
    if (title === null || title[1] !== name[1]) {
      problems.push(`${where}: the first line must be "# ADR-${name[1]}: <title>"`);
      continue;
    }
    if (lines[1] !== '') problems.push(`${where}: a blank line must follow the title`);
    const fields = new Map();
    const order = [];
    let index = 2;
    for (; index < lines.length && lines[index] !== ''; index += 1) {
      const field = /^- \*\*([A-Za-z ]+):\*\* (\S.*)$/.exec(lines[index]);
      if (field === null || !ADR_FIELDS.includes(field[1])) {
        problems.push(`${where}:${index + 1}: not a header field: ${lines[index]}`);
        continue;
      }
      if (fields.has(field[1]) && !REPEATABLE.has(field[1]))
        problems.push(`${where}: ${field[1]} appears more than once`);
      fields.set(field[1], [...(fields.get(field[1]) ?? []), field[2]]);
      order.push(field[1]);
    }
    const ranks = order.map((field) => ADR_FIELDS.indexOf(field));
    if (ranks.some((rank, at) => at > 0 && rank < ranks[at - 1]))
      problems.push(`${where}: header fields must follow the order ${ADR_FIELDS.join(', ')}`);
    const status = fields.get('Status')?.[0];
    const date = fields.get('Date')?.[0];
    if (order[0] !== 'Status' || !ADR_STATUSES.includes(status))
      problems.push(
        `${where}: the header must open with Status, one of ${ADR_STATUSES.join(', ')}`,
      );
    if (order[1] !== 'Date' || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))
      problems.push(`${where}: the second header field must be Date: YYYY-MM-DD`);
    if ((status === 'superseded') !== fields.has('Superseded by'))
      problems.push(`${where}: Superseded by goes with, and only with, status superseded`);
    if ((status === 'partly superseded') !== fields.has('Superseded in part by'))
      problems.push(
        `${where}: Superseded in part by goes with, and only with, status partly superseded`,
      );
    adrs.push({ file, number: name[1], title: title[2], fields });
  }
  return { adrs, problems };
}

const referencesIn = (adr, ...names) =>
  names.flatMap((name) =>
    (adr.fields.get(name) ?? []).flatMap((value) => value.match(REFERENCE) ?? []),
  );

/** Supersession must be recorded at both ends, and every relation must name an existing ADR. */
function relationProblems(adrs) {
  const problems = [];
  const byId = new Map(adrs.map((adr) => [`ADR-${adr.number}`, adr]));
  for (const adr of adrs) {
    const id = `ADR-${adr.number}`;
    const where = `docs/decisions/${adr.file}`;
    for (const reference of referencesIn(
      adr,
      'Supersedes',
      'Superseded by',
      'Superseded in part by',
      'Refines',
    )) {
      if (reference.startsWith('ADR-') && !byId.has(reference))
        problems.push(`${where}: names ${reference}, which does not exist`);
      if (reference === id) problems.push(`${where}: names itself`);
    }
    for (const later of referencesIn(adr, 'Superseded by', 'Superseded in part by')) {
      const other = byId.get(later);
      if (other !== undefined && !referencesIn(other, 'Supersedes').includes(id))
        problems.push(`${where}: superseded by ${later}, whose Supersedes does not name ${id}`);
    }
    for (const earlier of referencesIn(adr, 'Supersedes')) {
      const other = byId.get(earlier);
      if (
        other !== undefined &&
        !referencesIn(other, 'Superseded by', 'Superseded in part by').includes(id)
      )
        problems.push(
          `${where}: supersedes ${earlier}, which does not say it is superseded by ${id}`,
        );
    }
  }
  return problems;
}

/** One index row's relations: the ADRs and register items each relation field names. */
function relationsOf(adr) {
  const parts = [
    ['supersedes', 'Supersedes'],
    ['superseded by', 'Superseded by'],
    ['superseded in part by', 'Superseded in part by'],
    ['refines', 'Refines'],
  ]
    .map(([label, field]) => [label, [...new Set(referencesIn(adr, field))]])
    .filter(([, references]) => references.length > 0)
    .map(([label, references]) => `${label} ${references.join(', ')}`);
  return parts.join('; ');
}

/** The index's expected table rows, one per ADR, in number order. */
export function adrIndexRows(adrs) {
  return adrs.map(
    (adr) =>
      `| [ADR-${adr.number}](${adr.file}) | ${adr.title} | ${adr.fields.get('Status')?.[0] ?? ''} | ${adr.fields.get('Date')?.[0] ?? ''} | ${relationsOf(adr)} |`,
  );
}

export const ADR_INDEX_HEADER = '| ADR | Title | Status | Date | Relations |';

/** Problems with the ADRs and their index (`docs/decisions/README.md`). */
export function checkAdrs(root) {
  const { adrs, problems } = readAdrs(root);
  problems.push(...relationProblems(adrs));
  const index = readFileSync(join(root, 'docs', 'decisions', 'README.md'), 'utf8').split('\n');
  const start = index.indexOf(ADR_INDEX_HEADER);
  if (start === -1) {
    problems.push(`docs/decisions/README.md: no index table headed "${ADR_INDEX_HEADER}"`);
    return problems;
  }
  const rows = [];
  for (let at = start + 2; at < index.length && index[at].startsWith('|'); at += 1)
    rows.push(index[at]);
  const expected = adrIndexRows(adrs);
  const missing = expected.filter((row) => !rows.includes(row));
  const unexpected = rows.filter((row) => !expected.includes(row));
  for (const row of unexpected)
    problems.push(`docs/decisions/README.md: the index row does not match an ADR header: ${row}`);
  for (const row of missing)
    problems.push(`docs/decisions/README.md: the index lacks the row ${row}`);
  if (missing.length === 0 && unexpected.length === 0 && rows.join('\n') !== expected.join('\n'))
    problems.push(
      'docs/decisions/README.md: the index rows must be in ADR number order, once each',
    );
  return problems;
}

/** Every check's problems for a checkout. */
export function checkDocs(root = REPOSITORY_ROOT) {
  return [...checkLinks(root), ...checkAdrs(root)];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkDocs();
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    const { adrs } = readAdrs(REPOSITORY_ROOT);
    console.error(`\nThe ADR index rows, from the headers:\n${adrIndexRows(adrs).join('\n')}`);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}
