/**
 * R-G4 independent review, 2026-09-28: the reproductions of findings 1 and 2, inverted to
 * assert the fixed behaviour.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CheckReply, claimCheckRequest } from './check-spool.js';
import { hostGit } from './host-tools-test-support.js';
import { executeCheck, resolveGitDirectories } from './local-check.js';
import {
  cargoManifestDigest as hash,
  type PinnedCargoManifest,
  prepareCargoLauncher,
} from './pinned-cargo.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
}).stdout?.trim();
const itConfines = it.skipIf(!['running', 'degraded'].includes(userManager ?? ''));

/** A managed-style worktree (a `.git` pointer file) with a run directory beside it. */
function worktreeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ct-rg4-review-'));
  roots.push(root);
  const main = join(root, 'main');
  mkdirSync(main);
  writeFileSync(join(main, 'a.txt'), 'a');
  const g = (args: string[], cwd: string) =>
    expect(spawnSync(hostGit(), args, { cwd, encoding: 'utf8' }).status).toBe(0);
  g(['init', '-q', '-b', 'main'], main);
  g(['add', '.'], main);
  g(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x'], main);
  const worktree = join(root, 'worktree');
  g(['worktree', 'add', '-q', '-b', 'slice', worktree], main);
  const run = join(root, 'run');
  const directory = join(run, 'dependencies');
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, 'pins.toml');
  writeFileSync(configPath, '');
  const m: PinnedCargoManifest = {
    runtimeId: 'runtime',
    runId: 'run',
    cargoExecutable: '/unused',
    gitExecutable: hostGit(),
    ...resolveGitDirectories(hostGit(), worktree),
    workspacePath: worktree,
    targetDirectory: join(run, 'scratch', 'target'),
    packages: [],
    files: [],
    configPath,
    configDigest: hash(''),
    receiptPath: join(directory, 'receipts.jsonl'),
    verification: {
      version: 1,
      mode: 'scoped-checks',
      scope: { kind: 'slice', definitionId: 'd', bindingRevision: 1, sourceId: 'contracts' },
      reason: 'fixture',
    },
  };
  const launcher = prepareCargoLauncher(directory, m);
  return { root, run, worktree, m, launcher };
}

itConfines(
  'a confined check cannot rewrite the worktree .git pointer, and the daemon never runs repository hooks or fsmonitor (R-G4 review, HIGH)',
  async () => {
    const f = worktreeFixture();
    const marker = join(f.root, 'outside-marker');
    const evil = join(f.worktree, '.evil');
    const hook = join(evil, 'hook');
    const script = [
      `git init -q ${evil}`,
      `printf '#!/bin/sh\\necho "hook ran; DAEMON_SECRET=$DAEMON_SECRET" > ${marker}\\n' > ${hook}`,
      `chmod +x ${hook}`,
      `git -C ${evil} config core.fsmonitor ${hook}`,
      `( printf 'gitdir: ${evil}/.git\\n' > ${join(f.worktree, '.git')} ) 2>/dev/null && echo rewrote-git-pointer || echo pointer-read-only`,
    ].join(' && ');
    process.env.DAEMON_SECRET = 'visible-to-the-hook';
    let output = '';
    try {
      const outcome = await executeCheck({
        tool: 'ct-check',
        privateDirectory: join(f.root, 'daemon-private'),
        manifestPath: f.launcher.manifestPath,
        manifestDigest: f.launcher.manifestDigest,
        manifest: f.launcher.manifest,
        args: ['--', '/bin/sh', '-c', script],
        logPath: join(f.root, 'daemon-logs', '1.log'),
        logReference: 'check-logs/run/1.log',
        confinement: 'systemd',
        unitName: `craftingtable-check-review-${process.pid}-${Date.now()}`,
        writablePaths: [f.worktree, f.run],
        environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? '/' },
        onOutput: (text) => (output += text),
        signal: new AbortController().signal,
      });
      expect(output, outcome.diagnostic).toContain('pointer-read-only');
      expect(existsSync(marker)).toBe(false);
    } finally {
      delete process.env.DAEMON_SECRET;
    }
  },
);

it('the daemon ignores the worktree .git pointer and repository fsmonitor when it observes the commit (R-G4 review, HIGH)', async () => {
  // Without confinement (as for an agent with no sandbox), a rewritten pointer is not followed.
  const f = worktreeFixture();
  const marker = join(f.root, 'outside-marker');
  const evil = join(f.root, 'evil');
  spawnSync(hostGit(), ['init', '-q', evil]);
  const hook = join(evil, 'hook');
  writeFileSync(hook, `#!/bin/sh\necho ran > ${marker}\n`, { mode: 0o700 });
  spawnSync(hostGit(), ['-C', evil, 'config', 'core.fsmonitor', hook]);
  const worktreeGitDir = f.m.gitDirectory!;
  // The repository's own configuration also asks for an fsmonitor; the daemon must not run it.
  expect(
    spawnSync(hostGit(), ['--git-dir', f.m.gitCommonDirectory!, 'config', 'core.fsmonitor', hook])
      .status,
  ).toBe(0);
  writeFileSync(join(f.worktree, '.git'), `gitdir: ${evil}/.git\n`);
  const outcome = await executeCheck({
    tool: 'ct-check',
    privateDirectory: join(f.root, 'daemon-private'),
    manifestPath: f.launcher.manifestPath,
    manifestDigest: f.launcher.manifestDigest,
    manifest: f.launcher.manifest,
    args: ['--', '/bin/true'],
    logPath: join(f.root, 'daemon-logs', '2.log'),
    logReference: 'check-logs/run/2.log',
    confinement: 'none',
    unitName: 'unused',
    writablePaths: [],
    environment: { PATH: process.env.PATH ?? '/usr/bin' },
    onOutput: () => undefined,
    signal: new AbortController().signal,
  });
  expect(existsSync(marker)).toBe(false);
  const head = spawnSync(hostGit(), ['--git-dir', worktreeGitDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  expect(outcome.receipt).toMatchObject({ headSha: head });
});

it('reply files are written only in the daemon-owned reply directory (R-G4 review, MEDIUM)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-rg4-spool-'));
  roots.push(root);
  const spool = join(root, 'run', 'dependencies', 'requests');
  const replies = join(root, 'daemon', 'replies');
  mkdirSync(spool, { recursive: true });
  mkdirSync(replies, { recursive: true });
  const elsewhere = join(root, 'outside-the-sandbox');
  mkdirSync(elsewhere);
  const id = 'aaaaaaaa-0000-0000-0000-000000000000';
  writeFileSync(
    join(spool, `${id}.request`),
    JSON.stringify({ version: 1, tool: 'ct-check', args: ['--', 'x'] }),
  );
  const claimed = claimCheckRequest(spool, id);
  expect(claimed && 'request' in claimed).toBe(true);
  const reply = new CheckReply(spool, replies, id);
  // While the check runs, the agent (who owns run/dependencies) swaps the spool for a link.
  renameSync(spool, `${spool}.old`);
  symlinkSync(elsewhere, spool);
  reply.write('agent-chosen payload\n');
  reply.finish(0);
  expect(existsSync(join(elsewhere, `${id}.out`))).toBe(false);
  expect(existsSync(join(elsewhere, `${id}.exit`))).toBe(false);
  expect(readFileSync(join(replies, `${id}.out`), 'utf8')).toBe('agent-chosen payload\n');
});
