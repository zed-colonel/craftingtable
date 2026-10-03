import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyCase, dataHome, main, matchExpected, validateManifest } from './replays.mjs';

/** The replay gate (R-I10, TS-M12) over synthetic manifests, snapshots and replay reports. */

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'craftingtable-replays-test-'));
  roots.push(root);
  return root;
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const manifest = (snapshots) => ({ root: 'review/replay', snapshots });
const snapshot = (overrides = {}) => ({
  id: '2026-01-01',
  sha256: HASH,
  cases: [{ mode: 'golden', golden: 'golden.json', goldenSha256: HASH }],
  ...overrides,
});

describe('validateManifest', () => {
  it('accepts the committed manifest and a minimal one', () => {
    const committed = JSON.parse(
      readFileSync(new URL('./replays.manifest.json', import.meta.url), 'utf8'),
    );
    expect(validateManifest(committed)).toEqual([]);
    expect(
      validateManifest(
        manifest([
          snapshot({
            cases: [
              {
                mode: 'every-run',
                golden: 'every-run-golden-abc.json',
                goldenSha256: HASH,
                expected: [{ key: 'c/r', nowSha256: HASH, reason: 'LIVE-1' }],
              },
            ],
          }),
          { id: '2026-01-02', withoutGolden: 'No golden was recorded.' },
        ]),
      ),
    ).toEqual([]);
  });

  it('refuses paths outside $XDG_DATA_HOME and machine-specific paths', () => {
    for (const root of ['/home/someone/.local/share/replay', '../replay', 'a/../../b', 'a//b', ''])
      expect(validateManifest({ ...manifest([snapshot()]), root }).join(' ')).toMatch(/"root"/);
    expect(validateManifest(manifest([snapshot({ id: '../2026' })])).join(' ')).toMatch(/"id"/);
    expect(
      validateManifest(
        manifest([
          snapshot({ cases: [{ mode: 'golden', golden: '../golden.json', goldenSha256: HASH }] }),
        ]),
      ).join(' '),
    ).toMatch(/"golden"/);
  });

  it('names every other problem', () => {
    const errors = validateManifest({
      root: 'review',
      extra: true,
      snapshots: [
        snapshot({ sha256: 'abc' }),
        snapshot(),
        { id: '2026-01-03', withoutGolden: 'none', cases: [] },
        { id: '2026-01-04' },
        snapshot({
          id: '2026-01-05',
          cases: [
            { mode: 'golden', golden: 'a.json', goldenSha256: HASH },
            { mode: 'golden', golden: 'b.json', goldenSha256: HASH },
            { mode: 'record', golden: 'c.json' },
            {
              mode: 'scheduler',
              golden: 'd.json',
              goldenSha256: HASH,
              expected: [
                { key: 'k', nowSha256: HASH, reason: 'why' },
                { key: 'k', nowSha256: 'short', reason: '' },
              ],
            },
          ],
        }),
      ],
    });
    expect(errors).toEqual([
      'Unknown manifest field "extra".',
      'snapshot 2026-01-01: "sha256" must be the snapshot\'s SHA-256 (64 hex digits).',
      'snapshot 2026-01-01: listed twice.',
      'snapshot 2026-01-03: a snapshot without a golden has no cases and no "sha256".',
      'snapshot 2026-01-04: "sha256" must be the snapshot\'s SHA-256 (64 hex digits).',
      'snapshot 2026-01-04: "cases" must be a non-empty list, or "withoutGolden" must say why not.',
      'snapshot 2026-01-05 cases[1]: mode golden is listed twice.',
      'snapshot 2026-01-05 cases[2]: "goldenSha256" must be the golden\'s SHA-256 (64 hex digits).',
      'snapshot 2026-01-05 cases[2]: "mode" must be one of golden, every-run, scheduler, evidence-view.',
      'snapshot 2026-01-05 cases[3] expected[1]: key k listed twice.',
      'snapshot 2026-01-05 cases[3] expected[1]: "nowSha256" must be the SHA-256 of the record\'s new value.',
      'snapshot 2026-01-05 cases[3] expected[1]: "reason" must say why it changed.',
    ]);
  });
});

describe('matchExpected', () => {
  const expected = [{ key: 'c/r1', nowSha256: HASH, reason: 'LIVE-32' }];

  it('accepts a change only at its expected key with its expected new value', () => {
    expect(
      matchExpected({ changed: [{ key: 'c/r1', nowSha256: HASH }], missing: [] }, expected),
    ).toEqual({ matched: ['c/r1'], unexpected: [] });
    // A further change to an expected record is a new difference, not the expected one.
    expect(
      matchExpected({ changed: [{ key: 'c/r1', nowSha256: OTHER }], missing: [] }, expected)
        .unexpected,
    ).toEqual([`changed c/r1 to a value other than the expected one (now ${OTHER})`]);
  });

  it('counts each difference: a repeated, unlisted or missing record is unexpected', () => {
    expect(
      matchExpected(
        {
          changed: [
            { key: 'c/r1', nowSha256: HASH },
            { key: 'c/r1', nowSha256: HASH },
            { key: 'c/r2', nowSha256: HASH },
          ],
          missing: ['c/r3'],
        },
        expected,
      ),
    ).toEqual({
      matched: ['c/r1'],
      unexpected: [`changed c/r1 (now ${HASH})`, `changed c/r2 (now ${HASH})`, 'missing c/r3'],
    });
  });

  it('fails an expected change that did not happen', () => {
    expect(matchExpected({ changed: [], missing: [] }, expected).unexpected).toEqual([
      'expected change did not happen: c/r1 (LIVE-32)',
    ]);
  });
});

describe('classifyCase', () => {
  const clean = { records: 3, changed: [], missing: [], notCompared: [] };
  it('passes a clean replay and fails every way a replay can go wrong', () => {
    expect(classifyCase({ status: 0, report: clean })).toMatchObject({ ok: true, records: 3 });
    expect(classifyCase({ status: 2, report: clean }).problems).toEqual([
      'replay usage error (exit 2)',
    ]);
    expect(classifyCase({ status: 134, report: clean }).problems).toEqual([
      'replay failed (exit 134)',
    ]);
    expect(classifyCase({ status: null, signal: 'SIGKILL' }).problems).toEqual([
      'replay ended by signal SIGKILL',
    ]);
    expect(classifyCase({ status: 1 }).problems).toEqual(['replay wrote no check report']);
    expect(classifyCase({ status: 1, report: clean }).problems).toEqual([
      'replay exit 1 disagrees with its report',
    ]);
  });
});

describe('dataHome', () => {
  it('reads $XDG_DATA_HOME, and its default when unset or relative', () => {
    expect(dataHome({ XDG_DATA_HOME: '/data', HOME: '/home/x' })).toBe('/data');
    expect(dataHome({ XDG_DATA_HOME: 'data', HOME: '/home/x' })).toBe('/home/x/.local/share');
    expect(dataHome({ HOME: '/home/x' })).toBe('/home/x/.local/share');
  });
});

describe('main', () => {
  /**
   * A corpus of one snapshot with a golden and a scheduler case, and a fake runner: `tsc -b`
   * exits `build`, and each replay writes `reports[mode]` and exits as its report says.
   */
  function gate({ build = 0, reports = {}, manifestOf = (m) => m, files = {}, argv = [] } = {}) {
    const root = scratch();
    const data = join(root, 'data');
    const directory = join(data, 'review', 'replay', '2026-01-01');
    mkdirSync(directory, { recursive: true });
    const content = 'not really sqlite';
    const source = join(directory, 'snapshot.sqlite');
    writeFileSync(source, content);
    for (const name of ['golden.json', 'scheduler-golden.json', ...Object.keys(files)])
      writeFileSync(join(directory, name), files[name] ?? '[]');
    const manifestFile = join(root, 'manifest.json');
    writeFileSync(
      manifestFile,
      JSON.stringify(
        manifestOf(
          manifest([
            snapshot({
              sha256: sha256(content),
              cases: [
                { mode: 'golden', golden: 'golden.json', goldenSha256: sha256('[]') },
                {
                  mode: 'scheduler',
                  golden: 'scheduler-golden.json',
                  goldenSha256: sha256('[]'),
                  expected: [{ key: 'entry:r/e', nowSha256: HASH, reason: 'LIVE-1' }],
                },
              ],
            }),
          ]),
        ),
      ),
    );
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('tsc')) return { status: build };
      const copy = args[2];
      const golden = args[args.indexOf('--check') + 1];
      // The replay reads private copies, never the corpus.
      expect(copy).not.toBe(source);
      expect(readFileSync(copy, 'utf8')).toBe(content);
      expect(golden.startsWith(directory)).toBe(false);
      expect(readFileSync(golden, 'utf8')).toBe('[]');
      const mode = args.includes('--scheduler') ? 'scheduler' : 'golden';
      const report = reports[mode] ?? {
        records: 2,
        changed:
          mode === 'scheduler' ? [{ key: 'entry:r/e', was: {}, now: {}, nowSha256: HASH }] : [],
        missing: [],
        notCompared: [],
      };
      if (report === 'none') return { status: 1 };
      writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify(report));
      return { status: report.changed.length || report.missing.length ? 1 : 0 };
    };
    const lines = [];
    const exit = main(['--manifest', manifestFile, '--out', join(root, 'out'), ...argv], {
      env: { XDG_DATA_HOME: data },
      run,
      log: (line) => lines.push(line),
    });
    return { exit, calls, lines, directory, root };
  }

  it('builds, replays each case on a copy with argument arrays, and exits 0 when all is expected', async () => {
    const { exit, calls, lines, root } = gate();
    expect(await exit).toBe(0);
    expect(calls[0]).toEqual(['pnpm', 'exec', 'tsc', '-b']);
    expect(calls.slice(1).map((call) => call.filter((arg) => !arg.startsWith('/')))).toEqual([
      ['pnpm', '-s', 'controller:replay', '--check', '--report'],
      ['pnpm', '-s', 'controller:replay', '--scheduler', '--check', '--report'],
    ]);
    expect(lines.at(-1)).toMatch(
      /^1 of 2 comparisons report 0 changed; 1 differ only as expected; 0 failed\./,
    );
    // The copy is gone; the output directory keeps each case's report.
    expect(existsSync(calls[1][3])).toBe(false);
    expect(existsSync(join(root, 'out', '2026-01-01-scheduler.report.json'))).toBe(true);
  });

  it('exits 1 on an unexpected change, a missing record or a crash', async () => {
    const changed = {
      records: 2,
      changed: [{ key: 'c/r', was: {}, now: {}, nowSha256: OTHER }],
      missing: [],
      notCompared: [],
    };
    for (const golden of [
      changed,
      { records: 1, changed: [], missing: ['c/r'], notCompared: [] },
      'none',
    ]) {
      const { exit, lines } = gate({ reports: { golden } });
      expect(await exit).toBe(1);
      expect(lines.join('\n')).toMatch(/2026-01-01 golden: UNEXPECTED/);
    }
    // The expected scheduler change did not happen.
    const absent = gate({
      reports: { scheduler: { records: 2, changed: [], missing: [], notCompared: [] } },
    });
    expect(await absent.exit).toBe(1);
    expect(absent.lines.join('\n')).toMatch(/expected change did not happen: entry:r\/e/);
  });

  it('exits 1 when the build fails, a snapshot changed or a golden is missing', async () => {
    const build = gate({ build: 2 });
    expect(await build.exit).toBe(1);
    expect(build.calls).toHaveLength(1);

    const changed = gate({
      manifestOf: (m) => ({ ...m, snapshots: [{ ...m.snapshots[0], sha256: OTHER }] }),
    });
    expect(await changed.exit).toBe(1);
    expect(changed.calls).toHaveLength(1);
    expect(changed.lines.join('\n')).toMatch(/snapshot SHA-256 is .*, not the manifest's/);

    const missing = gate({
      manifestOf: (m) => ({
        ...m,
        snapshots: [
          {
            ...m.snapshots[0],
            cases: [
              ...m.snapshots[0].cases,
              { mode: 'every-run', golden: 'absent.json', goldenSha256: HASH },
            ],
          },
        ],
      }),
    });
    expect(await missing.exit).toBe(1);
    expect(missing.lines.join('\n')).toMatch(/golden missing: absent\.json/);

    // A golden re-recorded in place no longer matches the manifest's hash.
    const rerecorded = gate({ files: { 'scheduler-golden.json': '[{"changed":true}]' } });
    expect(await rerecorded.exit).toBe(1);
    expect(rerecorded.calls).toHaveLength(2);
    expect(rerecorded.lines.join('\n')).toMatch(
      /scheduler: UNEXPECTED golden scheduler-golden\.json SHA-256 is .*, not the manifest's/,
    );
  });

  it('fails a run that compares nothing', async () => {
    const empty = gate({ argv: ['--only', ','] });
    expect(await empty.exit).toBe(2);
    expect(empty.calls).toEqual([]);
    const withoutGolden = gate({
      argv: ['--only', '2026-01-02'],
      manifestOf: (m) => ({
        ...m,
        snapshots: [...m.snapshots, { id: '2026-01-02', withoutGolden: 'None recorded.' }],
      }),
    });
    expect(await withoutGolden.exit).toBe(1);
    expect(withoutGolden.lines.join('\n')).toMatch(/Nothing was compared/);
  });

  it('exits 2 on an invalid manifest, before building anything', async () => {
    const { exit, calls, lines } = gate({ manifestOf: (m) => ({ ...m, root: '/abs' }) });
    expect(await exit).toBe(2);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toMatch(/is not valid/);
  });
});
