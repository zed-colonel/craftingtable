import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

/** Runs the real script against a scratch deploy root, with building and restarting disabled. */
function deploy(source, root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--yes', '--no-restart', '--skip-build'], {
    cwd: source,
    env: { ...GIT_ENV, CRAFTINGTABLE_DEPLOY_ROOT: root },
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
      env: { ...GIT_ENV, CRAFTINGTABLE_DEPLOY_ROOT: root },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Re-run with --yes');
    expect(readdirSync(root)).not.toContain('current');
  });
});
