#!/usr/bin/env node
/**
 * The replay gate (R-I10, TS-M12): replays every recorded live snapshot against its goldens
 * from this checkout and fails on any difference the manifest does not expect.
 *
 *   pnpm replays [--manifest <file>] [--out <dir>] [--only <snapshot-id>[,<id>...]]
 *
 * The manifest (`scripts/replays.manifest.json`) names each snapshot directory and golden by
 * a path relative to `$XDG_DATA_HOME` (default `~/.local/share`): the snapshots hold real plans
 * and agent output and never enter the repository. For each snapshot the gate:
 *
 *   1. copies it and its goldens into a private temporary directory and checks each copy's
 *      SHA-256 against the manifest, so the corpus itself is never opened and a re-recorded
 *      golden is a manifest change;
 *   2. runs `pnpm controller:replay <copy> [--every-run | --scheduler | --evidence-view]
 *      --check <golden> --report <file>` for each of its cases;
 *   3. matches each changed record against the case's expected changes, by record key and
 *      the SHA-256 of the record's new canonical value, each with its reason.
 *
 * The manifest's `schedulerFormat` is the oldest scheduler golden format it accepts: while it is
 * 1, format-1 goldens pass without their command arguments compared, and the summary says so;
 * at 2, a format-1 golden fails. A directory under the root that the manifest neither lists nor
 * `ignored` fails the run, so a new snapshot cannot sit there unreplayed.
 *
 * It first runs `tsc -b`, because the workspace packages resolve to their compiled `dist`
 * (TS-H6): without a build, "0 changed" could describe stale code. It exits 0 only when every
 * case ran, every change was expected, no record went missing and every expected change
 * happened; 1 otherwise; 2 on a usage or manifest error. Each case's output and report are kept
 * in the output directory, which the summary names.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, 'scripts', 'replays.manifest.json');

/** Each case's mode and the `controller:replay` flag that selects it. */
export const MODES = {
  golden: [],
  'every-run': ['--every-run'],
  scheduler: ['--scheduler'],
  'evidence-view': ['--evidence-view'],
};

/**
 * Scheduler golden formats (`SchedulerReplay.format`): 2 records command arguments and attention
 * kinds and actions. The manifest's `schedulerFormat` is the oldest the gate accepts.
 */
const SCHEDULER_FORMATS = [1, 2];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const keysOutside = (value, allowed) => Object.keys(value).filter((key) => !allowed.includes(key));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Every problem with a manifest, or none. Paths must be relative and stay inside
 * `$XDG_DATA_HOME`, so the manifest holds no machine-specific path.
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ['The manifest must be a JSON object.'];
  for (const key of keysOutside(manifest, [
    'description',
    'root',
    'schedulerFormat',
    'ignored',
    'snapshots',
  ]))
    errors.push(`Unknown manifest field "${key}".`);
  if (!SCHEDULER_FORMATS.includes(manifest.schedulerFormat))
    errors.push(
      `"schedulerFormat" must be ${SCHEDULER_FORMATS.join(' or ')}: the scheduler golden format the gate requires.`,
    );
  const ignored = manifest.ignored ?? [];
  if (
    !Array.isArray(ignored) ||
    ignored.some(
      (entry) =>
        !isObject(entry) ||
        keysOutside(entry, ['id', 'reason']).length > 0 ||
        !isText(entry.id) ||
        !NAME.test(entry.id) ||
        !isText(entry.reason),
    )
  )
    errors.push('"ignored" must list directories as { "id", "reason" }.');
  const root = manifest.root;
  if (
    !isText(root) ||
    isAbsolute(root) ||
    root.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === '')
  )
    errors.push('"root" must be a relative path inside $XDG_DATA_HOME, without "." or "..".');
  if (!Array.isArray(manifest.snapshots) || manifest.snapshots.length === 0) {
    errors.push('"snapshots" must be a non-empty list.');
    return errors;
  }
  const ids = new Set();
  manifest.snapshots.forEach((snapshot, index) => {
    const where = `snapshots[${index}]`;
    if (!isObject(snapshot)) {
      errors.push(`${where} must be an object.`);
      return;
    }
    const at = isText(snapshot.id) ? `snapshot ${snapshot.id}` : where;
    for (const key of keysOutside(snapshot, ['id', 'sha256', 'cases', 'withoutGolden', 'note']))
      errors.push(`${at}: unknown field "${key}".`);
    if (!isText(snapshot.id) || !NAME.test(snapshot.id))
      errors.push(`${where}: "id" must be a directory name (letters, digits, ".", "_", "-").`);
    else if (ids.has(snapshot.id)) errors.push(`${at}: listed twice.`);
    else ids.add(snapshot.id);
    if (snapshot.note !== undefined && !isText(snapshot.note))
      errors.push(`${at}: "note" must be text.`);
    if (snapshot.withoutGolden !== undefined) {
      if (!isText(snapshot.withoutGolden))
        errors.push(`${at}: "withoutGolden" must say why the snapshot has no golden.`);
      if (snapshot.cases !== undefined || snapshot.sha256 !== undefined)
        errors.push(`${at}: a snapshot without a golden has no cases and no "sha256".`);
      return;
    }
    if (!isText(snapshot.sha256) || !SHA256.test(snapshot.sha256))
      errors.push(`${at}: "sha256" must be the snapshot's SHA-256 (64 hex digits).`);
    if (!Array.isArray(snapshot.cases) || snapshot.cases.length === 0) {
      errors.push(`${at}: "cases" must be a non-empty list, or "withoutGolden" must say why not.`);
      return;
    }
    const modes = new Set();
    snapshot.cases.forEach((replayCase, caseIndex) => {
      const caseAt = `${at} cases[${caseIndex}]`;
      if (!isObject(replayCase)) {
        errors.push(`${caseAt} must be an object.`);
        return;
      }
      for (const key of keysOutside(replayCase, ['mode', 'golden', 'goldenSha256', 'expected']))
        errors.push(`${caseAt}: unknown field "${key}".`);
      if (!isText(replayCase.goldenSha256) || !SHA256.test(replayCase.goldenSha256))
        errors.push(`${caseAt}: "goldenSha256" must be the golden's SHA-256 (64 hex digits).`);
      if (!Object.hasOwn(MODES, replayCase.mode))
        errors.push(`${caseAt}: "mode" must be one of ${Object.keys(MODES).join(', ')}.`);
      else if (modes.has(replayCase.mode))
        errors.push(`${caseAt}: mode ${replayCase.mode} is listed twice.`);
      else modes.add(replayCase.mode);
      if (
        !isText(replayCase.golden) ||
        !NAME.test(replayCase.golden) ||
        !replayCase.golden.endsWith('.json')
      )
        errors.push(`${caseAt}: "golden" must be a .json file name in the snapshot's directory.`);
      if (replayCase.expected === undefined) return;
      if (!Array.isArray(replayCase.expected)) {
        errors.push(`${caseAt}: "expected" must be a list.`);
        return;
      }
      const keys = new Set();
      replayCase.expected.forEach((change, changeIndex) => {
        const changeAt = `${caseAt} expected[${changeIndex}]`;
        if (!isObject(change)) {
          errors.push(`${changeAt} must be an object.`);
          return;
        }
        for (const key of keysOutside(change, ['key', 'nowSha256', 'reason']))
          errors.push(`${changeAt}: unknown field "${key}".`);
        if (!isText(change.key)) errors.push(`${changeAt}: "key" must name the changed record.`);
        else if (keys.has(change.key)) errors.push(`${changeAt}: key ${change.key} listed twice.`);
        else keys.add(change.key);
        if (!isText(change.nowSha256) || !SHA256.test(change.nowSha256))
          errors.push(`${changeAt}: "nowSha256" must be the SHA-256 of the record's new value.`);
        if (!isText(change.reason)) errors.push(`${changeAt}: "reason" must say why it changed.`);
      });
    });
  });
  return errors;
}

/**
 * Sorts a check report's differences against a case's expected changes. A change is expected
 * only when both its key and the SHA-256 of its new value match: a further change to an
 * expected record is unexpected. Every missing record is unexpected, and so is an expected
 * change that did not happen (the manifest is then out of date).
 */
export function matchExpected(report, expected = []) {
  const byKey = new Map(expected.map((change) => [change.key, change]));
  const seen = new Set();
  const matched = [];
  const unexpected = [];
  for (const change of report.changed) {
    // Each expected change matches once: a key reported twice is a second difference.
    const wanted = seen.has(change.key) ? undefined : byKey.get(change.key);
    if (wanted && wanted.nowSha256 === change.nowSha256) {
      seen.add(change.key);
      matched.push(change.key);
    } else
      unexpected.push(
        wanted
          ? `changed ${change.key} to a value other than the expected one (now ${change.nowSha256})`
          : `changed ${change.key} (now ${change.nowSha256})`,
      );
  }
  for (const key of report.missing) unexpected.push(`missing ${key}`);
  // A record that changed to another value is reported once, above.
  const reported = new Set(report.changed.map((change) => change.key));
  const absent = expected
    .filter((change) => !reported.has(change.key))
    .map((change) => `expected change did not happen: ${change.key} (${change.reason})`);
  return { matched, unexpected: [...unexpected, ...absent] };
}

/**
 * One case's row in the summary, from how its replay exited and what it reported. A scheduler
 * case also checks its golden's format against the manifest's `schedulerFormat`.
 */
export function classifyCase({ status, signal, report, expected, mode, schedulerFormat = 1 }) {
  if (signal) return { ok: false, problems: [`replay ended by signal ${signal}`] };
  if (status === 2) return { ok: false, problems: ['replay usage error (exit 2)'] };
  if (status !== 0 && status !== 1)
    return { ok: false, problems: [`replay failed (exit ${status ?? 'unknown'})`] };
  if (
    !isObject(report) ||
    !Array.isArray(report.changed) ||
    !Array.isArray(report.missing) ||
    !Array.isArray(report.duplicates)
  )
    return { ok: false, problems: ['replay wrote no check report'] };
  const { matched, unexpected } = matchExpected(report, expected);
  const differs =
    report.changed.length > 0 || report.missing.length > 0 || report.duplicates.length > 0;
  const problems = [...unexpected, ...report.duplicates.map((key) => `duplicate key: ${key}`)];
  if (differs !== (status === 1)) problems.push(`replay exit ${status} disagrees with its report`);
  // Both sides empty would compare nothing and pass.
  if (!(report.records > 0)) problems.push('the replay compared no records');
  let goldenFormat;
  if (mode === 'scheduler') {
    goldenFormat = report.goldenFormat;
    if (!Number.isInteger(goldenFormat))
      problems.push('the scheduler report does not say its golden format');
    else if (goldenFormat < schedulerFormat)
      problems.push(
        `the scheduler golden is format ${goldenFormat}; the manifest requires format ${schedulerFormat}`,
      );
  }
  return {
    ok: problems.length === 0,
    records: report.records,
    changed: report.changed.length,
    missing: report.missing.length,
    expected: matched.length,
    notCompared: report.notCompared ?? [],
    ...(goldenFormat === undefined ? {} : { goldenFormat }),
    problems,
  };
}

/** The summary table, one row per case. */
export function formatTable(rows) {
  const header = [
    'snapshot',
    'mode',
    'records',
    'changed',
    'missing',
    'expected',
    'unexpected',
    'result',
    'seconds',
  ];
  const lines = rows.map((row) => [
    row.snapshot,
    row.mode,
    String(row.records ?? '-'),
    String(row.changed ?? '-'),
    String(row.missing ?? '-'),
    String(row.expected ?? '-'),
    String(row.problems?.length ?? 0),
    row.ok ? 'ok' : 'FAIL',
    row.seconds === undefined ? '-' : row.seconds.toFixed(1),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((line) => line[i].length)));
  const format = (cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [format(header), format(widths.map((w) => '-'.repeat(w))), ...lines.map(format)].join(
    '\n',
  );
}

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')));
  });
}

/** Runs one command with an argument array, its output to `outFile`. */
function runCommand(command, args, { cwd, outFile }) {
  const fd = outFile ? openSync(outFile, 'w', 0o600) : undefined;
  try {
    const result = spawnSync(command, args, {
      cwd,
      stdio: ['ignore', fd ?? 'inherit', fd ?? 'inherit'],
    });
    return { status: result.status, signal: result.signal, error: result.error };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST, out: undefined, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--manifest', '--out', '--only'].includes(flag) || value === undefined)
      return { error: `Unknown or incomplete option "${flag}".` };
    i++;
    if (flag === '--manifest') options.manifest = resolve(value);
    else if (flag === '--out') options.out = resolve(value);
    else options.only = new Set(value.split(',').filter(Boolean));
  }
  if (options.only?.size === 0) return { error: '--only names no snapshot.' };
  return { options };
}

/**
 * Directories under the corpus root that the manifest neither replays, lists without a golden,
 * nor ignores with a reason: each is a problem, so a new snapshot cannot sit there unreplayed.
 */
export function unlistedDirectories(corpus, manifest) {
  let entries;
  try {
    entries = readdirSync(corpus, { withFileTypes: true });
  } catch (error) {
    return [`cannot list the corpus ${corpus}: ${error.code ?? error.message}`];
  }
  const named = new Set([
    ...manifest.snapshots.map((snapshot) => snapshot.id),
    ...(manifest.ignored ?? []).map((entry) => entry.id),
  ]);
  return entries
    .filter((entry) => entry.isDirectory() && !named.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => `snapshot directory ${name} is not in the manifest (list it, or ignore it)`);
}

/** The commit the gate replays, and whether the checkout has changes beyond it. */
function describeCheckout() {
  const git = (args) =>
    spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).stdout?.trim() ?? '';
  const head = git(['rev-parse', '--short=12', 'HEAD']) || 'unknown';
  const changed = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
  return changed ? `${head} (dirty: ${changed} changed paths)` : `${head} (clean)`;
}

/** `$XDG_DATA_HOME`, or its default when unset or not absolute (as the XDG spec says). */
export function dataHome(env) {
  const configured = env.XDG_DATA_HOME;
  return configured && isAbsolute(configured)
    ? configured
    : join(env.HOME || homedir(), '.local', 'share');
}

/**
 * Runs the gate and returns its exit code. `run` spawns a command (argument array, never a
 * shell string); tests replace it.
 */
export async function main(
  argv,
  { env = process.env, run = runCommand, log = (line) => process.stdout.write(`${line}\n`) } = {},
) {
  const started = Date.now();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    log(`${parsed.error}\nUsage: pnpm replays [--manifest <file>] [--out <dir>] [--only <id,...>]`);
    return 2;
  }
  const { options } = parsed;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  } catch (error) {
    log(`Cannot read the manifest ${options.manifest}: ${error.message}`);
    return 2;
  }
  const errors = validateManifest(manifest);
  if (errors.length) {
    log(`The manifest ${options.manifest} is not valid:\n  ${errors.join('\n  ')}`);
    return 2;
  }
  const snapshots = manifest.snapshots.filter((s) => !options.only || options.only.has(s.id));
  if (options.only) {
    const unknown = [...options.only].filter((id) => !manifest.snapshots.some((s) => s.id === id));
    if (unknown.length) {
      log(`--only names snapshots the manifest does not list: ${unknown.join(', ')}`);
      return 2;
    }
  }
  const corpus = join(dataHome(env), manifest.root);
  const out = options.out ?? mkdtempSync(join(tmpdir(), 'craftingtable-replays-'));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const checkout = describeCheckout();
  log(`Commit: ${checkout}`);
  log(
    `Replay corpus: ${corpus}${dataHome(env) === env.XDG_DATA_HOME ? ' ($XDG_DATA_HOME)' : ' (default data home)'}`,
  );
  log(`Output: ${out}`);

  // The packages resolve to their compiled output: build first, or the replay runs stale code.
  log('Building (tsc -b)...');
  const build = run('pnpm', ['exec', 'tsc', '-b'], {
    cwd: REPOSITORY_ROOT,
    outFile: join(out, 'build.txt'),
  });
  if (build.error || build.signal || build.status !== 0) {
    log(`tsc -b failed; see ${join(out, 'build.txt')}`);
    return 1;
  }

  const rows = [];
  const skipped = [];
  for (const snapshot of snapshots) {
    const directory = join(corpus, snapshot.id);
    if (snapshot.withoutGolden) {
      skipped.push(`${snapshot.id}: ${snapshot.withoutGolden}`);
      continue;
    }
    const source = join(directory, 'snapshot.sqlite');
    const fail = (problem) =>
      snapshot.cases.map((c) => ({
        snapshot: snapshot.id,
        mode: c.mode,
        ok: false,
        problems: [problem],
      }));
    if (!existsSync(source)) {
      rows.push(...fail(`snapshot missing: $XDG_DATA_HOME/${manifest.root}/${snapshot.id}`));
      continue;
    }
    // A private copy: the corpus is only ever read by this copy.
    const scratch = mkdtempSync(join(tmpdir(), 'craftingtable-replays-snapshot-'));
    try {
      const copy = join(scratch, 'snapshot.sqlite');
      copyFileSync(source, copy);
      chmodSync(copy, 0o600);
      const digest = await sha256File(copy);
      if (digest !== snapshot.sha256) {
        rows.push(...fail(`snapshot SHA-256 is ${digest}, not the manifest's`));
        continue;
      }
      for (const replayCase of snapshot.cases) {
        const name = `${snapshot.id}-${replayCase.mode}`;
        const row = { snapshot: snapshot.id, mode: replayCase.mode };
        if (!existsSync(join(directory, replayCase.golden))) {
          rows.push({ ...row, ok: false, problems: [`golden missing: ${replayCase.golden}`] });
          continue;
        }
        // The golden is pinned too: a re-recorded golden is a manifest change, not a silent one.
        const golden = join(scratch, replayCase.golden);
        copyFileSync(join(directory, replayCase.golden), golden);
        const goldenDigest = await sha256File(golden);
        if (goldenDigest !== replayCase.goldenSha256) {
          rows.push({
            ...row,
            ok: false,
            problems: [
              `golden ${replayCase.golden} SHA-256 is ${goldenDigest}, not the manifest's`,
            ],
          });
          continue;
        }
        const reportFile = join(out, `${name}.report.json`);
        rmSync(reportFile, { force: true });
        const caseStarted = Date.now();
        log(`== ${snapshot.id} ${replayCase.mode}`);
        const result = run(
          'pnpm',
          [
            '-s',
            'controller:replay',
            copy,
            ...MODES[replayCase.mode],
            '--check',
            golden,
            '--report',
            reportFile,
          ],
          { cwd: REPOSITORY_ROOT, outFile: join(out, `${name}.txt`) },
        );
        let report;
        try {
          report = JSON.parse(readFileSync(reportFile, 'utf8'));
        } catch {
          report = undefined;
        }
        rows.push({
          ...row,
          seconds: (Date.now() - caseStarted) / 1000,
          ...classifyCase({
            status: result.error ? undefined : result.status,
            signal: result.signal,
            report,
            expected: replayCase.expected ?? [],
            mode: replayCase.mode,
            schedulerFormat: manifest.schedulerFormat,
          }),
        });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  log('');
  log(formatTable(rows));
  for (const row of rows) {
    for (const part of row.notCompared ?? [])
      log(`${row.snapshot} ${row.mode}: not compared: ${part}`);
    for (const problem of row.problems ?? [])
      log(`${row.snapshot} ${row.mode}: UNEXPECTED ${problem}`);
  }
  for (const line of skipped) log(`not replayed (no golden): ${line}`);
  for (const entry of manifest.ignored ?? [])
    log(`ignored directory: ${entry.id}: ${entry.reason}`);
  // A snapshot directory the manifest does not name would otherwise go unreplayed unseen.
  const unlisted = unlistedDirectories(corpus, manifest);
  for (const problem of unlisted) log(`UNEXPECTED ${problem}`);
  const older = rows.filter((row) => row.goldenFormat !== undefined && row.goldenFormat < 2);
  if (older.length)
    log(
      `\ncommand arguments NOT compared: ${older.length} scheduler goldens predate them (format 1). Operator: install format-2 goldens and set "schedulerFormat": 2 in the manifest.\n`,
    );
  const clean = rows.filter((row) => row.ok && row.changed === 0 && row.missing === 0).length;
  const failed = rows.filter((row) => !row.ok).length;
  log(
    `${clean} of ${rows.length} comparisons report 0 changed; ${rows.length - clean - failed} differ only as expected; ${failed} failed. ${((Date.now() - started) / 1000).toFixed(0)} s. Commit: ${checkout}. Output: ${out}`,
  );
  if (rows.length === 0) {
    log('Nothing was compared: the selected snapshots have no goldens.');
    return 1;
  }
  if (unlisted.length) return 1;
  return failed ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
