import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostGit } from './host-tools-test-support.js';
import {
  loadLocalCiConfig,
  localActArguments,
  localCiLockPath,
  prepareLocalCheckLaunchers,
} from './local-check.js';
import {
  cargoManifestDigest as hash,
  type PinnedCargoManifest,
  prepareCargoLauncher,
} from './pinned-cargo.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ct-scoped-check-'));
  roots.push(root);
  const workspacePath = join(root, 'repository');
  mkdirSync(workspacePath);
  writeFileSync(join(workspacePath, 'contract.json'), '{"version":1}');
  for (const args of [
    ['init', '-b', 'main'],
    ['add', '.'],
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture'],
  ])
    expect(spawnSync(hostGit(), args, { cwd: workspacePath }).status).toBe(0);
  const directory = join(root, 'run/dependencies');
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, 'pins.toml');
  writeFileSync(configPath, '');
  const m: PinnedCargoManifest = {
    runtimeId: 'runtime',
    runId: 'run',
    cargoExecutable: '/unused',
    gitExecutable: hostGit(),
    workspacePath,
    targetDirectory: join(root, 'target'),
    packages: [],
    files: [],
    configPath,
    configDigest: hash(''),
    receiptPath: join(directory, 'receipts.jsonl'),
    verification: {
      version: 1,
      mode: 'scoped-checks',
      scope: { kind: 'slice', definitionId: 'd', bindingRevision: 1, sourceId: 'contracts' },
      reason: 'Contract-only fixture',
    },
  };
  const launch = (manifest = m) => {
    rmSync(join(directory, 'manifest.json'), { force: true });
    rmSync(join(directory, 'bin'), { recursive: true, force: true });
    const launcher = prepareCargoLauncher(directory, manifest);
    prepareLocalCheckLaunchers(
      launcher.binDirectory,
      launcher.manifestPath,
      launcher.manifestDigest,
    );
    return launcher;
  };
  const launcher = launch();
  const execute = (args: string[]) =>
    spawnSync(join(launcher.binDirectory, 'ct-check'), ['--', process.execPath, ...args], {
      cwd: workspacePath,
      encoding: 'utf8',
    });
  const receipts = () =>
    readFileSync(m.receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return { root, m, directory, launcher, launch, execute, receipts };
}
it('retains passing contract checks, failures and dirty-commit provenance without claiming current integration', () => {
  const f = fixture();
  const success = f.execute([
    '-e',
    'const fs=require("node:fs");if(JSON.parse(fs.readFileSync("contract.json")).version!==1)process.exit(1);console.log("contract checked")',
  ]);
  expect(success.status, success.stderr).toBe(0);
  expect(f.receipts()[0]).toMatchObject({
    kind: 'scoped-check',
    verificationMode: 'scoped-checks',
    clean: true,
    success: true,
    policyDigest: hash(JSON.stringify(f.m.verification)),
  });
  expect(readFileSync(join(f.directory, f.receipts()[0].logPath), 'utf8')).toContain(
    'contract checked',
  );
  expect(f.execute(['-e', 'console.error("bad contract");process.exit(2)']).status).toBe(1);
  expect(f.receipts()[1]).toMatchObject({ success: false, exitCode: 2 });
  expect(
    f.execute(['-e', 'require("node:fs").writeFileSync("contract.json","changed")']).status,
  ).toBe(0);
  expect(f.receipts()[2]).toMatchObject({ success: true, clean: false });
});
it('records timeout failure and rejects changed manifests', () => {
  const f = fixture();
  f.launch({ ...f.m, checkTimeoutMs: 100 });
  expect(f.execute(['-e', 'setTimeout(()=>{},60000)']).status).toBe(1);
  expect(f.receipts()[0]).toMatchObject({
    success: false,
    diagnostic: 'Check interrupted or timed out.',
  });
  chmodSync(f.launcher.manifestPath, 0o600);
  writeFileSync(f.launcher.manifestPath, '{}');
  expect(f.execute(['-e', '']).stderr).toContain('manifest changed');
  expect(f.receipts()).toHaveLength(1);
});
it('kills the whole check process tree on timeout and after the check ends (AGT-09)', async () => {
  const f = fixture();
  f.launch({ ...f.m, checkTimeoutMs: 1500 });
  // A stray descendant: `sleep` outlives its parent unless its group is signalled.
  const spawnSleeper = (pidFile: string, then: string) => [
    '-e',
    `const c=require("node:child_process").spawn("sleep",["60"],{stdio:"ignore"});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));${then}`,
  ];
  const running = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3));
    } catch {
      return false;
    }
  };
  const settled = async (pid: number) => {
    const deadline = Date.now() + 3000;
    while (running(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return !running(pid);
  };
  const timedOutPid = join(f.root, 'timed-out.pid');
  expect(f.execute(spawnSleeper(timedOutPid, 'setTimeout(()=>{},60000)')).status).toBe(1);
  expect(f.receipts()[0]).toMatchObject({ diagnostic: 'Check interrupted or timed out.' });
  expect(await settled(Number(readFileSync(timedOutPid, 'utf8')))).toBe(true);

  const finishedPid = join(f.root, 'finished.pid');
  expect(f.execute(spawnSleeper(finishedPid, 'process.exit(0)')).status).toBe(0);
  expect(await settled(Number(readFileSync(finishedPid, 'utf8')))).toBe(true);
});
it('binds act to one repository workflow, pinned image, local storage and no automatic host secrets', () => {
  const f = fixture();
  const workflow = join(f.m.workspacePath, '.github/workflows');
  mkdirSync(workflow, { recursive: true });
  writeFileSync(join(workflow, 'ci.yml'), 'name: checks');
  const localCi = {
    actExecutable: '/usr/bin/act',
    dockerExecutable: '/usr/bin/docker',
    dockerHost: 'unix:///run/user/1000/docker.sock',
    image: `image@sha256:${'a'.repeat(64)}`,
    cacheRoot: join(f.root, 'cache'),
  };
  const m = { ...f.m, localCi };
  const args = localActArguments(
    m,
    f.launcher.manifestPath,
    ['-W', '.github/workflows/ci.yml', '-j', 'contracts'],
    f.directory,
  );
  expect(args).toContain(`ubuntu-latest=${localCi.image}`);
  expect(args).toContain('--container-daemon-socket=-');
  expect(args).toContain('--concurrent-jobs=1');
  expect(args.slice(args.indexOf('--secret-file'), args.indexOf('--secret-file') + 2)).toEqual([
    '--secret-file',
    '/dev/null',
  ]);
  expect(args.join(' ')).toContain('craftingtable.run=run');
  expect(() =>
    localActArguments(m, f.launcher.manifestPath, ['-W', '../external.yml'], f.directory),
  ).toThrow();
  expect(() =>
    localActArguments(
      m,
      f.launcher.manifestPath,
      ['-W', '.github/workflows/ci.yml', '--privileged'],
      f.directory,
    ),
  ).toThrow();
  const config = join(f.root, 'act.json');
  writeFileSync(config, JSON.stringify({ ...localCi, image: 'image:latest' }));
  expect(() => loadLocalCiConfig(config)).toThrow('pinned by digest');
});
it('runs one act invocation per workflow at a time across runs on a Docker host', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'ct-act-shared-'));
  roots.push(shared);
  const log = join(shared, 'act.log');
  const tool = (name: string, body: string) => {
    const path = join(shared, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  // act records its interval; the docker stub lists no containers for cleanup.
  const localCi = {
    actExecutable: tool(
      'act',
      `echo "start $(date +%s%N)" >> ${log}; sleep 1; echo "end $(date +%s%N)" >> ${log}`,
    ),
    dockerExecutable: tool('docker', 'exit 0'),
    dockerHost: 'unix:///run/user/1000/docker.sock',
    image: `image@sha256:${'a'.repeat(64)}`,
    cacheRoot: join(shared, 'cache'),
  };
  const run = (runId: string) => {
    const f = fixture();
    mkdirSync(join(f.m.workspacePath, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(f.m.workspacePath, '.github/workflows/contract.yml'),
      'name: "Shared contract" # act names containers after this\non: push\n',
    );
    const launcher = f.launch({ ...f.m, runId, localCi });
    return { f, launcher };
  };
  const [a, b] = [run('run-a'), run('run-b')];
  const lock = localCiLockPath(localCi, a.f.m.workspacePath, [
    '-W',
    '.github/workflows/contract.yml',
  ]);
  expect(lock).toBe(
    localCiLockPath(localCi, b.f.m.workspacePath, ['-W', '.github/workflows/contract.yml']),
  );
  // A lock left by a process that no longer exists does not hold anyone.
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ identity: '999999999:1', runId: 'gone' }),
  );
  const act = ({ f, launcher }: ReturnType<typeof run>) =>
    new Promise<number | null>((done) =>
      spawn(
        join(launcher.binDirectory, 'ct-act'),
        ['-W', '.github/workflows/contract.yml', '-j', 'contract'],
        { cwd: f.m.workspacePath, stdio: 'ignore' },
      ).once('close', done),
    );
  expect(await Promise.all([act(a), act(b)])).toEqual([0, 0]);
  const times = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' ')[0]);
  // Serialized: each act ends before the next starts.
  expect(times).toEqual(['start', 'end', 'start', 'end']);
  expect(() => readFileSync(join(lock, 'owner.json'))).toThrow();
});
it('refuses native qualification without approval and keeps ordinary checks distinct', () => {
  const f = fixture();
  const p = spawnSync(join(f.launcher.binDirectory, 'ct-native'), ['--', '/usr/bin/true'], {
    cwd: f.m.workspacePath,
    encoding: 'utf8',
  });
  expect(p.status).toBe(1);
  expect(f.receipts()[0]).toMatchObject({ kind: 'native-check', success: false });
  expect(f.receipts()[0].diagnostic).toContain('approved native');
});
