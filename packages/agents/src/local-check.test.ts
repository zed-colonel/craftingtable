import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostGit } from './host-tools-test-support.js';
import { nativeHostDigest } from './native-environment.js';
import {
  acquireLocalCiLock,
  executeCheck,
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
