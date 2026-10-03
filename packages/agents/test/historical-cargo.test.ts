import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hostCargo } from './host-tools-test-support.js';
import {
  cargoManifestDigest as hash,
  prepareHistoricalCargoLauncher,
} from '../src/pinned-cargo.js';

/** These build real crates; a host without Cargo skips them (R-I5, QA-08). */
const cargoIt = it.skipIf(hostCargo === undefined);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(badTest = false, allowProvider = true) {
  const root = mkdtempSync(join(tmpdir(), 'ct-historical-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  const provider = join(root, 'provider');
  for (const path of [consumer, provider]) mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(
    join(provider, 'Cargo.toml'),
    '[package]\nname="historical_provider"\nversion="0.1.2"\nedition="2021"\n',
  );
  writeFileSync(join(provider, 'src/lib.rs'), 'pub fn old_api() -> u32 { 12 }\n');
  writeFileSync(
    join(consumer, 'Cargo.toml'),
    '[package]\nname="historical_consumer"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nhistorical_provider={path="../provider"}\n',
  );
  writeFileSync(
    join(consumer, 'src/lib.rs'),
    `#[test] fn baseline() { assert_eq!(historical_provider::old_api(), ${badTest ? 13 : 12}); }\n`,
  );
  const cargo = hostCargo as string;
  expect(spawnSync(cargo, ['generate-lockfile', '--offline'], { cwd: consumer }).status).toBe(0);
  const files = [
    join(consumer, 'Cargo.toml'),
    join(consumer, 'Cargo.lock'),
    join(consumer, 'src/lib.rs'),
    join(provider, 'Cargo.toml'),
    join(provider, 'src/lib.rs'),
  ].map((path) => ({ path, digest: hash(readFileSync(path)) }));
  const logs = join(root, 'evidence');
  const receiptPath = join(logs, 'commands.jsonl');
  const launcher = prepareHistoricalCargoLauncher(logs, {
    preparationId: 'baseline',
    sourceRoots: [consumer, ...(allowProvider ? [provider] : [])],
    sources: [{ alias: 'old', commitSha: 'a'.repeat(40) }],
    cargoExecutable: cargo,
    workspacePath: consumer,
    files,
    targetDirectory: join(root, 'scratch', 'target'),
    receiptPath,
    logDirectory: logs,
    timeoutMs: 30000,
  });
  return {
    consumer,
    provider,
    receiptPath,
    execute: (args: string[]) =>
      spawnSync(launcher.launcher, args, { cwd: root, encoding: 'utf8' }),
  };
}
cargoIt(
  'builds the historical sibling sources with their original lockfile without emitting current verification receipts',
  () => {
    const f = fixture();
    const lock = readFileSync(join(f.consumer, 'Cargo.lock'), 'utf8');
    const result = f.execute(['test', '--offline', '--locked']);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8').trim());
    expect(receipt).toMatchObject({
      kind: 'historical-baseline-command-v1',
      success: true,
      currentRuntimeVerification: false,
      enforcedLocked: true,
    });
    expect(receipt.runtimeId).toBeUndefined();
    expect(readFileSync(receipt.logPath, 'utf8')).toContain('1 passed');
    expect(readFileSync(join(f.consumer, 'Cargo.lock'), 'utf8')).toBe(lock);
  },
);
cargoIt('retains failed test logs and refuses source drift and configuration bypass', () => {
  const f = fixture(true);
  expect(f.execute(['test', '--offline']).status).toBe(1);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8').trim());
  expect(receipt.success).toBe(false);
  expect(readFileSync(receipt.logPath, 'utf8')).toContain('FAILED');
  expect(f.execute(['test', '--config', 'patch.crates-io.foo.path="elsewhere"']).status).toBe(1);
  writeFileSync(join(f.provider, 'src/lib.rs'), 'pub fn old_api() -> u32 { 13 }');
  const drift = f.execute(['test', '--offline']);
  expect(drift.status).toBe(1);
  expect(drift.stderr).toContain('Historical source changed');
  const receipts = readFileSync(f.receiptPath, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  expect(receipts).toHaveLength(3);
  expect(receipts.every((r) => r.currentRuntimeVerification === false && r.success === false)).toBe(
    true,
  );
});

cargoIt('rejects historical path dependencies outside the controller supplied source roots', () => {
  const f = fixture(false, false);
  const result = f.execute(['test', '--offline']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Historical dependency escaped the prepared sources');
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8').trim());
  expect(receipt.success).toBe(false);
  expect(
    receipt.resolvedPackages.some((p: { name: string }) => p.name === 'historical_provider'),
  ).toBe(true);
});
