import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADR_INDEX_HEADER,
  adrIndexRows,
  anchorsOf,
  checkAdrs,
  checkDocs,
  checkLinks,
  headingSlug,
  readAdrs,
} from './check-docs.mjs';

/** The documentation checks (R-I7) over this checkout, and each rule over a scratch tree. */

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-check-docs-test-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe('this checkout', () => {
  it('has no broken relative link, malformed ADR or stale ADR index row', () => {
    expect(checkDocs()).toEqual([]);
  });
});

describe('checkLinks', () => {
  it('accepts files, directories, headings and explicit anchors, and skips code and URLs', () => {
    const root = tree({
      'README.md': [
        '[guide](docs/guide.md), [section](docs/guide.md#two-words), [dir](docs/)',
        '[again](docs/guide.md#repeated-1), [anchor](docs/guide.md#kept), [self](#top)',
        '[web](https://example.org/missing.md), `[code](docs/missing.md)`',
        '```',
        '[fenced](docs/missing.md)',
        '```',
        '# Top',
      ].join('\n'),
      'docs/guide.md': '## Two `words`\n## Repeated\n## Repeated\n<a id="kept"></a>\n',
    });
    expect(checkLinks(root)).toEqual([]);
  });

  it('reports a missing file, a missing heading and a broken reference definition', () => {
    const root = tree({
      'README.md': '[a](docs/missing.md)\n[b](docs/guide.md#nowhere)\n',
      'docs/guide.md': '# Guide\n[c]: ../gone.md\n[d](#nowhere-here)\n',
    });
    const problems = checkLinks(root);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^README\.md:1: docs\/missing\.md names nothing/);
    expect(problems[1]).toMatch(/^README\.md:2: docs\/guide\.md#nowhere names no heading/);
    expect(problems[2]).toMatch(/^docs\/guide\.md:2: \.\.\/gone\.md names nothing/);
    expect(problems[3]).toMatch(/^docs\/guide\.md:3: #nowhere-here names no heading/);
  });

  it('checks links in nested docs relative to their own directory', () => {
    const root = tree({
      'docs/ui/a.md': '[up](../b.md) [same](c.md)\n',
      'docs/b.md': '# B\n',
    });
    expect(checkLinks(root)).toEqual([
      expect.stringMatching(/^docs\/ui\/a\.md:1: c\.md names nothing/),
    ]);
  });

  it('slugs headings as GitHub does', () => {
    expect(headingSlug("The daemon's own Git")).toBe('the-daemons-own-git');
    expect(headingSlug('R-I7: `docs` and [links](x.md)')).toBe('r-i7-docs-and-links');
    expect([...anchorsOf('# A\n# A\n```\n# B\n```\n')]).toEqual(['a', 'a-1']);
  });
});

const ADR = (number, title, fields, body = 'Text.') =>
  `# ADR-${number}: ${title}\n\n${fields.map(([k, v]) => `- **${k}:** ${v}`).join('\n')}\n\n${body}\n`;
const decisions = (adrs, rows) => {
  const files = { 'docs/decisions/README.md': '' };
  for (const [file, text] of Object.entries(adrs)) files[`docs/decisions/${file}`] = text;
  const root = tree(files);
  const index = rows ?? adrIndexRows(readAdrs(root).adrs);
  writeFileSync(
    join(root, 'docs/decisions/README.md'),
    `# Index\n\n${ADR_INDEX_HEADER}\n|---|---|---|---|---|\n${index.join('\n')}\n`,
  );
  return root;
};
const accepted = (date = '2026-01-01') => [
  ['Status', 'accepted'],
  ['Date', date],
];

describe('checkAdrs', () => {
  it('accepts well-formed ADRs with supersession recorded at both ends', () => {
    const root = decisions({
      'ADR-001-first.md': ADR('001', 'First', [
        ['Status', 'superseded'],
        ['Date', '2026-01-01'],
        ['Superseded by', 'ADR-002 (all of it)'],
      ]),
      'ADR-002-second.md': ADR('002', 'Second', [
        ...accepted(),
        ['Supersedes', 'ADR-001'],
        ['Refines', 'ADR-003'],
        ['Amended', '2026-02-01 (R-A1): one'],
        ['Amended', '2026-03-01: two'],
      ]),
      'ADR-003-third.md': ADR('003', 'Third', [
        ['Status', 'partly superseded'],
        ['Date', '2026-01-02'],
        ['Superseded in part by', 'register item R-B8'],
      ]),
    });
    expect(checkAdrs(root)).toEqual([]);
    expect(adrIndexRows(readAdrs(root).adrs)).toEqual([
      '| [ADR-001](ADR-001-first.md) | First | superseded | 2026-01-01 | superseded by ADR-002 |',
      '| [ADR-002](ADR-002-second.md) | Second | accepted | 2026-01-01 | supersedes ADR-001; refines ADR-003 |',
      '| [ADR-003](ADR-003-third.md) | Third | partly superseded | 2026-01-02 | superseded in part by R-B8 |',
    ]);
  });

  it('refuses a file not named ADR-NNN-<slug>.md and a title that disagrees with it', () => {
    const root = decisions({
      '004-bare.md': ADR('004', 'Bare', accepted()),
      'ADR-005-wrong.md': ADR('006', 'Wrong', accepted()),
    });
    expect(checkAdrs(root)).toEqual([
      'docs/decisions/004-bare.md: not named ADR-NNN-<slug>.md',
      'docs/decisions/ADR-005-wrong.md: the first line must be "# ADR-005: <title>"',
    ]);
  });

  it('refuses a header out of format, order or vocabulary', () => {
    const problems = checkAdrs(
      decisions({
        'ADR-001-a.md': '# ADR-001: A\n\nStatus: accepted\n\nText.\n',
        'ADR-002-b.md': ADR('002', 'B', [
          ['Date', '2026-01-01'],
          ['Status', 'accepted'],
        ]),
        'ADR-003-c.md': ADR('003', 'C', [
          ['Status', 'done'],
          ['Date', 'yesterday'],
        ]),
        'ADR-004-d.md': ADR('004', 'D', [...accepted(), ['Status', 'accepted'], ['Notes', 'x']]),
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'docs/decisions/ADR-001-a.md:3: not a header field: Status: accepted',
        expect.stringMatching(/^docs\/decisions\/ADR-002-b\.md: header fields must follow/),
        expect.stringMatching(/^docs\/decisions\/ADR-002-b\.md: the header must open with Status/),
        expect.stringMatching(/^docs\/decisions\/ADR-003-c\.md: the header must open with Status/),
        expect.stringMatching(
          /^docs\/decisions\/ADR-003-c\.md: the second header field must be Date/,
        ),
        'docs/decisions/ADR-004-d.md: Status appears more than once',
        'docs/decisions/ADR-004-d.md:6: not a header field: - **Notes:** x',
      ]),
    );
  });

  it('ties superseded statuses to their fields, both ways', () => {
    const problems = checkAdrs(
      decisions({
        'ADR-001-a.md': ADR('001', 'A', [
          ['Status', 'superseded'],
          ['Date', '2026-01-01'],
        ]),
        'ADR-002-b.md': ADR('002', 'B', [...accepted(), ['Superseded by', 'ADR-001']]),
        'ADR-003-c.md': ADR('003', 'C', [
          ['Status', 'partly superseded'],
          ['Date', '2026-01-01'],
        ]),
        'ADR-004-d.md': ADR('004', 'D', [...accepted(), ['Superseded in part by', 'R-A1']]),
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'docs/decisions/ADR-001-a.md: Superseded by goes with, and only with, status superseded',
        'docs/decisions/ADR-002-b.md: Superseded by goes with, and only with, status superseded',
        'docs/decisions/ADR-003-c.md: Superseded in part by goes with, and only with, status partly superseded',
        'docs/decisions/ADR-004-d.md: Superseded in part by goes with, and only with, status partly superseded',
      ]),
    );
  });

  it('requires supersession at both ends and relations to existing ADRs', () => {
    const problems = checkAdrs(
      decisions({
        'ADR-001-a.md': ADR('001', 'A', [
          ['Status', 'superseded'],
          ['Date', '2026-01-01'],
          ['Superseded by', 'ADR-002'],
        ]),
        'ADR-002-b.md': ADR('002', 'B', [...accepted(), ['Refines', 'ADR-009']]),
        'ADR-003-c.md': ADR('003', 'C', [...accepted(), ['Supersedes', 'ADR-002, ADR-003']]),
      }),
    );
    expect(problems).toEqual([
      'docs/decisions/ADR-001-a.md: superseded by ADR-002, whose Supersedes does not name ADR-001',
      'docs/decisions/ADR-002-b.md: names ADR-009, which does not exist',
      'docs/decisions/ADR-003-c.md: names itself',
      'docs/decisions/ADR-003-c.md: supersedes ADR-002, which does not say it is superseded by ADR-003',
      'docs/decisions/ADR-003-c.md: supersedes ADR-003, which does not say it is superseded by ADR-003',
    ]);
  });

  it('requires the index to list every ADR once, as its header says, in order', () => {
    const adrs = {
      'ADR-001-a.md': ADR('001', 'A', accepted()),
      'ADR-002-b.md': ADR('002', 'B', accepted('2026-01-02')),
    };
    const rows = adrIndexRows(readAdrs(decisions(adrs)).adrs);
    expect(checkAdrs(decisions(adrs, rows))).toEqual([]);
    expect(checkAdrs(decisions(adrs, [rows[0]]))).toEqual([
      `docs/decisions/README.md: the index lacks the row ${rows[1]}`,
    ]);
    const stale = rows[1].replace('accepted', 'proposed');
    expect(checkAdrs(decisions(adrs, [rows[0], stale]))).toEqual([
      `docs/decisions/README.md: the index row does not match an ADR header: ${stale}`,
      `docs/decisions/README.md: the index lacks the row ${rows[1]}`,
    ]);
    expect(checkAdrs(decisions(adrs, [rows[1], rows[0]]))).toEqual([
      'docs/decisions/README.md: the index rows must be in ADR number order, once each',
    ]);
    expect(checkAdrs(decisions(adrs, [...rows, rows[1]]))).toEqual([
      'docs/decisions/README.md: the index rows must be in ADR number order, once each',
    ]);
  });

  it('requires the index table', () => {
    const root = tree({
      'docs/decisions/README.md': '# Index\n',
      'docs/decisions/ADR-001-a.md': ADR('001', 'A', accepted()),
    });
    expect(checkAdrs(root)).toEqual([
      `docs/decisions/README.md: no index table headed "${ADR_INDEX_HEADER}"`,
    ]);
  });
});
