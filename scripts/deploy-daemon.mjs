#!/usr/bin/env node
/**
 * Deploy the CraftingTable daemon from an exact commit (review item R-I8).
 *
 *   pnpm deploy:daemon <ref> [--yes] [--no-restart] [--when-idle | --no-drain] [--keep N]
 *   pnpm deploy:daemon --rollback [--yes] [--when-idle | --no-drain]
 *   pnpm deploy:daemon --status
 *
 * The daemon never runs from a development checkout. Each deploy builds the
 * commit into its own release directory, then atomically points `current` at it
 * and restarts the one systemd user unit whose WorkingDirectory is `current`:
 *
 *   $CRAFTINGTABLE_DEPLOY_ROOT        (default $XDG_DATA_HOME/craftingtable-deploy)
 *     repo.git/                       bare clone, fetched from the repository you run this in
 *     releases/<time>-<commit>/       one checkout + install + build per deploy
 *     current -> releases/...         what the unit runs
 *     deploys.jsonl                   append-only record of every switch
 *
 * A failed build leaves `current` untouched, and so does a release whose migrations do not
 * match the live database's ledger (R-H3): before draining or switching, the release's own
 * storage code reads the database read-only against the release's migration files. A
 * rollback is checked the same way. Before restarting, the running daemon is
 * asked to drain (R-B9) through a request file in its data directory: it stops starting
 * new work, gives live agent turns up to its drain bound to finish (`--when-idle`: waits
 * until none is live), interrupts the rest and records a clean stop, so the restarted
 * daemon resumes the interrupted steps and running roadmaps without an operator Resume.
 * Interrupting the script while it waits withdraws the request and changes nothing.
 * If the restarted daemon does not answer its health check, the previous release is
 * restored and restarted.
 * Only one daemon can use a data directory (apps/server/src/instance-lock.ts),
 * so nothing here can start a second production daemon.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HEALTH_TIMEOUT_MS = 90_000;
/** A daemon that predates drain support never answers; restart it the old way. */
const DRAIN_ACK_TIMEOUT_MS = 15_000;

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: pnpm deploy:daemon <ref> [--yes] [--no-restart] [--when-idle | --no-drain] [--keep N]\n' +
      '       pnpm deploy:daemon --rollback [--yes] [--when-idle | --no-drain]\n' +
      '       pnpm deploy:daemon --status\n',
  );
  process.exit(2);
}

export function parseArguments(argv) {
  const options = { restart: true, yes: false, keep: 5, skipBuild: false, drain: 'bounded' };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-restart') options.restart = false;
    else if (arg === '--when-idle') options.drain = 'when-idle';
    else if (arg === '--no-drain') options.drain = 'none';
    else if (arg === '--rollback') options.mode = 'rollback';
    else if (arg === '--status') options.mode = 'status';
    // Test seam: exercise release bookkeeping without installing and building.
    else if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--keep') {
      options.keep = Number(rest.shift());
      if (!Number.isInteger(options.keep) || options.keep < 2) usage('--keep needs an integer ≥ 2');
    } else if (arg.startsWith('-')) usage(`Unknown option ${arg}`);
    else if (options.ref === undefined) options.ref = arg;
    else usage(`Unexpected argument ${arg}`);
  }
  options.mode ??= 'deploy';
  if (options.mode === 'deploy' && options.ref === undefined) usage('Name the commit to deploy.');
  return options;
}

function run(command, args, cwd, inherit = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })?.trim();
}

export function deployRoot(env = process.env) {
  if (env.CRAFTINGTABLE_DEPLOY_ROOT) return resolve(env.CRAFTINGTABLE_DEPLOY_ROOT);
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'craftingtable-deploy');
}

function readLog(root) {
  const file = join(root, 'deploys.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function currentRelease(root) {
  try {
    return basename(readlinkSync(join(root, 'current')));
  } catch {
    return undefined;
  }
}

/** Point `current` at a release in one rename, so the unit never sees a half switch. */
function switchTo(root, release) {
  const next = join(root, 'current.next');
  rmSync(next, { force: true });
  symlinkSync(join('releases', release), next);
  renameSync(next, join(root, 'current'));
}

function unitName(env = process.env) {
  return env.CRAFTINGTABLE_DEPLOY_UNIT ?? 'craftingtable';
}

/** The unit's working directory must be `current`, or deploys would not take effect. */
function checkUnit(root) {
  let directory;
  try {
    directory = run('systemctl', [
      '--user',
      'show',
      unitName(),
      '-p',
      'WorkingDirectory',
      '--value',
    ]);
  } catch {
    return `Could not read the ${unitName()} unit; is it installed?`;
  }
  const expected = join(root, 'current');
  return directory === expected
    ? undefined
    : `The ${unitName()} unit runs from ${directory || '(unset)'}, not ${expected}. ` +
        `Set WorkingDirectory=${expected} in its unit file and run systemctl --user daemon-reload.`;
}

/**
 * CRAFTINGTABLE_* settings from the unit's `Environment=` lines and environment files, as
 * systemd reads them; empty when unreadable.
 */
function unitEnvironment() {
  try {
    const files = run('systemctl', [
      '--user',
      'show',
      unitName(),
      '-p',
      'EnvironmentFiles',
      '--value',
    ]);
    const inline = run('systemctl', ['--user', 'show', unitName(), '-p', 'Environment', '--value']);
    const texts = [];
    for (const listed of files.split('\n')) {
      const path = listed.replace(/\s+\(ignore_errors=\w+\)\s*$/, '').trim();
      if (path && existsSync(path)) texts.push(readFileSync(path, 'utf8'));
    }
    return unitAssignments(inline, texts);
  } catch {
    // Fall back to the defaults.
    return {};
  }
}

/**
 * The unit's settings from `systemctl show -p Environment --value` and its environment files'
 * texts: settings from the files override `Environment=` (systemd.exec), and a later file
 * overrides an earlier one. `systemctl` prints an entry holding whitespace in double quotes,
 * with C-style escapes.
 */
export function unitAssignments(inline, fileTexts) {
  const entries = [...inline.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(([, quoted, plain]) =>
    quoted === undefined ? plain : quoted.replace(/\\(.)/g, '$1'),
  );
  return Object.assign(
    environmentAssignments(entries),
    ...fileTexts.map((text) => environmentAssignments(text.split('\n'))),
  );
}

/** `CRAFTINGTABLE_*=value` assignments, with one pair of surrounding quotes removed. */
export function environmentAssignments(lines) {
  const values = {};
  for (const line of lines) {
    const match = /^\s*(CRAFTINGTABLE_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const quoted = /^(["'])(.*)\1$/.exec(match[2]);
    values[match[1]] = quoted ? quoted[2] : match[2];
  }
  return values;
}

/** The daemon's data directory, where it watches for a drain request. */
export function dataDirectory(env = process.env, unit = {}) {
  if (env.CRAFTINGTABLE_DEPLOY_DATA_DIR) return resolve(env.CRAFTINGTABLE_DEPLOY_DATA_DIR);
  const named =
    typeof unit === 'function' ? unit().CRAFTINGTABLE_DATA_DIR : unit.CRAFTINGTABLE_DATA_DIR;
  if (named) return named;
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'craftingtable');
}

/** The daemon's database in its data directory, as `apps/server/src/config.ts` places it. */
export function databasePath(directory) {
  return join(directory, 'state', 'craftingtable.sqlite');
}

/**
 * Runs in a release (R-H3): its compiled storage package reads the database read-only against
 * the release's migration files, and prints one JSON line.
 */
const PREFLIGHT = `
const [index, migrations, database] = process.argv.slice(1);
let result;
try {
  const storage = await import(index);
  try {
    const status = storage.inspectMigrationStatus(database, storage.discoverMigrations(migrations));
    result = { outcome: status.pendingVersions.length ? 'pending' : 'current', ...status };
  } catch (error) {
    if (!(error instanceof storage.MigrationValidationError)) throw error;
    result = { outcome: 'mismatch', failure: error.failure, message: error.message };
  }
} catch (error) {
  result = { outcome: 'unavailable', message: String(error?.message ?? error).slice(0, 2000) };
}
process.stdout.write(JSON.stringify(result) + '\\n');
`;
/** An answer of the check's own shape; anything else refuses (R-H3 review). */
function preflightAnswer(result) {
  if (typeof result !== 'object' || result === null) return false;
  if (result.outcome === 'current' || result.outcome === 'pending')
    return (
      Number.isInteger(result.currentVersion) &&
      Number.isInteger(result.supportedVersion) &&
      Array.isArray(result.pendingVersions) &&
      result.pendingVersions.every(Number.isInteger)
    );
  if (result.outcome === 'mismatch') return typeof result.failure === 'string';
  return result.outcome === 'unavailable';
}

/**
 * Whether a release can run on the live database (R-H3), checked before `current` moves:
 *
 * - `no-database`: nothing to check yet (a first deploy).
 * - `current` or `pending`: the ledger matches the release's migrations; the release applies
 *   any pending ones when it starts.
 * - `mismatch`: an applied migration's checksum or name differs from the release's file, or
 *   the database has a migration the release does not know (`failure` is the storage code).
 *   The release would refuse to start.
 * - `unavailable`: the release could not run the check; refused too, since it could not open
 *   the database either.
 *
 * The check is the release's own `inspectMigrationStatus`, which opens the database read-only.
 */
export function migrationPreflight(release, database) {
  if (!existsSync(database)) return { outcome: 'no-database' };
  const index = join(release, 'packages', 'storage', 'dist', 'index.js');
  const migrations = join(release, 'packages', 'storage', 'migrations');
  if (!existsSync(index) || !existsSync(migrations))
    return { outcome: 'unavailable', message: `${release} has no built storage package.` };
  const checked = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', PREFLIGHT, pathToFileURL(index).href, migrations, database],
    { cwd: release, encoding: 'utf8', timeout: 60_000 },
  );
  const line = checked.stdout?.trim().split('\n').at(-1);
  if (checked.status === 0 && line)
    try {
      const result = JSON.parse(line);
      // Only an answer of the check's own shape counts; anything else refuses (R-H3 review).
      if (preflightAnswer(result)) return result;
    } catch {
      // Reported below.
    }
  return {
    outcome: 'unavailable',
    message: (checked.stderr || checked.error?.message || `exit ${checked.status}`)
      .trim()
      .slice(0, 2000),
  };
}

/**
 * Stops a switch to `release` unless its migrations match the live database (R-H3). A refusal
 * is recorded and leaves `current`, and the daemon running it, as they are.
 */
function requireMigrationsMatch(root, release, entry, current) {
  const database = databasePath(dataDirectory(process.env, unitEnvironment));
  const result = migrationPreflight(join(root, 'releases', release), database);
  if (result.outcome === 'no-database') {
    // A first deploy has none; a wrongly found data directory would have none either, so it is
    // said rather than passed in silence (R-H3 review).
    process.stdout.write(`Migrations: no database at ${database}; nothing to check.\n`);
    return;
  }
  if (result.outcome === 'current' || result.outcome === 'pending') {
    process.stdout.write(
      `Migrations: ${database} at schema ${result.currentVersion}/${result.supportedVersion}; pending: ${result.pendingVersions.join(', ') || 'none'}\n`,
    );
    return;
  }
  record(root, {
    action: 'preflight-refused',
    ...entry,
    release,
    previous: current,
    outcome: result.outcome,
    ...(result.failure ? { failure: result.failure } : {}),
  });
  const stays = `${current ?? 'nothing'} stays deployed`;
  // An older release cannot open a database a newer one migrated: what remains is the copy the
  // daemon took before migrating.
  const snapshots =
    result.failure === 'unsupported-version'
      ? ` The database was migrated past this release; the copies taken before each migration are in ${join(dirname(database), 'pre-migration')}.`
      : '';
  throw new Error(
    (result.outcome === 'mismatch'
      ? `The live database ${database} does not match ${release}'s migrations (${result.failure}: ${result.message}); ${stays}.`
      : `${release} could not check the live database ${database} (${result.message}); ${stays}.`) +
      snapshots,
  );
}

/** Health URL from the unit's environment file, overridable for unusual setups. */
function healthUrl(env = process.env) {
  if (env.CRAFTINGTABLE_DEPLOY_HEALTH_URL) return env.CRAFTINGTABLE_DEPLOY_HEALTH_URL;
  const unit = unitEnvironment();
  let host = unit.CRAFTINGTABLE_HOST ?? '127.0.0.1';
  const port = unit.CRAFTINGTABLE_PORT ?? '4600';
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/health`;
}

async function waitHealthy(url) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return false;
}

/**
 * Asks the daemon watching `directory` to drain and waits until it has. Resolves to
 * `{ acknowledged: false }` when no daemon answers within `ackTimeoutMs`; the request is
 * then withdrawn. SIGINT, SIGHUP and SIGTERM withdraw the request too, which cancels a
 * drain that has not interrupted anything yet.
 */
export async function drainDaemon(directory, mode, options = {}) {
  const ackTimeoutMs = options.ackTimeoutMs ?? DRAIN_ACK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 1_000;
  const say = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const id = randomUUID();
  const requestPath = join(directory, 'drain-request.json');
  const statusPath = join(directory, 'drain-status.json');
  writeFileSync(`${requestPath}.partial`, `${JSON.stringify({ id, mode })}\n`, { mode: 0o600 });
  renameSync(`${requestPath}.partial`, requestPath);
  const withdraw = () => {
    rmSync(requestPath, { force: true });
    process.stderr.write(
      '\nDrain request withdrawn. The daemon resumes admissions, unless it had already ' +
        'interrupted live runs; then it restarts itself within two minutes and resumes them.\n',
    );
    process.exit(130);
  };
  // A closed terminal or a stopped deploy must not leave a request behind either.
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.once(signal, withdraw);
  try {
    const ackDeadline = Date.now() + ackTimeoutMs;
    let reported;
    for (;;) {
      let status;
      try {
        status = JSON.parse(readFileSync(statusPath, 'utf8'));
      } catch {
        status = undefined;
      }
      if (status?.requestId === id) {
        if (status.state === 'drained') return { acknowledged: true, ...status };
        if (status.state === 'failed')
          throw new Error(`The daemon could not drain: ${status.message ?? 'unknown error'}`);
        if (status.busyRuns !== reported) {
          say(`Draining: ${status.busyRuns} live agent turn(s) still working…`);
          reported = status.busyRuns;
        }
      } else if (Date.now() > ackDeadline) {
        rmSync(requestPath, { force: true });
        return { acknowledged: false };
      }
      await new Promise((done) => setTimeout(done, pollMs));
    }
  } finally {
    for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.off(signal, withdraw);
  }
}

function unitActive() {
  try {
    return run('systemctl', ['--user', 'is-active', unitName()]) === 'active';
  } catch {
    return false;
  }
}

async function drainBeforeRestart(options) {
  if (options.drain === 'none' || !unitActive()) return;
  const directory = dataDirectory(process.env, unitEnvironment);
  process.stdout.write(
    options.drain === 'when-idle'
      ? `Asking the daemon to finish live agent turns before restarting (no new steps start meanwhile)…\n`
      : `Asking the daemon to drain; live turns get up to its drain bound to finish…\n`,
  );
  const result = await drainDaemon(directory, options.drain);
  process.stdout.write(
    result.acknowledged
      ? `Drained. ${result.interruptedRuns ?? 0} interrupted run(s) resume their sessions after the restart.\n`
      : `The running daemon did not answer the drain request (it predates drain support, or its data directory is not ${directory}).\n` +
          '  Restarting anyway: live agent runs are interrupted and running roadmaps wait for Resume.\n',
  );
}

async function restartAndCheck() {
  process.stdout.write(`Restarting ${unitName()}…\n`);
  run('systemctl', ['--user', 'restart', unitName()], undefined, true);
  const url = healthUrl();
  const healthy = await waitHealthy(url);
  process.stdout.write(healthy ? `Healthy at ${url}\n` : `No healthy answer from ${url}\n`);
  return healthy;
}

async function confirm(options, message) {
  if (options.yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(`${message}\nRe-run with --yes to proceed without a prompt.\n`);
    return false;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${message}\nProceed? [y/N] `);
  prompt.close();
  return /^y(es)?$/i.test(answer.trim());
}

function record(root, entry) {
  appendFileSync(
    join(root, 'deploys.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
}

function prune(root, keep) {
  const releases = readdirSync(join(root, 'releases')).sort();
  const current = currentRelease(root);
  const log = readLog(root);
  const previous = log.at(-1)?.previous;
  const removable = releases.filter((r) => r !== current && r !== previous);
  for (const release of removable.slice(0, Math.max(0, releases.length - keep))) {
    run('git', [
      '-C',
      join(root, 'repo.git'),
      'worktree',
      'remove',
      '--force',
      join(root, 'releases', release),
    ]);
  }
  run('git', ['-C', join(root, 'repo.git'), 'worktree', 'prune']);
}

async function deploy(options) {
  const root = deployRoot();
  const source = run('git', ['rev-parse', '--show-toplevel']);
  const commit = run('git', ['-C', source, 'rev-parse', '--verify', `${options.ref}^{commit}`]);
  const subject = run('git', ['-C', source, 'log', '-1', '--format=%h %s', commit]);
  const dirty = run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no']);
  mkdirSync(join(root, 'releases'), { recursive: true });
  const repo = join(root, 'repo.git');
  if (!existsSync(repo)) run('git', ['clone', '--quiet', '--bare', source, repo]);
  run('git', [
    '-C',
    repo,
    'fetch',
    '--quiet',
    '--prune',
    source,
    '+refs/heads/*:refs/heads/*',
    '+refs/tags/*:refs/tags/*',
  ]);
  try {
    run('git', ['-C', repo, 'cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new Error(
      `${options.ref} (${commit}) is not reachable from a branch or tag of ${source}.`,
    );
  }
  const current = currentRelease(root);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const release = `${stamp}-${commit.slice(0, 12)}`;
  const unitProblem = options.restart ? checkUnit(root) : undefined;
  const summary =
    `Deploy ${subject}\n  from ${source}${dirty ? ' (uncommitted changes there are not deployed)' : ''}\n` +
    `  into ${join(root, 'releases', release)}\n` +
    `  replacing ${current ?? '(nothing deployed yet)'}\n` +
    (!options.restart
      ? '  without restarting (the next restart picks it up).'
      : options.drain === 'none'
        ? '  then restart the daemon without draining: live agent runs are interrupted and running roadmaps wait for Resume.'
        : options.drain === 'when-idle'
          ? '  then wait until no agent turn is live (starting no new steps) and restart the daemon; roadmaps continue.'
          : '  then drain and restart the daemon: live turns get up to its drain bound, interrupted steps resume their sessions, roadmaps continue.');
  if (unitProblem) throw new Error(unitProblem);
  if (!(await confirm(options, summary))) return 1;

  const directory = join(root, 'releases', release);
  run('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', directory, commit]);
  if (!options.skipBuild) {
    try {
      run('pnpm', ['install', '--frozen-lockfile'], directory, true);
      run('pnpm', ['build'], directory, true);
    } catch (error) {
      run('git', ['-C', repo, 'worktree', 'remove', '--force', directory]);
      throw new Error(`Build failed; ${current ?? 'nothing'} stays deployed. ${error.message}`);
    }
  }
  try {
    requireMigrationsMatch(root, release, { commit, ref: options.ref, source }, current);
  } catch (error) {
    run('git', ['-C', repo, 'worktree', 'remove', '--force', directory]);
    throw error;
  }
  if (options.restart) await drainBeforeRestart(options);
  switchTo(root, release);
  record(root, { action: 'deploy', commit, ref: options.ref, source, release, previous: current });
  process.stdout.write(`current -> releases/${release}\n`);
  if (options.restart && !(await restartAndCheck())) {
    if (current === undefined)
      throw new Error(
        'The first deploy is not healthy; inspect journalctl --user -u craftingtable.',
      );
    // The new release may have migrated the database before failing its health check; the
    // release it replaced might then be unable to open it (R-H3 review). If so, the new release
    // stays, and the operator decides.
    try {
      requireMigrationsMatch(root, current, { automatic: true }, release);
    } catch (error) {
      throw new Error(
        `The new release did not become healthy, and the automatic rollback was refused: ${error.message} Inspect journalctl --user -u craftingtable.`,
      );
    }
    switchTo(root, current);
    record(root, { action: 'automatic-rollback', release: current, previous: release });
    const recovered = await restartAndCheck();
    throw new Error(
      `The new release did not become healthy; rolled back to ${current}` +
        (recovered
          ? '.'
          : ', which is not answering either. Inspect journalctl --user -u craftingtable.'),
    );
  }
  prune(root, options.keep);
  return 0;
}

async function rollback(options) {
  const root = deployRoot();
  const current = currentRelease(root);
  const log = readLog(root);
  const target = [...log]
    .reverse()
    .map((entry) => entry.previous)
    .find(
      (release) => release && release !== current && existsSync(join(root, 'releases', release)),
    );
  if (!target) throw new Error('There is no earlier release on disk to roll back to.');
  const problem = options.restart ? checkUnit(root) : undefined;
  if (problem) throw new Error(problem);
  const restart = options.restart ? ' and restart the daemon' : '';
  if (!(await confirm(options, `Roll back from ${current} to ${target}${restart}.`))) return 1;
  requireMigrationsMatch(root, target, { rollback: true }, current);
  if (options.restart) await drainBeforeRestart(options);
  switchTo(root, target);
  record(root, { action: 'rollback', release: target, previous: current });
  process.stdout.write(`current -> releases/${target}\n`);
  if (!options.restart) return 0;
  return (await restartAndCheck()) ? 0 : 1;
}

function status() {
  const root = deployRoot();
  process.stdout.write(`Deploy root: ${root}\nCurrent: ${currentRelease(root) ?? '(none)'}\n`);
  for (const entry of readLog(root).slice(-8))
    process.stdout.write(
      `  ${entry.at}  ${entry.action.padEnd(19)} ${entry.release}${entry.ref ? `  (${entry.ref})` : ''}\n`,
    );
  const problem = checkUnit(root);
  if (problem) process.stdout.write(`\n${problem}\n`);
  const advice = stopAdvice();
  if (advice) process.stdout.write(`\n${advice}\n`);
  return 0;
}

/** The drop-in that lets a plain `systemctl stop`, restart or reboot drain (R-B9). */
export const DRAIN_DROP_IN = `[Service]
# Run node itself so SIGTERM reaches the daemon, not a pnpm wrapper.
ExecStart=
ExecStart=/usr/bin/env node apps/server/dist/index.js
# Signal only the daemon; it drains and ends its agents itself.
KillMode=mixed
# Above the drain bound (CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS, default 180) plus shutdown.
TimeoutStopSec=300
`;

/**
 * What keeps a stop outside `pnpm deploy:daemon` from draining, for the unit's current
 * settings: a wrapper that may not forward SIGTERM, a kill mode that signals the agents
 * directly, or a stop timeout shorter than the drain bound.
 */
export function unitStopProblems({ killMode, timeoutStop, execStart, drainSeconds = 180 }) {
  const problems = [];
  if (/\bpnpm\b/.test(execStart ?? ''))
    problems.push('ExecStart runs pnpm, which may not forward SIGTERM');
  if (killMode !== 'mixed')
    problems.push(`KillMode=${killMode || 'control-group'} signals the agents directly`);
  const seconds = timeSpanSeconds(timeoutStop);
  if (seconds < drainSeconds + 30)
    problems.push(
      `TimeoutStopSec=${timeoutStop || 'unknown'} is below the ${drainSeconds} s drain bound plus shutdown`,
    );
  return problems;
}

/** Seconds in a systemd time span as `systemctl show` prints it ("30s", "5min", "1min 30s"). */
export function timeSpanSeconds(span) {
  if (span === 'infinity') return Number.POSITIVE_INFINITY;
  const units = { us: 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600 };
  let total = 0;
  let matched = false;
  for (const [, value, unit] of String(span ?? '').matchAll(
    /(\d+(?:\.\d+)?)\s*(us|ms|min|s|h)\b/g,
  )) {
    total += Number(value) * units[unit];
    matched = true;
  }
  return matched ? total : 0;
}

/**
 * Deploys drain through the request file. A plain `systemctl stop` or a reboot drains
 * only when systemd signals the daemon alone and waits long enough for it.
 */
function stopAdvice() {
  try {
    const show = (property) =>
      run('systemctl', ['--user', 'show', unitName(), '-p', property, '--value']);
    const drainSeconds = Number(unitEnvironment().CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS ?? 180);
    const problems = unitStopProblems({
      killMode: show('KillMode'),
      timeoutStop: show('TimeoutStopUSec'),
      execStart: show('ExecStart'),
      drainSeconds,
    });
    if (problems.length === 0) return undefined;
    return (
      `Note: a plain systemctl stop, restart or reboot of ${unitName()} cannot drain live agents ` +
      `(${problems.join('; ')}). Deploys still drain through their request file. To drain on ` +
      `every stop, add ~/.config/systemd/user/${unitName().replace(/\.service$/, '')}.service.d/drain.conf:\n\n${DRAIN_DROP_IN}\n` +
      'then run systemctl --user daemon-reload. It takes effect at the next restart; apply it ' +
      'with a deploy of a release that has drain support.'
    );
  } catch {
    return undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  try {
    const code =
      options.mode === 'status'
        ? status()
        : options.mode === 'rollback'
          ? await rollback(options)
          : await deploy(options);
    process.exit(code);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
