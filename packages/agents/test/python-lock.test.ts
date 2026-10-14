import { expect, it } from 'vitest';
import { type LockedPackage, lockRefusals } from '../src/python-lock.js';

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
