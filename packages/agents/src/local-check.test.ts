import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  prepareCargoLauncher,
  cargoManifestDigest as hash,
  type PinnedCargoManifest,
} from './pinned-cargo.js';
import { prepareLocalCheckLaunchers, localActArguments, loadLocalCiConfig } from './local-check.js';
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
    expect(spawnSync('/usr/bin/git', args, { cwd: workspacePath }).status).toBe(0);
  const directory = join(root, 'run/dependencies');
  mkdirSync(directory, { recursive: true });
  const configPath = join(directory, 'pins.toml');
  writeFileSync(configPath, '');
  const m: PinnedCargoManifest = {
    runtimeId: 'runtime',
    runId: 'run',
    cargoExecutable: '/unused',
    gitExecutable: '/usr/bin/git',
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
  expect(args).toContain('ubuntu-latest=' + localCi.image);
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
