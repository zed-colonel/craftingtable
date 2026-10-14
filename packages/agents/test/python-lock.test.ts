import { expect, it } from 'vitest';
import { type LockedPackage, lockOptionArguments, lockRefusals } from '../src/python-lock.js';

/**
 * R-G19 (ADR-076): what a Python check's install step may take from the adopted lock. PyPI's
 * packages, wheels and source distributions alike, the project itself and paths inside the tree
 * are installed by `uv sync --locked`; any other source is refused by name before anything runs.
 */

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const FILES = 'https://files.pythonhosted.org/packages/00/00';
const pypi = (name: string, extra: Partial<LockedPackage> = {}): LockedPackage => ({
  name,
  version: '1.0',
  source: { registry: 'https://pypi.org/simple' },
  wheels: [{ url: `${FILES}/${name}-1.0-py3-none-any.whl`, hash: hash('a') }],
  sdist: { url: `${FILES}/${name}-1.0.tar.gz`, hash: hash('b') },
  ...extra,
});

it('takes PyPI packages with wheels, with only a source distribution, and both', () => {
  expect(
    lockRefusals([
      pypi('both'),
      pypi('wheel-only', { sdist: undefined }),
      pypi('source-only', { wheels: [] }),
    ]),
  ).toEqual([]);
});

it('takes a packaged project, a virtual root, workspace members and paths inside the tree', () => {
  expect(
    lockRefusals([
      { name: 'app', source: { editable: '.' }, wheels: [] },
      { name: 'root', source: { virtual: '.' }, wheels: [] },
      { name: 'member', source: { editable: 'packages/member' }, wheels: [] },
      { name: 'library', source: { directory: 'libs/library' }, wheels: [] },
      {
        name: 'vendored',
        source: { path: 'vendor/vendored-1.0-py3-none-any.whl' },
        wheels: [{ filename: 'vendored-1.0-py3-none-any.whl', hash: hash('c') }],
      },
      { name: 'inner', source: { directory: './libs/../libs/inner' }, wheels: [] },
    ]),
  ).toEqual([]);
});

it('refuses, by name, every source the install step would need more than PyPI for', () => {
  expect(
    lockRefusals([
      { name: 'from-git', source: { git: 'https://example.org/x.git?rev=1#abc' }, wheels: [] },
      { name: 'from-url', source: { url: 'https://example.org/x-1.0.tar.gz' }, wheels: [] },
      pypi('other-index', { source: { registry: 'https://mirror.example.org/simple' } }),
      pypi('wheel-elsewhere', {
        wheels: [{ url: 'https://example.org/x-1.0-py3-none-any.whl', hash: hash('a') }],
      }),
      pypi('sdist-elsewhere', {
        sdist: { url: 'https://example.org/x-1.0.tar.gz', hash: hash('b') },
      }),
      pypi('no-host', { wheels: [{ url: 'https://files.pythonhosted.org.example.org/x.whl' }] }),
      { name: 'outside', source: { path: '../outside' }, wheels: [] },
      { name: 'absolute', source: { directory: '/srv/library' }, wheels: [] },
      { name: 'escaping', source: { editable: 'packages/../../escape' }, wheels: [] },
      { name: 'parent', source: { virtual: '..' }, wheels: [] },
      { name: 'nowhere', wheels: [] },
      { name: 'unknown', source: { workspace: 'yes' }, wheels: [] },
    ]),
  ).toEqual([
    { name: 'from-git', reason: 'git-source' },
    { name: 'from-url', reason: 'url-source' },
    { name: 'other-index', reason: 'other-index' },
    { name: 'wheel-elsewhere', reason: 'other-index' },
    { name: 'sdist-elsewhere', reason: 'other-index' },
    { name: 'no-host', reason: 'other-index' },
    { name: 'outside', reason: 'path-outside-tree' },
    { name: 'absolute', reason: 'path-outside-tree' },
    { name: 'escaping', reason: 'path-outside-tree' },
    { name: 'parent', reason: 'path-outside-tree' },
    { name: 'nowhere', reason: 'unknown-source' },
    { name: 'unknown', reason: 'unknown-source' },
  ]);
});

it("refuses a PyPI file the lock gives no SHA-256 for, so uv checks every one against the lock's hash", () => {
  expect(
    lockRefusals([
      pypi('unhashed-wheel', { wheels: [{ url: `${FILES}/x-1.0-py3-none-any.whl` }] }),
      pypi('md5-wheel', {
        wheels: [{ url: `${FILES}/x-1.0-py3-none-any.whl`, hash: `md5:${'a'.repeat(32)}` }],
      }),
      pypi('unhashed-sdist', { sdist: { url: `${FILES}/x-1.0.tar.gz` } }),
    ]),
  ).toEqual([
    { name: 'unhashed-wheel', reason: 'unhashed-file' },
    { name: 'md5-wheel', reason: 'unhashed-file' },
    { name: 'unhashed-sdist', reason: 'unhashed-file' },
  ]);
});

it('refuses a SHA-256 that is not 64 hexadecimal digits (mutation round 1, L9)', () => {
  expect(
    lockRefusals([
      pypi('short-hash', {
        wheels: [{ url: `${FILES}/x-1.0-py3-none-any.whl`, hash: 'sha256:abc' }],
      }),
      pypi('upper-hash', {
        sdist: { url: `${FILES}/x-1.0.tar.gz`, hash: `sha256:${'A'.repeat(64)}` },
      }),
    ]),
  ).toEqual([
    { name: 'short-hash', reason: 'unhashed-file' },
    { name: 'upper-hash', reason: 'unhashed-file' },
  ]);
});

it("passes the lock's resolver options to uv, so `uv sync --locked` agrees with the lock without the project's configuration (R-G19 review HIGH-1)", () => {
  expect(lockOptionArguments({})).toEqual({ arguments: [] });
  expect(
    lockOptionArguments({
      'resolution-mode': 'lowest-direct',
      'prerelease-mode': 'allow',
      'fork-strategy': 'fewest',
      'exclude-newer': '2026-01-01T00:00:00Z',
      'exclude-newer-package': { 'ctfix-pkg': '2026-02-01T00:00:00Z', other_pkg: '2026-03-01' },
    }),
  ).toEqual({
    arguments: [
      '--resolution=lowest-direct',
      '--prerelease=allow',
      '--fork-strategy=fewest',
      '--exclude-newer=2026-01-01T00:00:00Z',
      '--exclude-newer-package=ctfix-pkg=2026-02-01T00:00:00Z',
      '--exclude-newer-package=other_pkg=2026-03-01',
    ],
  });
  // A relative exclude-newer: uv records its span, and a placeholder date it ignores.
  expect(
    lockOptionArguments({ 'exclude-newer': '0001-01-01T00:00:00Z', 'exclude-newer-span': 'P1W' }),
  ).toEqual({ arguments: ['--exclude-newer=P1W'] });
});

it('refuses, by name, a resolver option it does not know or a value it cannot pass (R-G19 review HIGH-1)', () => {
  for (const [options, named] of [
    [{ 'new-option': 'x' }, 'new-option'],
    [{ 'resolution-mode': 'newest' }, 'resolution-mode'],
    [{ 'prerelease-mode': '--index-url=https://example.org' }, 'prerelease-mode'],
    [{ 'fork-strategy': 3 }, 'fork-strategy'],
    [{ 'exclude-newer': 'yesterday' }, 'exclude-newer'],
    [{ 'exclude-newer-span': 'P1W; rm' }, 'exclude-newer-span'],
    [{ 'exclude-newer-package': { 'bad name': '2026-01-01' } }, 'exclude-newer-package'],
    [{ 'exclude-newer-package': 'x' }, 'exclude-newer-package'],
  ] as const) {
    const result = lockOptionArguments(options as Record<string, unknown>);
    expect('problem' in result && result.problem, JSON.stringify(options)).toContain(named);
  }
});

it('passes a relative or opted-out per-package exclude-newer as uv records it (R-G19 re-check R-1)', () => {
  expect(
    lockOptionArguments({
      'exclude-newer-package': {
        fxdep: { timestamp: '0001-01-01T00:00:00Z', span: 'P1W' },
        other: false,
        dated: '2026-01-01T00:00:00Z',
      },
    }),
  ).toEqual({
    arguments: [
      '--exclude-newer-package=fxdep=P1W',
      '--exclude-newer-package=other=false',
      '--exclude-newer-package=dated=2026-01-01T00:00:00Z',
    ],
  });
  for (const value of [true, { span: 'soon' }, { timestamp: '2026-01-01T00:00:00Z' }, 3])
    expect(lockOptionArguments({ 'exclude-newer-package': { fxdep: value } })).toEqual({
      problem: expect.stringContaining('exclude-newer-package'),
    });
});
