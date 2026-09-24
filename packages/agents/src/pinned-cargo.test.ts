import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostCargo, hostGit } from './host-tools-test-support.js';
import {
  cargoManifestDigest as hash,
  type PinnedCargoManifest,
  prepareCargoLauncher,
} from './pinned-cargo.js';

/** These build real crates; a host without Cargo skips them (R-I5, QA-08). */
const cargoIt = it.skipIf(hostCargo === undefined);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ct-pinned-cargo-'));
  roots.push(root);
  const provider = join(root, 'provider'),
    consumer = join(root, 'consumer');
  mkdirSync(join(provider, 'src'), { recursive: true });
  mkdirSync(join(consumer, 'src'), { recursive: true });
  writeFileSync(
    join(provider, 'Cargo.toml'),
    '[package]\nname="ct_pin_fixture"\nversion="0.2.0"\nedition="2021"\n',
  );
  writeFileSync(join(provider, 'src/lib.rs'), 'pub fn pinned() -> u32 { 42 }\n');
  writeFileSync(
    join(consumer, 'Cargo.toml'),
    '[package]\nname="ct_consumer_fixture"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nct_pin_fixture="0.2"\n',
  );
  writeFileSync(
    join(consumer, 'src/lib.rs'),
    '#[test] fn exact_pin() { assert_eq!(ct_pin_fixture::pinned(),42); }\n',
  );
  const cargo = hostCargo as string;
  const configPath = join(root, 'config.toml');
  const config = `[patch.crates-io]\nct_pin_fixture={path=${JSON.stringify(provider)}}\n`;
  writeFileSync(configPath, config);
  const files = ['Cargo.toml', 'src/lib.rs'].map((p) => ({
    path: join(provider, p),
    digest: hash(readFileSync(join(provider, p))),
  }));
  const manifest: PinnedCargoManifest = {
    runtimeId: 'runtime',
    runId: 'run',
    cargoExecutable: cargo,
    gitExecutable: hostGit(),
    workspacePath: consumer,
    targetDirectory: join(root, 'target'),
    packages: [{ name: 'ct_pin_fixture', path: provider }],
    files,
    configPath,
    configDigest: hash(config),
    receiptPath: join(root, 'receipts.jsonl'),
  };
  const launcher = prepareCargoLauncher(join(root, 'launch'), manifest);
  const execute = (args: string[]) =>
    spawnSync(join(launcher.binDirectory, 'cargo'), args, {
      cwd: consumer,
      env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
      encoding: 'utf8',
    });
  // Materialize and commit the lockfile before collecting clean reviewed-code evidence.
  const lock = spawnSync(cargo, ['generate-lockfile', '--offline', '--config', configPath], {
    cwd: consumer,
    encoding: 'utf8',
  });
  expect(lock.status, lock.stderr).toBe(0);
  for (const args of [
    ['init', '-b', 'main'],
    ['add', '.'],
    ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture'],
  ])
    expect(spawnSync(hostGit(), args, { cwd: consumer }).status).toBe(0);
  return { root, provider, consumer, manifest, launcher, execute };
}
cargoIt(
  'actually builds against the pinned crate and records the exact clean source commit',
  () => {
    const f = fixture();
    const result = f.execute(['test', '--offline']);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(f.manifest.receiptPath, 'utf8').trim());
    expect(receipt).toMatchObject({
      success: true,
      clean: true,
      runtimeId: 'runtime',
      runId: 'run',
      packages: [{ name: 'ct_pin_fixture', path: f.provider }],
    });
    expect(receipt.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(f.execute(['test', '--config', 'patch.crates-io.x.path="elsewhere"']).status).toBe(1);
    writeFileSync(join(f.provider, 'src/lib.rs'), 'pub fn pinned() -> u32 { 0 }');
    const changed = f.execute(['test', '--offline']);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('Pinned source changed');
  },
);
cargoIt('rejects path fallback to another copy even if the crate name and version match', () => {
  const f = fixture();
  const wrong = join(f.root, 'wrong');
  mkdirSync(join(wrong, 'src'), { recursive: true });
  writeFileSync(join(wrong, 'Cargo.toml'), readFileSync(join(f.provider, 'Cargo.toml')));
  writeFileSync(join(wrong, 'src/lib.rs'), 'pub fn pinned()->u32{42}');
  writeFileSync(
    join(f.consumer, 'Cargo.toml'),
    `[package]\nname="ct_consumer_fixture"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nct_pin_fixture={path=${JSON.stringify(wrong)}}\n`,
  );
  const result = f.execute(['test', '--offline']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Refusing unpinned ct_pin_fixture');
});
cargoIt(
  'runs upstream-free supplementary checks without representing them as integration builds',
  () => {
    const f = fixture();
    const independent = join(f.consumer, 'contract');
    mkdirSync(independent);
    writeFileSync(
      join(independent, 'Cargo.toml'),
      '[package]\nname="ct_contract"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[lib]\npath="lib.rs"\n',
    );
    writeFileSync(join(independent, 'lib.rs'), '#[test] fn check_contract(){assert_eq!(2+2,4); }');
    const result = f.execute(['test', '--manifest-path', 'contract/Cargo.toml', '--offline']);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(f.manifest.receiptPath, 'utf8').trim());
    expect(receipt).toMatchObject({
      kind: 'supplementary-check',
      success: true,
      packages: [],
      runId: 'run',
    });
    writeFileSync(join(f.provider, 'src/lib.rs'), 'changed');
    expect(
      f.execute(['test', '--manifest-path', 'contract/Cargo.toml', '--offline']).stderr,
    ).toContain('Pinned source changed');
  },
);
cargoIt('fails incompatible version constraints and does not emit a passing receipt', () => {
  const f = fixture();
  const file = join(f.consumer, 'Cargo.toml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('ct_pin_fixture="0.2"', 'ct_pin_fixture="0.1"'),
  );
  const result = f.execute(['test', '--offline']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Pinned dependency resolution failed');
});
