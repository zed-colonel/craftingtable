import { expect, it } from 'vitest';
import { cargoOutsideSource, outsideSourcesNote } from '../src/outside-sources.js';

const launch = { cwd: '/work/x', prompt: 'Go' };

it('notes the sources a sandboxed launch may reach, with their hosts and caches (R-G14)', () => {
  for (const permissionMode of ['auto', 'edit-only'] as const)
    expect(
      outsideSourcesNote({
        ...launch,
        permissionMode,
        outsideSources: [cargoOutsideSource('/data/cargo-home', ['mirror.example.org'])],
      }),
    ).toBe(
      'Outside sources for sandboxed commands: cargo (hosts index.crates.io, static.crates.io, mirror.example.org; writes /data/cargo-home/registry, /data/cargo-home/git). Commands reach no other host.',
    );
});

it('notes the default `cargo` source when the launch names none, as the adapters apply it (R-G14)', () => {
  expect(
    outsideSourcesNote({
      ...launch,
      permissionMode: 'auto',
      environment: { CARGO_HOME: '/opt/cargo' },
    }),
  ).toContain('cargo (hosts index.crates.io, static.crates.io; writes /opt/cargo/registry');
});

it('notes no network with no source, none for read-only runs and no sandbox for unrestricted (R-G14)', () => {
  const sources = [cargoOutsideSource('/data/cargo-home')];
  expect(outsideSourcesNote({ ...launch, permissionMode: 'auto', outsideSources: [] })).toBe(
    'Outside sources for sandboxed commands: none. Commands reach no network.',
  );
  expect(
    outsideSourcesNote({
      ...launch,
      permissionMode: 'unrestricted',
      readOnly: true,
      outsideSources: sources,
    }),
  ).toBe('Outside sources: none, as for every read-only run.');
  expect(
    outsideSourcesNote({ ...launch, permissionMode: 'unrestricted', outsideSources: sources }),
  ).toBe(
    'Outside sources: not applied. An unrestricted run has no sandbox; its commands reach any host, with your authority.',
  );
});

it('keeps the note within a notice, however many hosts the operator lists (R-G14)', () => {
  const hosts = Array.from({ length: 400 }, (_, index) => `mirror-${index}.example.org`);
  const note = outsideSourcesNote({
    ...launch,
    permissionMode: 'auto',
    outsideSources: [cargoOutsideSource('/data/cargo-home', hosts)],
  });
  expect(Buffer.byteLength(note)).toBeLessThanOrEqual(4000);
  expect(note).toContain('mirror-0.example.org');
});
