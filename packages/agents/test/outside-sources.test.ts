import { expect, it } from 'vitest';
import {
  cargoOutsideSource,
  launchSourceOverlay,
  outsideSourcesNote,
  pypiOutsideSource,
} from '../src/outside-sources.js';
import { sandboxDeniedReads, uvConfigPaths } from '../src/sandbox-reads.js';

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

const profile = {
  interpreter: '/opt/ct/python/bin/python3.12',
  version: '3.12',
  uv: { path: '/opt/ct/bin/uv', version: '0.12' },
};

it("is PyPI's index and files hosts, the daemon's uv cache, and the profile's uv and interpreter (R-G17 decisions 8 to 10)", () => {
  expect(pypiOutsideSource('/data/uv/cache', profile)).toEqual({
    kind: 'pypi',
    hosts: ['pypi.org', 'files.pythonhosted.org'],
    caches: ['/data/uv/cache'],
    // The kind's own launch overlay, so the launch gains no branch per kind: agents resolve with
    // the same uv and interpreter as checks, into the shared cache, and never download a Python.
    environment: {
      UV_CACHE_DIR: '/data/uv/cache',
      UV_PYTHON: '/opt/ct/python/bin/python3.12',
      UV_PYTHON_DOWNLOADS: 'never',
    },
    pathPrefix: ['/opt/ct/bin'],
  });
});

it("merges every source's overlay into a launch, in order, and adds nothing for cargo (R-G17)", () => {
  expect(
    launchSourceOverlay([
      cargoOutsideSource('/data/cargo-home'),
      pypiOutsideSource('/data/uv/cache', profile),
    ]),
  ).toEqual({
    environment: {
      UV_CACHE_DIR: '/data/uv/cache',
      UV_PYTHON: '/opt/ct/python/bin/python3.12',
      UV_PYTHON_DOWNLOADS: 'never',
    },
    pathPrefix: ['/opt/ct/bin'],
  });
  expect(launchSourceOverlay([cargoOutsideSource('/data/cargo-home')])).toEqual({
    environment: {},
    pathPrefix: [],
  });
  expect(launchSourceOverlay([])).toEqual({ environment: {}, pathPrefix: [] });
});

it("notes the pypi source's hosts and cache with the others (R-G17)", () => {
  expect(
    outsideSourcesNote({
      ...launch,
      permissionMode: 'auto',
      outsideSources: [pypiOutsideSource('/data/uv/cache', profile)],
    }),
  ).toBe(
    'Outside sources for sandboxed commands: pypi (hosts pypi.org, files.pythonhosted.org; writes /data/uv/cache). Commands reach no other host.',
  );
});

it("denies sandboxed commands PyPI's and uv's credentials and uv's own configuration (R-G17)", () => {
  const denied = sandboxDeniedReads({});
  for (const path of [
    '~/.pypirc',
    '~/.netrc',
    uvConfigPaths().credentials,
    uvConfigPaths().configuration,
  ])
    expect(denied).toContain(path);
  // Where XDG says, when it says it.
  expect(uvConfigPaths({ XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/config' })).toEqual({
    credentials: '/x/data/uv/credentials',
    configuration: '/x/config/uv',
  });
  expect(uvConfigPaths({ XDG_DATA_HOME: 'relative' })).toEqual({
    credentials: '~/.local/share/uv/credentials',
    configuration: '~/.config/uv',
  });
});
