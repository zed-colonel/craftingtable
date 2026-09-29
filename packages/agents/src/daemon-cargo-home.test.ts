import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { syncDaemonCargoHome } from './local-check.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function put(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

it("keeps agents' Cargo downloads apart from the operator's, seeded one way (R-G5 review)", () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-cargo-home-'));
  roots.push(root);
  const operator = join(root, 'operator-cargo'),
    daemon = join(root, 'data', 'cargo-home');
  const crate = join('registry', 'src', 'index', 'itoa-1.0.0', 'src', 'lib.rs');
  put(join(operator, crate), 'pub fn itoa() {}');
  put(join(operator, 'git', 'db', 'repo', 'HEAD'), 'ref');
  put(join(operator, 'credentials.toml'), '[registry]\ntoken = "secret"');
  put(join(operator, 'config.toml'), '[net]\noffline = false');
  put(join(operator, 'bin', 'cargo'), 'binary');

  syncDaemonCargoHome(daemon, operator);
  // The caches arrive, so offline builds and agents that cannot fetch still find their crates.
  expect(readFileSync(join(daemon, crate), 'utf8')).toBe('pub fn itoa() {}');
  expect(existsSync(join(daemon, 'git', 'db', 'repo', 'HEAD'))).toBe(true);
  // Nothing else of the operator's Cargo home: no tokens, configuration or binaries.
  for (const name of ['credentials.toml', 'config.toml', 'bin'])
    expect(existsSync(join(daemon, name)), name).toBe(false);

  // What an agent writes in the daemon's copy never reaches the operator's.
  writeFileSync(join(daemon, crate), 'planted');
  put(join(daemon, 'registry', 'src', 'index', 'evil-0.1.0', 'build.rs'), 'planted');
  syncDaemonCargoHome(daemon, operator);
  expect(readFileSync(join(operator, crate), 'utf8')).toBe('pub fn itoa() {}');
  expect(existsSync(join(operator, 'registry', 'src', 'index', 'evil-0.1.0'))).toBe(false);

  // A crate the operator fetched later arrives on the next sync.
  const later = join('registry', 'src', 'index', 'ryu-1.0.0', 'lib.rs');
  put(join(operator, later), 'pub fn ryu() {}');
  syncDaemonCargoHome(daemon, operator);
  expect(readFileSync(join(daemon, later), 'utf8')).toBe('pub fn ryu() {}');

  // A host without Rust, or seeding turned off: empty caches, and nothing fails.
  for (const [name, source] of [
    ['no-rust', join(root, 'no-rust')],
    ['off', undefined],
  ] as const) {
    const bare = join(root, `bare-${name}`);
    syncDaemonCargoHome(bare, source);
    expect(existsSync(join(bare, 'registry')) && existsSync(join(bare, 'git'))).toBe(true);
  }
});
