import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { hostCargo, hostGit } from './host-tools-test-support.js';
import { nativeHostDigest } from './native-environment.js';
import {
  acquireLocalCiLock,
  confinedCheckArguments,
  declaredUnitSettings,
  executeCheck,
  lockedPackages,
  readRegular,
  resolveGitDirectories,
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
    ...resolveGitDirectories(hostGit(), workspacePath),
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
/** This process's identity as the lock records it (PID and /proc start time). */
function ownIdentity() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return `${process.pid}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
}
it('releases its run when a ct-act is interrupted while it waits for the workflow lock', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'ct-act-wait-'));
  roots.push(shared);
  const tool = (name: string, body: string) => {
    const path = join(shared, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const localCi = {
    actExecutable: tool('act', 'exit 0'),
    dockerExecutable: tool('docker', 'exit 0'),
    dockerHost: 'unix:///run/user/1000/docker.sock',
    image: `image@sha256:${'a'.repeat(64)}`,
    cacheRoot: join(shared, 'cache'),
  };
  const f = fixture();
  mkdirSync(join(f.m.workspacePath, '.github/workflows'), { recursive: true });
  writeFileSync(join(f.m.workspacePath, '.github/workflows/contract.yml'), 'name: C\non: push\n');
  const launcher = f.launch({ ...f.m, runId: 'run-w', localCi });
  const lock = localCiLockPath(localCi, f.m.workspacePath, [
    '-W',
    '.github/workflows/contract.yml',
  ]);
  // Another live run (this test process) holds the workflow's lock.
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ identity: ownIdentity(), runId: 'other' }),
  );
  const act = () =>
    spawn(join(launcher.binDirectory, 'ct-act'), ['-W', '.github/workflows/contract.yml'], {
      cwd: f.m.workspacePath,
      stdio: 'ignore',
    });
  const waiting = act();
  await new Promise((r) => setTimeout(r, 1500));
  // The agent's shell tool gives up on the waiting command.
  waiting.kill('SIGTERM');
  await new Promise((r) => waiting.once('close', r));
  rmSync(lock, { recursive: true });
  // The run's next ct-act is not refused by a lease the interrupted one left behind.
  expect(await new Promise<number | null>((done) => act().once('close', done))).toBe(0);
  expect(f.receipts().at(-1)?.diagnostic ?? '').not.toContain('EEXIST');
});
it('grants a stale workflow lock to one of several contenders reclaiming it at once', async () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'ct-act-reclaim-')), 'locks', 'act-z');
  roots.push(join(lock, '..', '..'));
  const moduleUrl = new URL('./local-check.ts', import.meta.url).href;
  let overlaps = 0;
  for (let round = 0; round < 6; round++) {
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ identity: '999999999:1', runId: 'gone' }),
    );
    const go = Date.now() + 1500;
    // Each winner holds 300 ms and exits without releasing, like a killed launcher, so
    // acquisitions that honour the lock are at least 300 ms apart.
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        (_, i) =>
          new Promise<string>((done) => {
            const p = spawn(
              process.execPath,
              [
                '--input-type=module',
                '-e',
                `import { acquireLocalCiLock } from ${JSON.stringify(moduleUrl)};
                 while (Date.now() < ${go}) {}
                 await acquireLocalCiLock(${JSON.stringify(lock)}, 'r${i}', 400, 10).then(
                   () => { const t = Date.now(); while (Date.now() < t + 300) {} process.stdout.write('held ' + t); },
                   () => process.stdout.write('timeout'));`,
              ],
              { stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let out = '';
            p.stdout.on('data', (d) => (out += d));
            p.stderr.on('data', (d) => (out += d));
            p.once('close', () => done(out));
          }),
      ),
    );
    const held = results
      .filter((r) => r.startsWith('held'))
      .map((r) => Number(r.split(' ')[1]))
      .sort((x, y) => x - y);
    expect(held.length, results.join(' | ')).toBeGreaterThan(0);
    for (let i = 1; i < held.length; i++) if (held[i]! - held[i - 1]! < 300) overlaps++;
  }
  expect(overlaps).toBe(0);
}, 120000);
it('does not reclaim a lock whose owner is alive with its recorded start time', async () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'ct-act-live-')), 'act-y');
  roots.push(join(lock, '..'));
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ identity: ownIdentity(), runId: 'live' }),
  );
  await expect(acquireLocalCiLock(lock, 'new', 300, 50)).rejects.toThrow('(live) held');
  // PID 1 is alive, but not with this start time: its PID was reused.
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ identity: '1:123', runId: 'old' }));
  await acquireLocalCiLock(lock, 'new', 1000, 50);
  expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).runId).toBe('new');
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

const userManager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
}).stdout?.trim();
const itConfines = it.skipIf(!['running', 'degraded'].includes(userManager ?? ''));

itConfines(
  'runs a daemon check in a confined unit: its run directory only, no network, a named environment (R-G4)',
  async () => {
    const f = fixture();
    const run = join(f.root, 'run');
    const outside = join(homedir(), `.ct-confinement-probe-${process.pid}`);
    const script = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(join(run, 'written'))}, 'ok'); console.log('run-written');
      try { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); console.log('home-written'); }
      catch { console.log('home-denied'); }
      require('node:net').connect(80, '1.1.1.1')
        .on('connect', () => { console.log('net-open'); process.exit(0); })
        .on('error', () => { console.log('net-denied'); console.log('env', Object.keys(process.env).sort().join(',')); });
    `;
    let output = '';
    try {
      const outcome = await executeCheck({
        tool: 'ct-check',
        privateDirectory: join(f.root, 'daemon-private'),
        manifestPath: f.launcher.manifestPath,
        manifestDigest: f.launcher.manifestDigest,
        manifest: f.launcher.manifest,
        args: ['--', process.execPath, '-e', script],
        logPath: join(f.root, 'daemon-logs', '1.log'),
        logReference: 'check-logs/run/1.log',
        confinement: 'systemd',
        unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
        writablePaths: [f.m.workspacePath, run],
        environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir() },
        onOutput: (text) => (output += text),
        signal: new AbortController().signal,
      });
      expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
      expect(output).toContain('run-written');
      expect(output).toContain('home-denied');
      expect(output).toContain('net-denied');
      expect(output).toContain('env HOME,PATH\n');
      expect(existsSync(outside)).toBe(false);
      expect(outcome.receipt).toMatchObject({
        kind: 'scoped-check',
        recordedBy: 'daemon',
        success: true,
        clean: true,
        logPath: 'check-logs/run/1.log',
      });
      expect(readFileSync(join(f.root, 'daemon-logs', '1.log'), 'utf8')).toContain('net-denied');
    } finally {
      rmSync(outside, { force: true });
    }
  },
);

itConfines('stops a confined check and its unit when the daemon cancels it (R-G4)', async () => {
  const f = fixture();
  const unitName = `craftingtable-check-test-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  let output = '';
  const running = executeCheck({
    tool: 'ct-check',
    privateDirectory: join(f.root, 'daemon-private'),
    manifestPath: f.launcher.manifestPath,
    manifestDigest: f.launcher.manifestDigest,
    manifest: f.launcher.manifest,
    args: ['--', process.execPath, '-e', 'console.log("started"); setInterval(() => {}, 1000)'],
    logPath: join(f.root, 'daemon-logs', '2.log'),
    logReference: 'check-logs/run/2.log',
    confinement: 'systemd',
    unitName,
    writablePaths: [f.m.workspacePath],
    environment: { PATH: process.env.PATH ?? '/usr/bin' },
    onOutput: (text) => {
      output += text;
      if (output.includes('started')) controller.abort();
    },
    signal: controller.signal,
  });
  const outcome = await running;
  expect(outcome.exitCode).toBe(1);
  expect(outcome.receipt).toMatchObject({ success: false, exitCode: null });
  const state = spawnSync('systemctl', ['--user', 'is-active', unitName], { encoding: 'utf8' });
  expect(state.stdout.trim()).not.toBe('active');
});

it('runs ct-act in the daemon with a private HOME, under the workflow hold, and removes its containers (R-G4, LIVE-03)', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'ct-act-daemon-'));
  roots.push(shared);
  const calls = join(shared, 'docker.log');
  const tool = (name: string, body: string) => {
    const path = join(shared, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const localCi = {
    actExecutable: tool('act', 'echo "act home=$HOME cwd=$(pwd) docker=$DOCKER_HOST"'),
    dockerExecutable: tool(
      'docker',
      `echo "$@" >> ${calls}; [ "$1" = ps ] && echo 0123456789ab; exit 0`,
    ),
    dockerHost: 'unix:///run/user/1000/docker.sock',
    image: `image@sha256:${'a'.repeat(64)}`,
    cacheRoot: join(shared, 'cache'),
  };
  const f = fixture();
  mkdirSync(join(f.m.workspacePath, '.github/workflows'), { recursive: true });
  writeFileSync(join(f.m.workspacePath, '.github/workflows/contract.yml'), 'name: C\non: push\n');
  spawnSync(hostGit(), ['add', '.'], { cwd: f.m.workspacePath });
  spawnSync(
    hostGit(),
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'workflow'],
    { cwd: f.m.workspacePath },
  );
  const launcher = f.launch({ ...f.m, localCi });
  const privateDirectory = join(shared, 'daemon-private');
  const held: string[] = [];
  const execution = (hold: import('./local-check.js').WorkflowHold) => {
    let output = '';
    return executeCheck({
      tool: 'ct-act',
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args: ['-W', '.github/workflows/contract.yml'],
      logPath: join(shared, 'logs', `${held.length}.log`),
      logReference: 'check-logs/run/act.log',
      privateDirectory,
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [],
      environment: {},
      holdWorkflow: hold,
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
    }).then((outcome) => ({ outcome, output }));
  };
  const ran = await execution(async (key) => {
    held.push(key);
    return () => held.push('released');
  });
  expect(ran.outcome.exitCode, ran.output + ran.outcome.diagnostic).toBe(0);
  expect(ran.output).toContain(
    `act home=${join(privateDirectory, 'home')} cwd=${privateDirectory}`,
  );
  expect(ran.outcome.receipt).toMatchObject({
    kind: 'local-ci',
    recordedBy: 'daemon',
    success: true,
    clean: true,
    image: localCi.image,
  });
  expect(held).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), 'released']);
  expect(readFileSync(calls, 'utf8')).toContain('rm -f -v 0123456789ab');

  // A hold that is not granted before the time limit is a failed, labelled receipt; act never runs.
  rmSync(calls, { force: true });
  const expired = await execution(async () => {
    throw new Error("Another run held this workflow's local CI past the check time limit.");
  });
  expect(expired.outcome.exitCode).toBe(1);
  expect(expired.output).not.toContain('act home');
  expect(expired.outcome.receipt).toMatchObject({
    kind: 'local-ci',
    success: false,
    workflowWait: 'expired',
  });

  // The wait counts against the check's time limit (R-I11): a hold granted after the limit
  // leaves no time for act.
  const short = f.launch({ ...f.m, localCi, checkTimeoutMs: 200 });
  let deadline = 0;
  const late = await executeCheck({
    tool: 'ct-act',
    manifestPath: short.manifestPath,
    manifestDigest: short.manifestDigest,
    manifest: short.manifest,
    args: ['-W', '.github/workflows/contract.yml'],
    logPath: join(shared, 'logs', 'late.log'),
    logReference: 'check-logs/run/late.log',
    privateDirectory,
    confinement: 'none',
    unitName: 'unused',
    writablePaths: [],
    environment: {},
    holdWorkflow: async (_key, until) => {
      deadline = until;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return () => undefined;
    },
    onOutput: () => undefined,
    signal: new AbortController().signal,
  });
  expect(deadline - Date.now()).toBeLessThan(0);
  expect(late.diagnostic).toContain('time limit passed before it could start');
  expect(late.receipt).toMatchObject({ success: false });
});

itConfines(
  'runs ct-native in the daemon, in the approved native unit with a daemon-owned HOME, and refuses without approval (R-G4)',
  async () => {
    const f = fixture();
    const nativeVerification = {
      approvalId: 'approval',
      hostDigest: nativeHostDigest(),
      auditDigest: 'a'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      toolchainDigest: 'c'.repeat(64),
      toolchain: 'fixture',
    };
    const privateDirectory = join(f.root, 'daemon-private');
    const run = async (manifest: PinnedCargoManifest) => {
      const launcher = f.launch(manifest);
      let output = '';
      const outcome = await executeCheck({
        tool: 'ct-native',
        manifestPath: launcher.manifestPath,
        manifestDigest: launcher.manifestDigest,
        manifest: launcher.manifest,
        args: ['--', '/bin/sh', '-c', 'echo "native home=$HOME"'],
        logPath: join(f.root, 'daemon-logs', 'native.log'),
        logReference: 'check-logs/run/native.log',
        privateDirectory,
        confinement: 'systemd',
        unitName: 'unused',
        writablePaths: [],
        environment: {},
        onOutput: (text) => (output += text),
        signal: new AbortController().signal,
      });
      return { outcome, output };
    };
    const refused = await run({ ...f.m, runId: `native-refused-${process.pid}` });
    expect(refused.outcome.exitCode).toBe(1);
    expect(refused.outcome.receipt).toMatchObject({ kind: 'native-check', success: false });
    expect(refused.outcome.diagnostic).toContain('approved native');
    const approved = await run({
      ...f.m,
      runId: `native-approved-${process.pid}`,
      nativeVerification,
    });
    expect(approved.outcome.exitCode, approved.output + approved.outcome.diagnostic).toBe(0);
    expect(approved.output).toContain(`native home=${join(privateDirectory, 'home')}`);
    expect(approved.outcome.receipt).toMatchObject({
      kind: 'native-check',
      recordedBy: 'daemon',
      success: true,
      clean: true,
      nativeVerification,
    });
  },
);

it('runs a pinned Cargo build in the daemon, records its receipt and stops it at the check time limit (R-G4)', async () => {
  const f = fixture();
  const cargo = join(f.root, 'fake-cargo');
  // Answers the version and graph queries; a build sleeps unless asked to finish at once.
  writeFileSync(
    cargo,
    `#!/bin/sh
case "$1" in
  --version) echo "cargo 1.0.0 (fixture)";;
  metadata) echo '{"packages":[],"resolve":{"nodes":[]}}';;
  *) echo "building $@"; [ -n "$FAST" ] || sleep 30;;
esac
`,
    { mode: 0o700 },
  );
  const run = async (environment: Record<string, string>, checkTimeoutMs: number) => {
    const launcher = f.launch({ ...f.m, cargoExecutable: cargo, checkTimeoutMs });
    let output = '';
    const started = Date.now();
    const outcome = await executeCheck({
      tool: 'cargo',
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args: ['test', '--offline'],
      logPath: join(f.root, 'daemon-logs', `cargo-${checkTimeoutMs}.log`),
      logReference: 'check-logs/run/cargo.log',
      privateDirectory: join(f.root, 'daemon-private'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [],
      environment: { PATH: process.env.PATH ?? '/usr/bin', ...environment },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
    });
    return { outcome, output, elapsed: Date.now() - started };
  };
  const built = await run({ FAST: '1' }, 60_000);
  expect(built.outcome.exitCode, built.output + built.outcome.diagnostic).toBe(0);
  expect(built.output).toContain(`building test --offline --config ${f.m.configPath}`);
  expect(built.outcome.receipt).toMatchObject({
    recordedBy: 'daemon',
    command: 'test',
    toolchain: 'cargo 1.0.0 (fixture)',
    success: true,
    clean: true,
    packages: [],
  });
  expect(built.outcome.receipt).not.toHaveProperty('kind');
  const slow = await run({}, 500);
  expect(slow.elapsed).toBeLessThan(10_000);
  expect(slow.outcome.receipt).toMatchObject({ success: false, exitCode: null });
  expect(slow.outcome.diagnostic).toContain('timed out');
  // Only builds are the daemon's to run; other commands record nothing.
  const launcher = f.launch({ ...f.m, cargoExecutable: cargo });
  const refused = await executeCheck({
    tool: 'cargo',
    manifestPath: launcher.manifestPath,
    manifestDigest: launcher.manifestDigest,
    manifest: launcher.manifest,
    args: ['fmt'],
    logPath: join(f.root, 'daemon-logs', 'fmt.log'),
    logReference: 'check-logs/run/fmt.log',
    privateDirectory: join(f.root, 'daemon-private'),
    confinement: 'none',
    unitName: 'unused',
    writablePaths: [],
    environment: {},
    onOutput: () => undefined,
    signal: new AbortController().signal,
  });
  expect(refused.diagnostic).toContain('records nothing');
});

it('keeps no more of a check log than the daemon allows (R-G4 review)', async () => {
  const f = fixture();
  const logPath = join(f.root, 'daemon-logs', 'budget.log');
  const outcome = await executeCheck({
    tool: 'ct-check',
    manifestPath: f.launcher.manifestPath,
    manifestDigest: f.launcher.manifestDigest,
    manifest: f.launcher.manifest,
    args: ['--', process.execPath, '-e', 'console.log("x".repeat(100000))'],
    logPath,
    logReference: 'check-logs/run/budget.log',
    privateDirectory: join(f.root, 'daemon-private'),
    confinement: 'none',
    unitName: 'unused',
    writablePaths: [],
    environment: { PATH: process.env.PATH ?? '/usr/bin' },
    onOutput: () => undefined,
    signal: new AbortController().signal,
    logLimitBytes: 64,
  });
  expect(outcome.exitCode).toBe(0);
  expect(outcome.logBytes).toBeLessThan(200);
  expect(readFileSync(logPath, 'utf8')).toContain('log truncated');
});

it('refuses a workflow whose jobs declare containers, services, reusable workflows or docker:// steps (R-G4 review)', () => {
  const f = fixture();
  const workflows = join(f.m.workspacePath, '.github/workflows');
  mkdirSync(workflows, { recursive: true });
  const localCi = {
    actExecutable: '/usr/bin/act',
    dockerExecutable: '/usr/bin/docker',
    dockerHost: 'unix:///run/user/1000/docker.sock',
    image: `image@sha256:${'a'.repeat(64)}`,
    cacheRoot: join(f.root, 'cache'),
  };
  const args = (text: string) => {
    writeFileSync(join(workflows, 'ci.yml'), text);
    return () =>
      localActArguments(
        { ...f.m, localCi },
        f.launcher.manifestPath,
        ['-W', '.github/workflows/ci.yml'],
        f.directory,
      );
  };
  const plain =
    'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo test\n';
  expect(args(plain)).not.toThrow();
  for (const [key, text] of [
    [
      'container',
      `${plain.replace('    steps:', '    container:\n      image: x\n      options: -v /home:/h\n    steps:')}`,
    ],
    [
      'services',
      `${plain.replace('    steps:', '    services:\n      db:\n        image: x\n    steps:')}`,
    ],
    ['uses', 'name: CI\non: push\njobs:\n  call:\n    uses: ./.github/workflows/other.yml\n'],
    ['docker://', `${plain}      - uses: docker://alpine\n`],
    // An alias cannot hide one.
    [
      'container',
      'name: CI\non: push\nx: &c\n  image: x\njobs:\n  test:\n    runs-on: ubuntu-latest\n    container: *c\n    steps:\n      - run: true\n',
    ],
  ] as const)
    expect(args(text), key).toThrow(key);
  expect(args('jobs: [unclosed')).toThrow('could not be read');
});

it("a declared check unit sees none of the run's writable roots or the shared Cargo home, and finds no program there (R-G13 review)", () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-declared-unit-'));
  roots.push(root);
  const at = (name: string) => join(root, name);
  const worktree = at('worktree'),
    run = at('run'),
    cargo = at('cargo'),
    clone = at('clone'),
    scratch = at('private');
  for (const p of [worktree, run, cargo, join(run, 'bin'), join(worktree, 'bin')])
    mkdirSync(p, { recursive: true });
  // A PATH entry that reaches the run directory through a link is refused too.
  symlinkSync(join(run, 'bin'), join(root, 'linked-bin'));
  const unit = declaredUnitSettings({
    environment: {
      PATH: `${join(run, 'bin')}:${join(worktree, 'bin')}:${join(root, 'linked-bin')}:${join(cargo, 'bin')}:${join(root, 'data', 'bin')}:relative/bin:/usr/bin`,
      // The check's own Cargo home; the shared one is out of sight.
      CARGO_HOME: join(scratch, 'cargo-home'),
    },
    sharedCargoHome: cargo,
    hiddenRoots: [join(root, 'data'), cargo],
    homeDirectory: root,
    runWritablePaths: [worktree, run, join(cargo, 'registry'), join(cargo, 'git')],
    launcherDirectory: join(run, 'dependencies'),
    workspacePath: worktree,
    snapshot: clone,
    privateDirectory: scratch,
    target: join(scratch, 'target', 'a'.repeat(40)),
  });
  expect(unit.environment.PATH).toBe('/usr/bin');
  expect(unit.environment.TMPDIR).toBe(join(scratch, 'tmp'));
  expect(unit.environment.CARGO_TARGET_DIR).toBe(join(scratch, 'target', 'a'.repeat(40)));
  expect(unit.writable).toEqual([
    clone,
    join(scratch, 'tmp'),
    join(scratch, 'target', 'a'.repeat(40)),
    join(scratch, 'cargo-home'),
  ]);
  expect(unit.inaccessible).toEqual([
    worktree,
    join(run, 'dependencies'),
    worktree,
    run,
    join(cargo, 'registry'),
    join(cargo, 'git'),
    cargo,
  ]);
  const args = confinedCheckArguments(
    'unit',
    clone,
    60,
    unit.writable,
    unit.environment,
    ['true'],
    false,
    [],
    unit.inaccessible,
  );
  expect(args).toContain(`InaccessiblePaths=-${run}`);
  expect(args).toContain(`InaccessiblePaths=-${worktree}`);
  expect(args).toContain(`InaccessiblePaths=-${cargo}`);
  // Every root agents write is hidden, the home too, and only the check's own paths are bound
  // back; the toolchain on its PATH under the home comes back read-only.
  expect(unit.hidden).toEqual([join(root, 'data'), cargo, root]);
  expect(unit.environment.HOME).toBe(join(scratch, 'tmp'));
  expect(unit.environment.RUSTUP_HOME).toBe(join(root, '.rustup'));
  expect(unit.readOnlyBinds).toEqual([join(root, '.rustup')]);
  expect(unit.binds).toEqual(unit.writable);
  const confined = confinedCheckArguments(
    'unit',
    clone,
    60,
    unit.writable,
    unit.environment,
    ['true'],
    false,
    [],
    unit.inaccessible,
    { roots: unit.hidden, binds: unit.binds, readOnlyBinds: unit.readOnlyBinds },
  );
  expect(confined).toContain(`TemporaryFileSystem=${join(root, 'data')}:ro`);
  expect(confined).toContain(`BindPaths=${clone}`);
  expect(confined).toContain('TemporaryFileSystem=/dev/shm');
  expect(confined).toContain(`BindReadOnlyPaths=-${join(root, '.rustup')}`);
});

const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const commitAll = (cwd: string) => {
  for (const args of [
    ['add', '.'],
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'lock'],
  ])
    expect(spawnSync(hostGit(), args, { cwd }).status).toBe(0);
};
const REGISTRY_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';
const lockOf = (
  packages: readonly { name: string; version: string; checksum?: string; source?: string }[],
) =>
  `version = 4\n\n${packages
    .map(
      (p) =>
        `[[package]]\nname = "${p.name}"\nversion = "${p.version}"\nsource = "${p.source ?? REGISTRY_SOURCE}"\n${p.checksum ? `checksum = "${p.checksum}"\n` : ''}`,
    )
    .join('\n')}`;
/** A registry authority that knows only the given crates, as `name@version` → checksum. */
const authority = (known: Record<string, string>, asked: string[] = []) => ({
  checksum: async (source: string, name: string, version: string) => {
    asked.push(name);
    return source === REGISTRY_SOURCE ? known[`${name}@${version}`] : undefined;
  },
  indexFile: async (source: string, name: string) => {
    const lines = Object.entries(known)
      .filter(([key]) => source === REGISTRY_SOURCE && key.startsWith(`${name}@`))
      .map(([key, cksum]) =>
        JSON.stringify({
          name,
          vers: key.slice(name.length + 1),
          deps: [],
          cksum,
          features: {},
          yanked: false,
        }),
      );
    return lines.length ? `${lines.join('\n')}\n` : undefined;
  },
});

it('reads the registry packages and Git commits a lock pins', () => {
  const lock = `${lockOf([{ name: 'itoa', version: '1.0.18', checksum: 'a'.repeat(64) }])}
[[package]]
name = "local"
version = "0.1.0"

[[package]]
name = "from-git"
version = "0.2.0"
source = "git+https://example.invalid/x#${'b'.repeat(40)}"
`;
  expect(lockedPackages(lock)).toEqual({
    registry: [
      { source: REGISTRY_SOURCE, name: 'itoa', version: '1.0.18', checksum: 'a'.repeat(64) },
    ],
    gitCommits: ['b'.repeat(40)],
  });
});

/** Runs a ct-check that lists its Cargo home, with the shared home and authority given. */
async function listCargoHome(
  f: ReturnType<typeof fixture>,
  shared: string,
  crateRegistry?: ReturnType<typeof authority>,
) {
  let output = '';
  const outcome = await executeCheck({
    tool: 'ct-check',
    privateDirectory: join(f.root, 'daemon-private'),
    manifestPath: f.launcher.manifestPath,
    manifestDigest: f.launcher.manifestDigest,
    manifest: f.launcher.manifest,
    args: [
      '--',
      'sh',
      '-c',
      'echo "home=$CARGO_HOME offline=$CARGO_NET_OFFLINE"; cd "$CARGO_HOME" && find . -print | sort && cat config.toml',
    ],
    logPath: join(f.root, 'daemon-logs', 'cargo.log'),
    logReference: 'check-logs/run/cargo.log',
    confinement: 'none',
    unitName: 'unused',
    writablePaths: [f.m.workspacePath, join(shared, 'registry'), join(shared, 'git')],
    environment: { PATH: process.env.PATH ?? '/usr/bin', CARGO_HOME: shared },
    onOutput: (text) => (output += text),
    signal: new AbortController().signal,
    ...(crateRegistry ? { crateRegistry } : {}),
    cargoHomeDirectory: join(f.root, 'check-logs', 'cargo-home-0'),
  });
  return { outcome, output, home: join(f.root, 'check-logs', 'cargo-home-0') };
}

it('a check gets a fresh Cargo home: a local registry of published index entries and the downloads that match them, whichever lock names them, and nothing of the shared home (R-G13 review, operator decisions 2026-09-29)', async () => {
  const f = fixture();
  const shared = join(f.root, 'shared-cargo');
  const registry = 'index.crates.io-1949cf8c6b5b557f';
  const put = (path: string, content: string) => {
    mkdirSync(join(shared, path, '..'), { recursive: true });
    writeFileSync(join(shared, path), content);
  };
  put(`registry/index/${registry}/config.json`, '{"dl":"https://static.crates.io/crates"}');
  put(`registry/cache/${registry}/good-1.0.0.crate`, 'GENUINE GOOD');
  // Rewritten after download: its bytes are not the published crate's.
  put(`registry/cache/${registry}/bad-1.0.0.crate`, 'PLANTED');
  // Planted with a lock of its own that claims the planted bytes (R-G13 review).
  put(`registry/cache/${registry}/sub-1.0.0.crate`, 'PLANTED SUB');
  put(`registry/cache/${registry}/unpinned-1.0.0.crate`, 'NOT IN ANY LOCK');
  put(`registry/cache/${registry}/mystery-1.0.0.crate`, 'UNKNOWN TO THE AUTHORITY');
  // A crate published with capitals: its file keeps them, its index path does not.
  put(`registry/cache/${registry}/Mixed-1.0.0.crate`, 'GENUINE MIXED');
  // Extracted sources, configuration and credentials never come along.
  put(`registry/src/${registry}/good-1.0.0/src/lib.rs`, 'PLANTED SOURCE');
  put('config.toml', '[build]\nrustflags = ["--cfg", "planted"]\n');
  put('credentials.toml', '[registry]\ntoken = "secret"\n');
  put('git/checkouts/dep-1/abc/src/lib.rs', 'PLANTED CHECKOUT');
  symlinkSync(f.m.workspacePath, join(shared, `registry/index/${registry}/linked`));
  // A FIFO in the index would block a copy that opens it for good (R-G13 review).
  expect(spawnSync('mkfifo', [join(shared, `registry/index/${registry}/fifo`)]).status).toBe(0);
  // Git dependencies: a database as fetched, one with an object rewritten after the fetch, and
  // one no lock names.
  const gitDb = (name: string) => {
    const source = join(f.root, `${name}-source`);
    mkdirSync(source);
    writeFileSync(join(source, 'lib.rs'), `pub fn ${name.replace('-', '_')}() {}\n`);
    expect(spawnSync(hostGit(), ['init', '-q', '-b', 'main'], { cwd: source }).status).toBe(0);
    commitAll(source);
    const db = join(shared, 'git/db', name);
    expect(spawnSync(hostGit(), ['clone', '-q', '--bare', source, db]).status).toBe(0);
    return {
      db,
      commit: spawnSync(hostGit(), ['rev-parse', 'HEAD'], {
        cwd: db,
        encoding: 'utf8',
      }).stdout.trim(),
    };
  };
  const good = gitDb('dep-good');
  const forged = gitDb('dep-forged');
  gitDb('dep-unlocked');
  const blob = spawnSync(hostGit(), ['rev-parse', 'HEAD:lib.rs'], {
    cwd: forged.db,
    encoding: 'utf8',
  }).stdout.trim();
  const object = join(forged.db, 'objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, deflateSync(Buffer.from('blob 7\0forged\n')));
  writeFileSync(
    join(f.m.workspacePath, 'Cargo.lock'),
    lockOf([
      { name: 'good', version: '1.0.0', checksum: sha256('GENUINE GOOD') },
      { name: 'bad', version: '1.0.0', checksum: sha256('GENUINE BAD') },
      { name: 'mystery', version: '1.0.0', checksum: sha256('UNKNOWN TO THE AUTHORITY') },
      { name: 'Mixed', version: '1.0.0', checksum: sha256('GENUINE MIXED') },
      // Never downloaded: the registry is not asked about it.
      { name: 'absent', version: '1.0.0', checksum: sha256('NOWHERE') },
      {
        name: 'dep-good',
        version: '0.1.0',
        source: `git+https://example.invalid/good#${good.commit}`,
      },
      {
        name: 'dep-forged',
        version: '0.1.0',
        source: `git+https://example.invalid/forged#${forged.commit}`,
      },
    ]),
  );
  mkdirSync(join(f.m.workspacePath, 'tests/fixtures/old'), { recursive: true });
  writeFileSync(
    join(f.m.workspacePath, 'tests/fixtures/old/Cargo.lock'),
    lockOf([{ name: 'sub', version: '1.0.0', checksum: sha256('PLANTED SUB') }]),
  );
  commitAll(f.m.workspacePath);
  const asked: string[] = [];
  const { outcome, output, home } = await listCargoHome(
    f,
    shared,
    authority(
      {
        'good@1.0.0': sha256('GENUINE GOOD'),
        'bad@1.0.0': sha256('GENUINE BAD'),
        'sub@1.0.0': sha256('GENUINE SUB'),
        'Mixed@1.0.0': sha256('GENUINE MIXED'),
      },
      asked,
    ),
  );
  expect(asked).not.toContain('absent');
  expect(output).toContain('absent-1.0.0.crate (not downloaded)');
  expect(output).toContain('./ct-verified/Mixed-1.0.0.crate');
  expect(output).toContain('./ct-verified/index/mi/xe/mixed');
  expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
  expect(output).toContain(`home=${home} offline=true`);
  // A local registry of published index entries and matching downloads, and nothing else.
  expect(output).toContain('./ct-verified/good-1.0.0.crate');
  expect(output).toContain('./ct-verified/index/go/od/good');
  expect(output).toContain('./git/db/dep-good/HEAD');
  expect(output).toContain('replace-with = "ct-verified"');
  expect(output).toContain('offline = true');
  for (const absent of [
    './registry',
    './ct-verified/index/3/b/bad',
    './ct-verified/index/3/s/sub',
    'bad-1.0.0.crate\n',
    'sub-1.0.0.crate\n',
    'mystery-1.0.0.crate\n',
    'unpinned',
    'rustflags',
    'credentials',
    'git/checkouts',
    'linked',
    'fifo',
    './git/db/dep-forged',
    'dep-unlocked',
  ])
    expect(output).not.toContain(absent);
  for (const reason of [
    'bad-1.0.0.crate (does not match its published checksum)',
    'sub-1.0.0.crate (does not match its published checksum)',
    'mystery-1.0.0.crate (its published checksum could not be learned)',
    'git/db/dep-forged (its objects do not match their names)',
  ])
    expect(output).toContain(reason);
  // The check's home is gone once it ends; the shared home is untouched.
  expect(existsSync(home)).toBe(false);
  expect(readFileSync(join(shared, `registry/cache/${registry}/bad-1.0.0.crate`), 'utf8')).toBe(
    'PLANTED',
  );
  // Without an authority, no registry crate reaches the check.
  const none = await listCargoHome(f, shared);
  expect(none.output).not.toContain('./ct-verified/good-1.0.0.crate');
  expect(none.output).toContain('good-1.0.0.crate (its published checksum could not be learned)');
});

it('reads only a regular file within its limit, never waiting on a FIFO or following a link (R-G13 review)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-read-regular-'));
  roots.push(root);
  writeFileSync(join(root, 'file'), 'content');
  writeFileSync(join(root, 'large'), Buffer.alloc(2048));
  symlinkSync(join(root, 'file'), join(root, 'link'));
  // An agent can swap a file for a FIFO after it was listed; opening it must not wait.
  expect(spawnSync('mkfifo', [join(root, 'fifo')]).status).toBe(0);
  const started = Date.now();
  expect(await readRegular(join(root, 'fifo'), 1024)).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(2000);
  expect((await readRegular(join(root, 'file'), 1024))?.toString()).toBe('content');
  expect(await readRegular(join(root, 'large'), 1024)).toBeUndefined();
  expect(await readRegular(join(root, 'link'), 1024)).toBeUndefined();
  expect(await readRegular(join(root, 'absent'), 1024)).toBeUndefined();
}, 10_000);

it('a lock that is a FIFO, or too many locks, never block or exhaust the daemon (R-G13 review)', async () => {
  const f = fixture();
  const shared = join(f.root, 'shared-cargo');
  mkdirSync(join(shared, 'registry', 'index'), { recursive: true });
  // Untracked and not ignored, so it is listed; opening it must not wait for a writer.
  expect(spawnSync('mkfifo', [join(f.m.workspacePath, 'Cargo.lock')]).status).toBe(0);
  const started = Date.now();
  const { outcome, output } = await listCargoHome(f, shared, authority({}));
  expect(outcome.exitCode, output).toBe(0);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(output).toContain('No Cargo.lock in the checked tree');
}, 20_000);

it('reads at most 64 locks and says how many it left out (R-G13 review)', async () => {
  const f = fixture();
  const shared = join(f.root, 'shared-cargo');
  mkdirSync(join(shared, 'registry', 'index'), { recursive: true });
  writeFileSync(join(f.m.workspacePath, 'Cargo.lock'), lockOf([]));
  for (let i = 0; i < 65; i++) {
    mkdirSync(join(f.m.workspacePath, `crates/c${i}`), { recursive: true });
    writeFileSync(join(f.m.workspacePath, `crates/c${i}/Cargo.lock`), lockOf([]));
  }
  commitAll(f.m.workspacePath);
  const { outcome, output } = await listCargoHome(f, shared, authority({}));
  expect(outcome.exitCode, output).toBe(0);
  expect(output).toContain('2 Cargo.lock files were not read');
});

it('says so when the checked tree has no lock, since no registry crate can then be verified (R-G13 review)', async () => {
  const f = fixture();
  const shared = join(f.root, 'shared-cargo');
  mkdirSync(join(shared, 'registry', 'index'), { recursive: true });
  const { outcome, output } = await listCargoHome(f, shared, authority({}));
  expect(outcome.exitCode).toBe(0);
  expect(output).toContain('No Cargo.lock in the checked tree');
});

const cachedItoa = join(
  homedir(),
  '.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/itoa-1.0.18.crate',
);
it.skipIf(!hostCargo || !existsSync(cachedItoa))(
  'a planted source, a rewritten download, or a lock and index rewritten to vouch for a planted crate never build in a check (R-G13 review)',
  { timeout: 120_000 },
  async () => {
    const f = fixture();
    const shared = join(f.root, 'shared-cargo');
    const registry = 'index.crates.io-1949cf8c6b5b557f';
    for (const part of ['index', `cache/${registry}`])
      mkdirSync(join(shared, 'registry', part), { recursive: true });
    spawnSync('cp', [
      '-r',
      join(homedir(), '.cargo/registry/index', registry),
      join(shared, 'registry/index'),
    ]);
    spawnSync('cp', [cachedItoa, join(shared, 'registry/cache', registry)]);
    const published = sha256(readFileSync(cachedItoa));
    const crateRegistry = authority({ 'itoa@1.0.18': published });
    writeFileSync(
      join(f.m.workspacePath, 'Cargo.toml'),
      '[package]\nname = "consumer"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nitoa = "=1.0.18"\n',
    );
    mkdirSync(join(f.m.workspacePath, 'src'));
    writeFileSync(
      join(f.m.workspacePath, 'src/lib.rs'),
      'pub fn f() -> String { itoa::Buffer::new().format(1).to_owned() }\n',
    );
    const env = {
      ...process.env,
      CARGO_HOME: shared,
      CARGO_TARGET_DIR: join(f.root, 'lock-target'),
    };
    expect(
      spawnSync(hostCargo!, ['generate-lockfile', '--offline'], { cwd: f.m.workspacePath, env })
        .status,
    ).toBe(0);
    commitAll(f.m.workspacePath);
    // Cargo extracts the dependency into the shared home, as an agent's build would, and an
    // agent then plants a line in the extracted source, which Cargo never checks again.
    expect(
      spawnSync(hostCargo!, ['build', '--offline'], { cwd: f.m.workspacePath, env }).status,
    ).toBe(0);
    const extracted = join(shared, 'registry/src', registry, 'itoa-1.0.18', 'src/lib.rs');
    writeFileSync(extracted, `${readFileSync(extracted, 'utf8')}\ncompile_error!("PLANTED");\n`);
    const plantedBuild = spawnSync(hostCargo!, ['build', '--offline'], {
      cwd: f.m.workspacePath,
      env: { ...env, CARGO_TARGET_DIR: join(f.root, 'plant-target') },
      encoding: 'utf8',
    });
    expect(plantedBuild.stderr).toContain('PLANTED');
    const build = async (args = ['build', '--offline', '--locked']) => {
      let output = '';
      const outcome = await executeCheck({
        tool: 'ct-check',
        privateDirectory: join(f.root, `daemon-private-${Date.now()}`),
        manifestPath: f.launcher.manifestPath,
        manifestDigest: f.launcher.manifestDigest,
        manifest: f.launcher.manifest,
        args: ['--', hostCargo!, ...args],
        logPath: join(f.root, 'daemon-logs', `${Date.now()}.log`),
        logReference: 'check-logs/run/build.log',
        confinement: 'none',
        unitName: 'unused',
        writablePaths: [f.m.workspacePath, join(shared, 'registry'), join(shared, 'git')],
        environment: {
          PATH: process.env.PATH ?? '/usr/bin',
          HOME: homedir(),
          CARGO_HOME: shared,
          CARGO_TARGET_DIR: join(f.root, 'check-target'),
        },
        onOutput: (text) => (output += text),
        signal: new AbortController().signal,
        crateRegistry,
        cargoHomeDirectory: join(f.root, 'check-logs', 'cargo-home-0'),
      });
      return { outcome, output };
    };
    const planted = await build();
    expect(planted.outcome.exitCode, planted.output).toBe(0);
    expect(planted.output).not.toContain('PLANTED');
    // A second check reuses the first's build outputs: its Cargo home has the same path.
    const again = await build();
    expect(again.outcome.exitCode, again.output).toBe(0);
    expect(again.output).not.toContain('Compiling itoa');
    // A crate replaced by planted bytes, and a lock and index rewritten to claim them.
    const crate = join(shared, 'registry/cache', registry, 'itoa-1.0.18.crate');
    const work = join(f.root, 'repack');
    mkdirSync(work);
    expect(spawnSync('tar', ['-xzf', crate, '-C', work]).status).toBe(0);
    writeFileSync(
      join(work, 'itoa-1.0.18/src/lib.rs'),
      `${readFileSync(join(work, 'itoa-1.0.18/src/lib.rs'), 'utf8')}\ncompile_error!("PLANTED CRATE");\n`,
    );
    expect(spawnSync('tar', ['-czf', crate, '-C', work, 'itoa-1.0.18']).status).toBe(0);
    const planted256 = sha256(readFileSync(crate));
    const lock = join(f.m.workspacePath, 'Cargo.lock');
    writeFileSync(lock, readFileSync(lock, 'utf8').replace(published, planted256));
    const indexEntry = join(shared, 'registry/index', registry, '.cache/it/oa/itoa');
    if (existsSync(indexEntry))
      writeFileSync(
        indexEntry,
        Buffer.from(
          readFileSync(indexEntry).toString('latin1').replaceAll(published, planted256),
          'latin1',
        ),
      );
    commitAll(f.m.workspacePath);
    // Asked to build online, it still fetches nothing.
    const vouched = await build(['build', '--locked']);
    expect(vouched.outcome.exitCode).not.toBe(0);
    expect(vouched.output).not.toContain('PLANTED CRATE');
    expect(vouched.output).toContain('itoa-1.0.18.crate (does not match its published checksum)');
    // A committed Cargo configuration that points crates.io at planted sources in the shared
    // index finds nothing there: the check's home copies none of it (R-G13 review).
    const vendor = join(shared, 'registry/index/x/vendor/itoa-1.0.18');
    mkdirSync(join(vendor, 'src'), { recursive: true });
    writeFileSync(join(vendor, 'src/lib.rs'), 'compile_error!("PLANTED VIA INDEX");\n');
    writeFileSync(
      join(vendor, 'Cargo.toml'),
      '[package]\nname = "itoa"\nversion = "1.0.18"\nedition = "2018"\n[lib]\npath = "src/lib.rs"\n',
    );
    writeFileSync(
      join(vendor, '.cargo-checksum.json'),
      JSON.stringify({ files: {}, package: published }),
    );
    writeFileSync(lock, readFileSync(lock, 'utf8').replace(planted256, published));
    mkdirSync(join(f.m.workspacePath, '.cargo'));
    writeFileSync(
      join(f.m.workspacePath, '.cargo/config.toml'),
      `[source.crates-io]\nreplace-with = "planted"\n[source.planted]\ndirectory = ${JSON.stringify(join(f.root, 'check-logs', 'cargo-home-0', 'registry/index/x/vendor'))}\n`,
    );
    commitAll(f.m.workspacePath);
    const redirected = await build();
    expect(redirected.output).not.toContain('PLANTED VIA INDEX');
    expect(redirected.outcome.exitCode).not.toBe(0);
  },
);

itConfines(
  'a confined check cannot see the shared Cargo home, only its own (operator decision 2026-09-29)',
  async () => {
    const f = fixture();
    const shared = join(f.root, 'shared-cargo');
    mkdirSync(join(shared, 'registry', 'src'), { recursive: true });
    writeFileSync(join(shared, 'registry', 'src', 'planted.rs'), 'PLANTED');
    const script = `
      const fs = require('node:fs');
      try { fs.readFileSync(${JSON.stringify(join(shared, 'registry', 'src', 'planted.rs'))}); console.log('shared-read'); }
      catch { console.log('shared-hidden'); }
      console.log('home', process.env.CARGO_HOME);
    `;
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      privateDirectory: join(f.root, 'daemon-private'),
      manifestPath: f.launcher.manifestPath,
      manifestDigest: f.launcher.manifestDigest,
      manifest: f.launcher.manifest,
      args: ['--', process.execPath, '-e', script],
      logPath: join(f.root, 'daemon-logs', 'shared.log'),
      logReference: 'check-logs/run/shared.log',
      confinement: 'systemd',
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      writablePaths: [f.m.workspacePath, join(shared, 'registry'), join(shared, 'git')],
      environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir(), CARGO_HOME: shared },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
    });
    expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
    expect(output).toContain('shared-hidden');
    expect(output).toContain(`home ${join(f.root, 'daemon-private', 'cargo-home')}`);
  },
);

itConfines(
  "a declared check's unit sees no root agents write, of any run, only its own paths (R-G13 review)",
  async () => {
    const f = fixture();
    const data = join(f.root, 'data');
    const secret = join(data, 'runs', 'other-run', 'planted.rs');
    mkdirSync(join(secret, '..'), { recursive: true });
    writeFileSync(secret, 'PLANTED');
    // Shared memory and the repository's Git directory are writable by agents too.
    const shm = `/dev/shm/ct-check-test-${process.pid}`;
    writeFileSync(shm, 'PLANTED');
    const manifest: PinnedCargoManifest = {
      ...f.m,
      declaredChecks: {
        declarationId: randomUUID(),
        version: 1,
        checks: [
          {
            id: 'peek',
            argv: [
              'sh',
              '-c',
              `cat ${secret} 2>/dev/null || echo hidden; cat ${shm} 2>/dev/null || echo shm-hidden; cat ${join(f.m.gitCommonDirectory!, 'HEAD')} 2>/dev/null || echo git-hidden; echo own > own.txt && echo wrote`,
            ],
            definitionPaths: [],
            definitionDigests: {},
          },
        ],
      },
    };
    const launcher = f.launch(manifest);
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      privateDirectory: join(data, 'check-logs', 'run', 'x.private'),
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args: ['--declared', 'peek'],
      logPath: join(data, 'check-logs', 'run', 'peek.log'),
      logReference: 'check-logs/run/peek.log',
      confinement: 'systemd',
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      writablePaths: [f.m.workspacePath],
      environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir() },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      declaredTargetDirectory: join(data, 'check-logs', 'run', 'declared-target'),
      hiddenRoots: [data],
    });
    expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
    rmSync(shm, { force: true });
    expect(output).toContain('hidden');
    expect(output).toContain('shm-hidden');
    expect(output).toContain('git-hidden');
    expect(output).not.toContain('PLANTED');
    expect(output).toContain('wrote');
  },
);

itConfines(
  "a check cannot reach the user's service manager to start a unit outside its confinement (R-G13 review)",
  async () => {
    const f = fixture();
    const uid = process.getuid?.() ?? 1000;
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      privateDirectory: join(f.root, 'daemon-private'),
      manifestPath: f.launcher.manifestPath,
      manifestDigest: f.launcher.manifestDigest,
      manifest: f.launcher.manifest,
      args: [
        '--',
        'sh',
        '-c',
        `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus XDG_RUNTIME_DIR=/run/user/${uid} systemd-run --user --wait --quiet --pipe --collect true 2>/dev/null && echo escaped || echo contained`,
      ],
      logPath: join(f.root, 'daemon-logs', 'escape.log'),
      logReference: 'check-logs/run/escape.log',
      confinement: 'systemd',
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      writablePaths: [f.m.workspacePath],
      environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir() },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
    });
    expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
    expect(output).toContain('contained');
    expect(output).not.toContain('escaped');
  },
);

it("a declared check's clone carries the repository's tags, which checks may compare with fixed commits (R-G13)", async () => {
  const f = fixture();
  expect(spawnSync(hostGit(), ['tag', 'project/baseline'], { cwd: f.m.workspacePath }).status).toBe(
    0,
  );
  const head = spawnSync(hostGit(), ['rev-parse', 'HEAD'], {
    cwd: f.m.workspacePath,
    encoding: 'utf8',
  }).stdout.trim();
  const manifest: PinnedCargoManifest = {
    ...f.m,
    declaredChecks: {
      declarationId: randomUUID(),
      version: 1,
      checks: [
        {
          id: 'baseline',
          argv: ['git', 'rev-parse', 'refs/tags/project/baseline^{commit}'],
          definitionPaths: [],
          definitionDigests: {},
        },
      ],
    },
  };
  const launcher = f.launch(manifest);
  let output = '';
  const outcome = await executeCheck({
    tool: 'ct-check',
    privateDirectory: join(f.root, 'daemon-private'),
    manifestPath: launcher.manifestPath,
    manifestDigest: launcher.manifestDigest,
    manifest: launcher.manifest,
    args: ['--declared', 'baseline'],
    logPath: join(f.root, 'daemon-logs', 'tag.log'),
    logReference: 'check-logs/run/tag.log',
    confinement: 'none',
    unitName: 'unused',
    writablePaths: [f.m.workspacePath],
    environment: { PATH: process.env.PATH ?? '/usr/bin' },
    onOutput: (text) => (output += text),
    signal: new AbortController().signal,
    declaredTargetDirectory: join(f.root, 'declared-target'),
  });
  expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
  expect(output).toContain(head);
});

/**
 * R-G13 increment 2: a pinned Cargo build compiles a daemon-private clone of the reviewed commit
 * against daemon-private, verified checkouts of the pinned upstreams, into a target per commit.
 */
function pinnedBuildFixture() {
  const f = fixture();
  const git = (args: string[], cwd: string) => {
    const r = spawnSync(hostGit(), args, { cwd, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const commit = (cwd: string, message: string) =>
    git(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', message], cwd);
  writeFileSync(join(f.m.workspacePath, 'marker.txt'), 'committed\n');
  git(['add', '.'], f.m.workspacePath);
  commit(f.m.workspacePath, 'marker');
  const head = git(['rev-parse', 'HEAD'], f.m.workspacePath);
  const upstream = join(f.root, 'upstream');
  mkdirSync(join(upstream, 'crate', 'src'), { recursive: true });
  writeFileSync(join(upstream, 'crate', 'Cargo.toml'), '[package]\nname = "up-crate"\n');
  writeFileSync(join(upstream, 'crate', 'src', 'lib.rs'), 'genuine\n');
  git(['init', '-q', '-b', 'main'], upstream);
  git(['add', '.'], upstream);
  commit(upstream, 'upstream');
  const pinned = git(['rev-parse', 'HEAD'], upstream);
  const tree = git(['rev-parse', 'HEAD^{tree}'], upstream);
  // The run's own copy, which the agent can write; the daemon must not build from it.
  const copy = join(f.root, 'run', 'scratch', 'dependencies', 'source-0', 'crate');
  mkdirSync(join(copy, 'src'), { recursive: true });
  writeFileSync(join(copy, 'src', 'lib.rs'), 'agent copy\n');
  const cargo = join(f.root, 'fake-cargo.mjs');
  // Resolves the supplied package from the configuration it is given; a build reports where it
  // ran and what it read.
  writeFileSync(
    cargo,
    `#!${process.execPath}
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = args.includes('--config') ? args[args.indexOf('--config') + 1] : undefined;
const path = config && /path = "([^"]+)"/.exec(readFileSync(config, 'utf8'))?.[1];
if (args[0] === '--version') console.log('cargo 1.0.0 (fixture)');
else if (args[0] === 'metadata')
  console.log(JSON.stringify({ packages: [{ id: 'up', name: 'up-crate', manifest_path: path + '/Cargo.toml', source: null }], resolve: { nodes: [{ id: 'up' }] } }));
else {
  console.log('cwd=' + process.cwd());
  console.log('target=' + process.env.CARGO_TARGET_DIR);
  console.log('marker=' + readFileSync('marker.txt', 'utf8').trim());
  console.log('upstream=' + readFileSync(path + '/src/lib.rs', 'utf8').trim());
}
`,
    { mode: 0o700 },
  );
  const pins = `[patch.crates-io]\n"up-crate" = { path = ${JSON.stringify(copy)} }\n`;
  writeFileSync(f.m.configPath, pins);
  const manifest = (treeSha = tree): PinnedCargoManifest => ({
    ...f.m,
    configDigest: hash(pins),
    cargoExecutable: cargo,
    verification: {
      version: 1,
      mode: 'current-upstream-build',
      scope: { kind: 'slice', definitionId: 'd', bindingRevision: 1, sourceId: 'contracts' },
      reason: 'Integration fixture',
    },
    packages: [{ name: 'up-crate', path: copy }],
    dependencySources: [
      {
        alias: 'up',
        commitSha: pinned,
        treeSha,
        gitDirectory: join(upstream, '.git'),
        packages: [{ name: 'up-crate', path: 'crate' }],
      },
    ],
  });
  const build = async (m: PinnedCargoManifest, args = ['test', '--offline']) => {
    const launcher = f.launch(m);
    let output = '';
    const outcome = await executeCheck({
      tool: 'cargo',
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args,
      logPath: join(f.root, 'daemon-logs', `${randomUUID()}.log`),
      logReference: 'check-logs/run/cargo.log',
      privateDirectory: join(f.root, 'check-logs', 'run', 'daemon.private'),
      declaredTargetDirectory: join(f.root, 'check-logs', 'run', 'declared-target'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [f.m.workspacePath],
      environment: { PATH: process.env.PATH ?? '/usr/bin' },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
    });
    return { outcome, output };
  };
  return { f, git, head, upstream, pinned, copy, manifest, build };
}

it('builds a pinned Cargo request from private clones of the reviewed commit and the pinned upstreams, into a target per commit (R-G13 increment 2)', async () => {
  const p = pinnedBuildFixture();
  // A change the agent hides from the clean check does not reach the build.
  p.git(['update-index', '--skip-worktree', 'marker.txt'], p.f.m.workspacePath);
  writeFileSync(join(p.f.m.workspacePath, 'marker.txt'), 'agent change\n');
  const { outcome, output } = await p.build(p.manifest());
  expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
  const privateDirectory = join(p.f.root, 'check-logs', 'run', 'daemon.private');
  expect(output).toContain(`cwd=${join(privateDirectory, 'tree')}`);
  expect(output).toContain(
    `target=${join(p.f.root, 'check-logs', 'run', 'declared-target', p.head)}`,
  );
  expect(output).toContain('marker=committed');
  expect(output).toContain('upstream=genuine');
  expect(outcome.receipt).toMatchObject({
    recordedBy: 'daemon',
    success: true,
    clean: true,
    headSha: p.head,
    // Named as the run's manifest names them.
    packages: [{ name: 'up-crate', path: p.copy }],
  });
  expect(outcome.receipt).not.toHaveProperty('kind');
  // Neither private clone is left once the check ends.
  expect(existsSync(join(privateDirectory, 'tree'))).toBe(false);
  expect(existsSync(join(privateDirectory, 'pinned'))).toBe(false);
  // Uncommitted work, which no gate accepts, still builds in the worktree: the agent's own loop.
  p.git(['update-index', '--no-skip-worktree', 'marker.txt'], p.f.m.workspacePath);
  const dirty = await p.build(p.manifest());
  expect(dirty.output).toContain(`cwd=${p.f.m.workspacePath}`);
  expect(dirty.output).toContain('marker=agent change');
  expect(dirty.output).toContain('upstream=agent copy');
  expect(dirty.outcome.receipt).toMatchObject({ clean: false });
});

it('fails a pinned build whose upstream commit does not hold the pinned tree, or whose objects were rewritten (R-G13 increment 2)', async () => {
  const p = pinnedBuildFixture();
  const other = await p.build(p.manifest('0'.repeat(40)));
  expect(other.outcome.exitCode).toBe(1);
  expect(other.outcome.diagnostic).toContain('pinned');
  // A package path that leaves its source is refused.
  const base = p.manifest();
  const escaping = await p.build({
    ...base,
    dependencySources: base.dependencySources!.map((s) => ({
      ...s,
      packages: [{ name: 'up-crate', path: '../../run' }],
    })),
  });
  expect(escaping.outcome.diagnostic).toContain('outside its source');
  // Nor may the build name a manifest outside the reviewed commit, such as the live worktree's.
  const live = await p.build(p.manifest(), [
    'test',
    '--manifest-path',
    join(p.f.m.workspacePath, 'Cargo.toml'),
  ]);
  expect(live.outcome.diagnostic).toContain('outside the reviewed commit');
  // Nor through a committed link to it.
  symlinkSync(p.f.m.workspacePath, join(p.f.m.workspacePath, 'live'));
  p.git(['add', 'live'], p.f.m.workspacePath);
  p.git(
    ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'link'],
    p.f.m.workspacePath,
  );
  const linked = await p.build(p.manifest(), ['test', '--manifest-path', 'live/Cargo.toml']);
  expect(
    linked.outcome.diagnostic,
    linked.output + JSON.stringify(linked.outcome.receipt),
  ).toContain('outside the reviewed commit');
  const blob = p.git(['rev-parse', `${p.pinned}:crate/src/lib.rs`], p.upstream);
  const object = join(p.upstream, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, deflateSync(Buffer.from('blob 7\0forged\n')));
  const forged = await p.build(p.manifest());
  expect(forged.outcome.exitCode, forged.output).toBe(1);
  expect(forged.output).not.toContain('upstream=forged');
});

itConfines(
  "a pinned build's unit reads its private sources read-only and sees none of the roots agents write (R-G13 increment 2)",
  async () => {
    const p = pinnedBuildFixture();
    const data = join(p.f.root, 'data');
    const secret = join(data, 'runs', 'other-run', 'planted.rs');
    mkdirSync(join(secret, '..'), { recursive: true });
    writeFileSync(secret, 'PLANTED');
    // A program the unit can run: a shell script in a directory of its own.
    const bin = join(p.f.root, 'cargo-bin');
    mkdirSync(bin);
    const cargo = join(bin, 'cargo');
    writeFileSync(
      cargo,
      `#!/bin/sh
config=""; previous=""
for argument in "$@"; do [ "$previous" = "--config" ] && config="$argument"; previous="$argument"; done
path=""; [ -n "$config" ] && path=$(sed -n 's/.*path = "\\(.*\\)".*/\\1/p' "$config" | head -n 1)
case "$1" in
  --version) echo "cargo 1.0.0 (fixture)";;
  metadata) printf '{"packages":[{"id":"up","name":"up-crate","manifest_path":"%s/Cargo.toml","source":null}],"resolve":{"nodes":[{"id":"up"}]}}\\n' "$path";;
  *)
    echo "upstream=$(cat "$path/src/lib.rs")"
    cat ${secret} 2>/dev/null || echo data-hidden
    cat ${join(p.f.m.workspacePath, 'marker.txt')} 2>/dev/null || echo worktree-hidden
    cat ${join(p.copy, 'src', 'lib.rs')} 2>/dev/null || echo copy-hidden
    (echo forged > "$path/src/lib.rs") 2>/dev/null && echo pinned-writable || echo pinned-read-only;;
esac
`,
      { mode: 0o700 },
    );
    const launcher = p.f.launch({ ...p.manifest(), cargoExecutable: cargo });
    let output = '';
    const outcome = await executeCheck({
      tool: 'cargo',
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args: ['test', '--offline'],
      logPath: join(data, 'check-logs', 'run', 'pinned.log'),
      logReference: 'check-logs/run/pinned.log',
      privateDirectory: join(data, 'check-logs', 'run', 'x.private'),
      declaredTargetDirectory: join(data, 'check-logs', 'run', 'declared-target'),
      confinement: 'systemd',
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      writablePaths: [p.f.m.workspacePath],
      environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir() },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      hiddenRoots: [data, join(p.f.root, 'run')],
    });
    expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
    expect(output).toContain('upstream=genuine');
    expect(output).toContain('data-hidden');
    expect(output).toContain('worktree-hidden');
    expect(output).toContain('copy-hidden');
    expect(output).toContain('pinned-read-only');
    expect(output).not.toContain('PLANTED');
  },
);

const overlayCases = [['none'], ['systemd']] as const;
it.each(overlayCases)(
  "a current-upstream gate's adopted check builds against private checkouts of the pins, patched in above its clone (R-G13 increment 2; confinement %s)",
  async (confinement) => {
    if (confinement === 'systemd' && !['running', 'degraded'].includes(userManager ?? '')) return;
    const p = pinnedBuildFixture();
    const manifest: PinnedCargoManifest = {
      ...p.manifest(),
      declaredChecks: {
        declarationId: randomUUID(),
        version: 1,
        checks: [
          {
            id: 'peek',
            argv: [
              'sh',
              '-c',
              'path=$(sed -n \'s/.*path = "\\(.*\\)".*/\\1/p\' ../.cargo/config.toml); echo "patched=$path"; cat "$path/src/lib.rs"; (echo x > ../.cargo/config.toml) 2>/dev/null && echo overlay-writable || echo overlay-read-only',
            ],
            definitionPaths: [],
            definitionDigests: {},
          },
        ],
      },
    };
    const launcher = p.f.launch(manifest);
    const privateDirectory = join(p.f.root, 'check-logs', 'run', 'peek.private');
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args: ['--declared', 'peek'],
      logPath: join(p.f.root, 'daemon-logs', 'peek.log'),
      logReference: 'check-logs/run/peek.log',
      privateDirectory,
      declaredTargetDirectory: join(p.f.root, 'check-logs', 'run', 'declared-target'),
      confinement,
      unitName: `craftingtable-check-test-${process.pid}-${Date.now()}`,
      writablePaths: [p.f.m.workspacePath],
      environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir() },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
      hiddenRoots: [join(p.f.root, 'check-logs'), join(p.f.root, 'run')],
    });
    expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
    expect(output).toContain(`patched=${join(privateDirectory, 'pinned', 'source-0', 'crate')}`);
    expect(output).toContain('overlay-read-only');
    expect(output).toContain('genuine');
    expect(output).not.toContain('agent copy');
    expect(outcome.receipt).toMatchObject({
      kind: 'scoped-check',
      verificationMode: 'current-upstream-build',
      declaredCheck: { id: 'peek' },
    });
    expect(existsSync(join(privateDirectory, '.cargo'))).toBe(false);
    expect(existsSync(join(privateDirectory, 'pinned'))).toBe(false);
  },
);

it.skipIf(!hostCargo).each([
  ['a legacy .cargo/config', 'legacy'],
  ['a patch in the root .cargo/config.toml', 'root'],
  ['a nested .cargo/config.toml', 'nested'],
  ['a linked .cargo directory', 'linked'],
  ['no patch of its own', 'none'],
] as const)(
  "a current-upstream gate's adopted check that could build a vendored pin is refused: %s (R-G13 increment 2 review)",
  async (_label, planted) => {
    const p = pinnedBuildFixture();
    // A real crate upstream and a consumer that prints which copy it built.
    writeFileSync(
      join(p.upstream, 'crate', 'Cargo.toml'),
      '[package]\nname = "up-crate"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    writeFileSync(join(p.upstream, 'crate', 'src', 'lib.rs'), 'pub const WHO: &str = "genuine";\n');
    p.git(['add', '.'], p.upstream);
    p.git(
      ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'real'],
      p.upstream,
    );
    const pinned = p.git(['rev-parse', 'HEAD'], p.upstream);
    const ws = p.f.m.workspacePath;
    writeFileSync(
      join(ws, 'Cargo.toml'),
      '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nup-crate = "0.1"\n',
    );
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'main.rs'), 'fn main() { println!("WHO={}", up_crate::WHO); }\n');
    mkdirSync(join(ws, 'vendor', 'up-crate', 'src'), { recursive: true });
    writeFileSync(
      join(ws, 'vendor', 'up-crate', 'Cargo.toml'),
      '[package]\nname = "up-crate"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    writeFileSync(
      join(ws, 'vendor', 'up-crate', 'src', 'lib.rs'),
      'pub const WHO: &str = "planted";\n',
    );
    mkdirSync(join(ws, '.cargo'), { recursive: true });
    const patch = '[patch.crates-io]\nup-crate = { path = "vendor/up-crate" }\n';
    writeFileSync(join(ws, '.cargo', 'config.toml'), planted === 'root' ? patch : '# adopted\n');
    if (planted === 'legacy') writeFileSync(join(ws, '.cargo', 'config'), patch);
    if (planted === 'nested' || planted === 'linked') {
      mkdirSync(join(ws, 'sub', 'cfg'), { recursive: true });
      if (planted === 'nested') {
        mkdirSync(join(ws, 'sub', '.cargo'));
        writeFileSync(join(ws, 'sub', '.cargo', 'config.toml'), patch);
      } else {
        writeFileSync(join(ws, 'sub', 'cfg', 'config'), patch);
        symlinkSync('cfg', join(ws, 'sub', '.cargo'));
      }
    }
    p.git(['add', '.'], ws);
    p.git(['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'consumer'], ws);
    const launcher = p.f.launch({
      ...p.manifest(),
      cargoExecutable: hostCargo!,
      dependencySources: [
        {
          alias: 'up',
          commitSha: pinned,
          gitDirectory: join(p.upstream, '.git'),
          packages: [{ name: 'up-crate', path: 'crate' }],
        },
      ],
      declaredChecks: {
        declarationId: randomUUID(),
        version: 1,
        checks: [
          {
            id: 'run',
            argv: ['cargo', 'run', '--offline', '-q'],
            definitionPaths: ['.cargo/config.toml'],
            definitionDigests: {},
          },
        ],
      },
    });
    let output = '';
    const outcome = await executeCheck({
      tool: 'ct-check',
      manifestPath: launcher.manifestPath,
      manifestDigest: launcher.manifestDigest,
      manifest: launcher.manifest,
      args: ['--declared', 'run'],
      logPath: join(p.f.root, 'daemon-logs', 'vendored.log'),
      logReference: 'check-logs/run/vendored.log',
      privateDirectory: join(p.f.root, 'check-logs', 'run', 'vendored.private'),
      declaredTargetDirectory: join(p.f.root, 'check-logs', 'run', 'declared-target'),
      confinement: 'none',
      unitName: 'unused',
      writablePaths: [ws],
      environment: { PATH: process.env.PATH ?? '/usr/bin', HOME: homedir() },
      onOutput: (text) => (output += text),
      signal: new AbortController().signal,
    });
    expect(output).not.toContain('WHO=planted');
    if (planted === 'none') {
      expect(outcome.exitCode, output + outcome.diagnostic).toBe(0);
      expect(output).toContain('WHO=genuine');
    } else {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.diagnostic).toMatch(
        planted === 'root' ? /Refusing unpinned up-crate/ : /Cargo configuration other than/,
      );
    }
  },
  120_000,
);
