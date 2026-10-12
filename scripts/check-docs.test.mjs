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
  checkEnvironmentList,
  checkLinks,
  documentedVariables,
  environmentReads,
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
  it('has no broken relative link, malformed ADR, stale ADR index row or unlisted variable', () => {
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
        '[mail](mailto:op@example.org), [empty anchor](docs/guide.md#), [text](docs/notes.txt#l2)',
        '```',
        '[fenced](docs/missing.md)',
        '~~~ a tilde line inside a backtick fence does not close it',
        '[still fenced](docs/missing.md)',
        '```',
        '# Top',
      ].join('\n'),
      'docs/guide.md': '## Two `words`\n## Repeated\n## Repeated\n<a id="kept"></a>\n',
      'docs/notes.txt': 'plain text\n',
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
      'ADR-007-Foo Bar.md': ADR('007', 'Foo', accepted()),
    });
    expect(checkAdrs(root)).toEqual([
      'docs/decisions/004-bare.md: not named ADR-NNN-<slug>.md',
      'docs/decisions/ADR-005-wrong.md: the first line must be "# ADR-005: <title>"',
      'docs/decisions/ADR-007-Foo Bar.md: not named ADR-NNN-<slug>.md',
    ]);
  });

  it('requires a blank line after the title and a bare ISO date', () => {
    const root = decisions({
      'ADR-001-a.md': '# ADR-001: A\n- **Status:** accepted\n- **Date:** 2026-01-01\n\nText.\n',
      'ADR-002-b.md': ADR('002', 'B', [
        ['Status', 'accepted'],
        ['Date', '2026-01-01 approx'],
      ]),
    });
    expect(checkAdrs(root)).toEqual(
      expect.arrayContaining([
        'docs/decisions/ADR-001-a.md: a blank line must follow the title',
        'docs/decisions/ADR-002-b.md: the second header field must be Date: YYYY-MM-DD',
      ]),
    );
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

  it('requires partial supersession at its later end, and never counts Refines as Supersedes', () => {
    const problems = checkAdrs(
      decisions({
        'ADR-001-a.md': ADR('001', 'A', [
          ['Status', 'partly superseded'],
          ['Date', '2026-01-01'],
          ['Superseded in part by', 'ADR-002 (one clause)'],
        ]),
        'ADR-002-b.md': ADR('002', 'B', accepted()),
        'ADR-003-c.md': ADR('003', 'C', [
          ['Status', 'superseded'],
          ['Date', '2026-01-01'],
          ['Superseded by', 'ADR-004'],
        ]),
        'ADR-004-d.md': ADR('004', 'D', [...accepted(), ['Refines', 'ADR-003']]),
      }),
    );
    expect(problems).toEqual([
      'docs/decisions/ADR-001-a.md: superseded by ADR-002, whose Supersedes does not name ADR-001',
      'docs/decisions/ADR-003-c.md: superseded by ADR-004, whose Supersedes does not name ADR-003',
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

const operations = (tables) =>
  [
    '# Operations',
    '## Environment variables',
    ...Object.entries(tables).flatMap(([table, names]) => [
      `### ${table}`,
      '| Variable | Default | Meaning |',
      '|---|---|---|',
      ...names.map((name) => `| \`${name}\` | unset | What it does. |`),
    ]),
    '## Next',
    '| `CRAFTINGTABLE_ELSEWHERE` | not in the section |',
  ].join('\n');
const config = (reads, retired) =>
  `${reads.map((name) => `const a = env.${name};`).join('\n')}\nconst b = env['HOME'];\nconst RETIRED_SETTINGS = [\n${retired.map((name) => `  '${name}',`).join('\n')}\n] as const;\n`;
const environment = (overrides = {}) => {
  const files = {
    'apps/server/src/config.ts': config(
      ['CRAFTINGTABLE_PORT', 'XDG_DATA_HOME'],
      ['CRAFTINGTABLE_OLD'],
    ),
    'scripts/deploy-daemon.mjs': 'const root = process.env.CRAFTINGTABLE_DEPLOY_ROOT;\n',
    'apps/server/test/e2e/harness.ts': "process.env['CRAFTINGTABLE_TEST_ONLY'];\n",
    'packages/agents/src/launch.ts': "const set = { CRAFTINGTABLE_RUN_ID: 'x' };\n",
    'vitest.config.ts': 'process.env.CRAFTINGTABLE_SCALE;\n',
    'apps/server/node_modules/dep/index.js': 'CRAFTINGTABLE_IN_A_DEPENDENCY',
    'apps/server/dist/config.js': 'CRAFTINGTABLE_IN_BUILD_OUTPUT',
    'scripts/check-docs.test.mjs': 'CRAFTINGTABLE_FIXTURE_IN_THIS_TEST',
    'docs/operations.md': operations({
      Daemon: ['CRAFTINGTABLE_PORT', 'XDG_DATA_HOME', 'HOME'],
      Deploy: ['CRAFTINGTABLE_DEPLOY_ROOT'],
      Tests: ['CRAFTINGTABLE_TEST_ONLY', 'CRAFTINGTABLE_SCALE'],
      'Set by the daemon': ['CRAFTINGTABLE_RUN_ID'],
      Retired: ['CRAFTINGTABLE_OLD'],
    }),
    ...overrides,
  };
  return tree(files);
};

describe('checkEnvironmentList', () => {
  it('accepts a list that covers the sources, the two programs and the retired settings', () => {
    expect(checkEnvironmentList(environment())).toEqual([]);
  });

  it('refuses a name the sources mention but the list does not, and the reverse', () => {
    const root = environment({
      'packages/git/src/new.ts': 'env.CRAFTINGTABLE_NEW_SETTING',
      'docs/operations.md': operations({
        Daemon: ['CRAFTINGTABLE_PORT', 'XDG_DATA_HOME', 'HOME', 'CRAFTINGTABLE_GONE'],
        Deploy: ['CRAFTINGTABLE_DEPLOY_ROOT'],
        Tests: ['CRAFTINGTABLE_TEST_ONLY', 'CRAFTINGTABLE_SCALE'],
        'Set by the daemon': ['CRAFTINGTABLE_RUN_ID'],
        Retired: ['CRAFTINGTABLE_OLD'],
      }),
    });
    expect(checkEnvironmentList(root)).toEqual([
      'docs/operations.md: CRAFTINGTABLE_NEW_SETTING (in packages/git/src/new.ts) is not listed',
      'docs/operations.md: CRAFTINGTABLE_GONE is listed, but no source mentions it',
    ]);
  });

  it('requires what config.ts and the deploy script read in their own tables', () => {
    const root = environment({
      'docs/operations.md': operations({
        Daemon: ['CRAFTINGTABLE_PORT', 'CRAFTINGTABLE_DEPLOY_ROOT'],
        Deploy: ['XDG_DATA_HOME'],
        Tests: ['CRAFTINGTABLE_TEST_ONLY', 'CRAFTINGTABLE_SCALE'],
        'Set by the daemon': ['CRAFTINGTABLE_RUN_ID'],
        Retired: ['CRAFTINGTABLE_OLD'],
      }),
    });
    expect(checkEnvironmentList(root)).toEqual([
      'docs/operations.md: HOME, which apps/server/src/config.ts reads, is not in the Daemon table',
      'docs/operations.md: XDG_DATA_HOME, which apps/server/src/config.ts reads, is not in the Daemon table',
      'docs/operations.md: CRAFTINGTABLE_DEPLOY_ROOT, which scripts/deploy-daemon.mjs reads, is not in the Deploy table',
    ]);
  });

  it('requires the Retired table to equal RETIRED_SETTINGS', () => {
    const root = environment({
      'apps/server/src/config.ts': config(
        ['CRAFTINGTABLE_PORT', 'XDG_DATA_HOME'],
        ['CRAFTINGTABLE_OLD', 'CRAFTINGTABLE_OLDER'],
      ),
    });
    expect(checkEnvironmentList(root)).toEqual([
      'docs/operations.md: CRAFTINGTABLE_OLDER (in apps/server/src/config.ts) is not listed',
      'docs/operations.md: the Retired table must list exactly RETIRED_SETTINGS: CRAFTINGTABLE_OLD, CRAFTINGTABLE_OLDER',
    ]);
  });

  it('refuses malformed rows, unknown or missing tables and repeats', () => {
    const text = [
      '## Environment variables',
      '| `CRAFTINGTABLE_A` | before any table |',
      '### Daemon',
      '| `CRAFTINGTABLE_A`, `CRAFTINGTABLE_B` | two names |',
      '| `CRAFTINGTABLE_C` | x |',
      '| `CRAFTINGTABLE_C` | x |',
      '### Others',
      '### Daemon',
    ].join('\n');
    const { tables, problems } = documentedVariables(text);
    expect(tables.get('Daemon')).toEqual(['CRAFTINGTABLE_C', 'CRAFTINGTABLE_C']);
    expect(problems).toEqual([
      'docs/operations.md:2: a row must start with one backticked name, under a table heading',
      'docs/operations.md:4: a row must start with one backticked name, under a table heading',
      'docs/operations.md:6: CRAFTINGTABLE_C is listed twice in "Daemon"',
      'docs/operations.md:7: "Others" is not one of Daemon, Deploy, Tests, Set by the daemon, Retired',
      'docs/operations.md:8: a second "Daemon" table',
      'docs/operations.md: no "### Deploy" table',
      'docs/operations.md: no "### Tests" table',
      'docs/operations.md: no "### Set by the daemon" table',
      'docs/operations.md: no "### Retired" table',
    ]);
    expect(documentedVariables('# Nothing').problems).toEqual([
      'docs/operations.md: no "## Environment variables" section',
    ]);
  });

  it('reads literal env names, dotted, bracketed or destructured', () => {
    expect([...environmentReads("env.A_B; process.env.C; env['D']; env[name]; myenv.E")]).toEqual([
      'A_B',
      'C',
      'D',
    ]);
    expect([
      ...environmentReads(
        'const { F, G: g, H = 1, lower } = process.env; const {I} = env; f({ J } = env2);',
      ),
    ]).toEqual(['F', 'G', 'H', 'I']);
  });

  it('requires a destructured read of config.ts in the Daemon table', () => {
    const root = environment({
      'apps/server/src/config.ts': `${config(['CRAFTINGTABLE_PORT', 'XDG_DATA_HOME'], ['CRAFTINGTABLE_OLD'])}const { HOSTNAME_OVERRIDE } = env;\n`,
    });
    expect(checkEnvironmentList(root)).toEqual([
      'docs/operations.md: HOSTNAME_OVERRIDE, which apps/server/src/config.ts reads, is not in the Daemon table',
    ]);
  });
});
