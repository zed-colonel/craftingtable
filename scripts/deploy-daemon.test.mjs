import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverMigrations, openDatabase, runMigrations } from '@craftingtable/storage';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  dataDirectory,
  drainDaemon,
  migrationPreflight,
  timeSpanSeconds,
  unitStopProblems,
} from './deploy-daemon.mjs';

const SCRIPT = fileURLToPath(new URL('./deploy-daemon.mjs', import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function sourceRepository() {
  const path = scratch('craftingtable-deploy-source-');
  git(['init', '--quiet', '--initial-branch=main', '.'], path);
  const commits = [];
  for (const version of ['one', 'two', 'three']) {
    writeFileSync(join(path, 'VERSION'), `${version}\n`);
    git(['add', 'VERSION'], path);
    git(['commit', '--quiet', '--no-gpg-sign', '-m', version], path);
    commits.push(git(['rev-parse', 'HEAD'], path));
  }
  return { path, commits };
}

/**
 * Runs the real script against a scratch deploy root, with building and restarting disabled. Its
 * data directory is always a scratch one, never the operator's: without a database there, the
 * migration preflight has nothing to check (R-H3).
 */
function deploy(source, root, args, data = scratch('craftingtable-deploy-data-')) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--yes', '--no-restart', '--skip-build'], {
    cwd: source,
    env: { ...GIT_ENV, CRAFTINGTABLE_DEPLOY_ROOT: root, CRAFTINGTABLE_DEPLOY_DATA_DIR: data },
    encoding: 'utf8',
  });
}

const current = (root) => readlinkSync(join(root, 'current'));
const deployedVersion = (root) => readFileSync(join(root, 'current', 'VERSION'), 'utf8').trim();
const log = (root) =>
  readFileSync(join(root, 'deploys.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('deploy:daemon', () => {
  it('builds each commit into its own release and points current at it', () => {
    const { path, commits } = sourceRepository();
    const root = scratch('craftingtable-deploy-root-');
    const first = deploy(path, root, [commits[0]]);
    expect(first.status, first.stderr).toBe(0);
    expect(deployedVersion(root)).toBe('one');
    const second = deploy(path, root, ['main']);
    expect(second.status, second.stderr).toBe(0);
    expect(deployedVersion(root)).toBe('three');
    expect(current(root)).toMatch(
      new RegExp(`^releases/\\d{8}T\\d{6}Z-${commits[2].slice(0, 12)}$`),
    );
    const [firstEntry, secondEntry] = log(root);
    expect(secondEntry).toMatchObject({ action: 'deploy', commit: commits[2], ref: 'main' });
    expect(secondEntry.previous).toBe(firstEntry.release);
  });

  it('rolls back to the previous release without rebuilding', () => {
    const { path, commits } = sourceRepository();
    const root = scratch('craftingtable-deploy-root-');
    expect(deploy(path, root, [commits[0]]).status).toBe(0);
    expect(deploy(path, root, [commits[1]]).status).toBe(0);
    const rollback = deploy(path, root, ['--rollback']);
    expect(rollback.status, rollback.stderr).toBe(0);
    expect(deployedVersion(root)).toBe('one');
    expect(log(root).at(-1)).toMatchObject({ action: 'rollback' });
  });

  it('keeps only the newest releases, never the current or previous one', () => {
    const { path, commits } = sourceRepository();
    const root = scratch('craftingtable-deploy-root-');
    for (const commit of [...commits, commits[0], commits[1]])
      expect(deploy(path, root, [commit, '--keep', '2']).status).toBe(0);
    const releases = readdirSync(join(root, 'releases'));
    expect(releases).toHaveLength(2);
    expect(releases).toContain(current(root).replace('releases/', ''));
    expect(releases).toContain(log(root).at(-1).previous);
  });

  it('refuses a ref that does not name a commit and leaves current alone', () => {
    const { path, commits } = sourceRepository();
    const root = scratch('craftingtable-deploy-root-');
    expect(deploy(path, root, [commits[0]]).status).toBe(0);
    const bad = deploy(path, root, ['no-such-ref']);
    expect(bad.status).not.toBe(0);
    expect(deployedVersion(root)).toBe('one');
  });

  it('asks for confirmation when not given --yes and no terminal is attached', () => {
    const { path } = sourceRepository();
    const root = scratch('craftingtable-deploy-root-');
    const result = spawnSync(process.execPath, [SCRIPT, 'main', '--no-restart', '--skip-build'], {
      cwd: path,
      env: {
        ...GIT_ENV,
        CRAFTINGTABLE_DEPLOY_ROOT: root,
        CRAFTINGTABLE_DEPLOY_DATA_DIR: scratch('craftingtable-deploy-data-'),
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Re-run with --yes');
    expect(readdirSync(root)).not.toContain('current');
  });
});

/**
 * The migration preflight (R-H3), on fixture databases only. A release here is what the
 * preflight reads of one: the storage package's build (this checkout's, re-exported) and the
 * release's own migration files, which a test may change.
 */
describe('deploy:daemon migration preflight (R-H3)', () => {
  const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
  const STORAGE_BUILD = join(REPOSITORY, 'packages', 'storage', 'dist', 'index.js');
  const MIGRATIONS = join(REPOSITORY, 'packages', 'storage', 'migrations');
  const versions = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  beforeAll(() => {
    // The preflight runs a release's compiled storage package; `pnpm build` makes this one.
    execFileSync(join(REPOSITORY, 'node_modules', '.bin', 'tsc'), ['-b', 'packages/storage'], {
      cwd: REPOSITORY,
    });
  });

  /** The preflight's view of a release into `directory`, its migrations changed by `edit`. */
  function stageRelease(directory, edit = () => {}) {
    const storage = join(directory, 'packages', 'storage');
    mkdirSync(join(storage, 'dist'), { recursive: true });
    writeFileSync(
      join(storage, 'dist', 'index.js'),
      `export * from ${JSON.stringify(pathToFileURL(STORAGE_BUILD).href)};\n`,
    );
    cpSync(MIGRATIONS, join(storage, 'migrations'), { recursive: true });
    edit(join(storage, 'migrations'));
    return directory;
  }

  /** A daemon data directory whose database has the first `count` migrations applied. */
  function dataWithDatabase(count = versions.length) {
    const data = scratch('craftingtable-deploy-data-');
    mkdirSync(join(data, 'state'));
    const database = openDatabase(join(data, 'state', 'craftingtable.sqlite'));
    runMigrations(database, discoverMigrations(MIGRATIONS).slice(0, count));
    database.close();
    return data;
  }

  const databaseOf = (data) => join(data, 'state', 'craftingtable.sqlite');
  const lastVersion = Number(versions.at(-1).slice(0, 4));
  const editMigration = (name) => (directory) =>
    appendFileSync(join(directory, name), '\n-- edited after it was deployed\n');

  it('passes a database at the release schema, or one the release will migrate', () => {
    const release = stageRelease(scratch('craftingtable-release-'));
    const current = dataWithDatabase();
    const before = readFileSync(databaseOf(current));
    expect(migrationPreflight(release, databaseOf(current))).toMatchObject({
      outcome: 'current',
      currentVersion: lastVersion,
      supportedVersion: lastVersion,
    });
    // Read only: the database's bytes are unchanged.
    expect(readFileSync(databaseOf(current)).equals(before)).toBe(true);
    expect(migrationPreflight(release, databaseOf(dataWithDatabase(versions.length - 2)))).toEqual({
      outcome: 'pending',
      currentVersion: lastVersion - 2,
      supportedVersion: lastVersion,
      pendingVersions: [lastVersion - 1, lastVersion],
    });
    expect(migrationPreflight(release, join(current, 'absent.sqlite'))).toEqual({
      outcome: 'no-database',
    });
  });

  it("refuses a release whose migrations differ from the live ledger, by the ledger's code", () => {
    const data = dataWithDatabase();
    const edited = stageRelease(scratch('craftingtable-release-'), editMigration(versions[4]));
    expect(migrationPreflight(edited, databaseOf(data))).toMatchObject({
      outcome: 'mismatch',
      failure: 'checksum-mismatch',
    });
    const renamed = stageRelease(scratch('craftingtable-release-'), (directory) =>
      renameSync(
        join(directory, versions[2]),
        join(directory, `${versions[2].slice(0, 5)}renamed.sql`),
      ),
    );
    expect(migrationPreflight(renamed, databaseOf(data))).toMatchObject({
      outcome: 'mismatch',
      failure: 'name-mismatch',
    });
    // An older release does not know the database's newest migration.
    const older = stageRelease(scratch('craftingtable-release-'), (directory) =>
      rmSync(join(directory, versions.at(-1))),
    );
    expect(migrationPreflight(older, databaseOf(data))).toMatchObject({
      outcome: 'mismatch',
      failure: 'unsupported-version',
    });
  });

  it('fails closed on a release that cannot run the check', () => {
    const empty = scratch('craftingtable-release-');
    expect(migrationPreflight(empty, databaseOf(dataWithDatabase()))).toMatchObject({
      outcome: 'unavailable',
    });
  });

  /** A source repository whose commits carry the preflight's view of a release. */
  function releaseRepository() {
    const path = scratch('craftingtable-deploy-source-');
    git(['init', '--quiet', '--initial-branch=main', '.'], path);
    const commit = (message) => {
      git(['add', '-A'], path);
      git(['commit', '--quiet', '--no-gpg-sign', '-m', message], path);
      return git(['rev-parse', 'HEAD'], path);
    };
    writeFileSync(join(path, 'VERSION'), 'older\n');
    stageRelease(path, (directory) => rmSync(join(directory, versions.at(-1))));
    const older = commit('older');
    writeFileSync(join(path, 'VERSION'), 'matching\n');
    stageRelease(path);
    const matching = commit('matching');
    writeFileSync(join(path, 'VERSION'), 'edited\n');
    editMigration(versions[4])(join(path, 'packages', 'storage', 'migrations'));
    const edited = commit('edited');
    return { path, older, matching, edited };
  }

  it('stops a deploy whose release does not match the live database before switching current', () => {
    const source = releaseRepository();
    const root = scratch('craftingtable-deploy-root-');
    const data = dataWithDatabase();
    const before = readFileSync(databaseOf(data));
    const first = deploy(source.path, root, [source.matching], data);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`Migrations: schema ${lastVersion}/${lastVersion}`);
    const refused = deploy(source.path, root, [source.edited], data);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('checksum-mismatch');
    expect(refused.stderr).toContain('stays deployed');
    // The running release stays, the refused one is gone, and the database is untouched.
    expect(deployedVersion(root)).toBe('matching');
    expect(readdirSync(join(root, 'releases'))).toHaveLength(1);
    expect(readFileSync(databaseOf(data)).equals(before)).toBe(true);
    expect(log(root).at(-1)).toMatchObject({
      action: 'preflight-refused',
      commit: source.edited,
      failure: 'checksum-mismatch',
      previous: current(root).replace('releases/', ''),
    });
  });

  it('refuses a rollback to a release that cannot read the live database', () => {
    const source = releaseRepository();
    const root = scratch('craftingtable-deploy-root-');
    const empty = scratch('craftingtable-deploy-data-');
    // Deployed while nothing was there to check, as a first deploy is.
    expect(deploy(source.path, root, [source.older], empty).status).toBe(0);
    expect(deploy(source.path, root, [source.matching], empty).status).toBe(0);
    // The newer release has since migrated the database.
    const refused = deploy(source.path, root, ['--rollback'], dataWithDatabase());
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('unsupported-version');
    expect(deployedVersion(root)).toBe('matching');
    expect(log(root).at(-1)).toMatchObject({
      action: 'preflight-refused',
      failure: 'unsupported-version',
    });
  });

  it('refuses a deploy whose release cannot run the check while a database exists', () => {
    const { path, commits } = sourceRepository();
    const root = scratch('craftingtable-deploy-root-');
    const refused = deploy(path, root, [commits[0]], dataWithDatabase());
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('could not check');
    expect(readdirSync(root)).not.toContain('current');
  });
});

describe('deploy:daemon drain handshake (R-B9)', () => {
  it('waits for the daemon to report the drain for its request', async () => {
    const directory = scratch('craftingtable-deploy-data-');
    const lines = [];
    // A stand-in daemon: acknowledges the request, reports progress, then drains.
    const daemon = setInterval(() => {
      const path = join(directory, 'drain-request.json');
      if (!existsSync(path)) return;
      const { id, mode } = JSON.parse(readFileSync(path, 'utf8'));
      const status = lines.length === 0 ? 'draining' : 'drained';
      writeFileSync(
        join(directory, 'drain-status.json'),
        JSON.stringify({
          requestId: id,
          state: status,
          busyRuns: status === 'draining' ? 2 : 0,
          interruptedRuns: mode === 'bounded' ? 1 : 0,
        }),
      );
    }, 5);
    try {
      const result = await drainDaemon(directory, 'bounded', {
        pollMs: 10,
        log: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ acknowledged: true, state: 'drained', interruptedRuns: 1 });
      expect(lines).toEqual(['Draining: 2 live agent turn(s) still working…']);
    } finally {
      clearInterval(daemon);
    }
  });

  it('withdraws the request when no daemon answers', async () => {
    const directory = scratch('craftingtable-deploy-data-');
    const result = await drainDaemon(directory, 'when-idle', { ackTimeoutMs: 30, pollMs: 10 });
    expect(result).toEqual({ acknowledged: false });
    expect(existsSync(join(directory, 'drain-request.json'))).toBe(false);
  });

  it('finds the data directory from the unit environment, then XDG', () => {
    expect(dataDirectory({ CRAFTINGTABLE_DEPLOY_DATA_DIR: '/x/y' }, {})).toBe('/x/y');
    expect(dataDirectory({}, { CRAFTINGTABLE_DATA_DIR: '/srv/ct' })).toBe('/srv/ct');
    expect(dataDirectory({ XDG_DATA_HOME: '/xdg' }, {})).toBe('/xdg/craftingtable');
  });
});

describe('unit stop settings (R-B9)', () => {
  it('names what keeps a plain systemctl stop from draining', () => {
    expect(
      unitStopProblems({
        killMode: 'control-group',
        timeoutStop: '30s',
        execStart: '{ path=/usr/bin/env ; argv[]=/usr/bin/env pnpm start ; }',
      }),
    ).toHaveLength(3);
    expect(
      unitStopProblems({
        killMode: 'mixed',
        timeoutStop: '5min',
        execStart: '{ path=/usr/bin/env ; argv[]=/usr/bin/env node apps/server/dist/index.js ; }',
      }),
    ).toEqual([]);
    expect(timeSpanSeconds('1min 30s')).toBe(90);
    expect(timeSpanSeconds('infinity')).toBe(Number.POSITIVE_INFINITY);
  });
});
