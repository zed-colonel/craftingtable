import { expect, it } from 'vitest';
import { type LockedPackage, planWheels, wheelFits } from '../src/python-wheels.js';

/**
 * R-G17 decisions 8, 10, 11 and 14: from the adopted lock, the wheels a check needs on this
 * interpreter, and what is refused by name: Git, URL, path and other-index sources, sdist-only
 * packages and a packaged project.
 */

const target = { pythonVersion: '3.12.15', platform: 'linux-x86_64', libc: 'glibc 2.44' };
const hash = (c: string) => `sha256:${c.repeat(64)}`;

it('fits a wheel to CPython 3.12 on glibc x86_64 by its tags', () => {
  for (const fits of [
    'markupsafe-3.0.4-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl',
    'pytest-9.1.1-py3-none-any.whl',
    'colorama-0.4.6-py2.py3-none-any.whl',
    'cryptography-46.0.0-cp311-abi3-manylinux_2_34_x86_64.whl',
    'numpy-2.3.0-cp312-cp312-manylinux_2_44_x86_64.whl',
    'pkg-1.0-1build-cp312-cp312-manylinux1_x86_64.whl',
    'tomli-2.0-py312-none-any.whl',
  ])
    expect(wheelFits(fits, target), fits).toBe(true);
  for (const misfit of [
    'markupsafe-3.0.4-cp313-cp313-manylinux_2_17_x86_64.whl',
    'markupsafe-3.0.4-cp312-cp312-musllinux_1_2_x86_64.whl',
    'markupsafe-3.0.4-cp312-cp312-manylinux_2_17_aarch64.whl',
    'markupsafe-3.0.4-cp312-cp312-macosx_11_0_arm64.whl',
    'markupsafe-3.0.4-cp312-cp312-win_amd64.whl',
    'numpy-2.3.0-cp312-cp312-manylinux_2_45_x86_64.whl',
    'cryptography-46.0.0-cp313-abi3-manylinux_2_34_x86_64.whl',
    'pkg-1.0-pp310-pypy310_pp73-manylinux_2_17_x86_64.whl',
    'pkg-1.0-cp312-cp312t-manylinux_2_17_x86_64.whl',
    'pkg-1.0-py2-none-any.whl',
    'not-a-wheel.tar.gz',
    '../escape-1.0-py3-none-any.whl',
  ])
    expect(wheelFits(misfit, target), misfit).toBe(false);
  // Without a C library, only pure wheels fit.
  expect(wheelFits('pytest-9.1.1-py3-none-any.whl', { ...target, libc: undefined })).toBe(true);
  expect(
    wheelFits('markupsafe-3.0.4-cp312-cp312-manylinux_2_17_x86_64.whl', {
      ...target,
      libc: undefined,
    }),
  ).toBe(false);
});

const registry = { registry: 'https://pypi.org/simple' };
const pkg = (name: string, overrides: Partial<LockedPackage> = {}): LockedPackage => ({
  name,
  version: '1.0',
  source: registry,
  wheels: [
    {
      url: `https://files.pythonhosted.org/packages/aa/bb/${name}-1.0-py3-none-any.whl`,
      hash: hash('a'),
    },
  ],
  sdist: true,
  ...overrides,
});

it('asks for each fitting wheel of each PyPI package, by name, version, file name and the lock’s hash', () => {
  const plan = planWheels(
    [
      { name: 'fixture', version: '0.1.0', source: { virtual: '.' }, wheels: [], sdist: false },
      pkg('pytest'),
      pkg('markupsafe', {
        version: '3.0.4',
        wheels: [
          {
            url: 'https://files.pythonhosted.org/packages/1/2/markupsafe-3.0.4-cp312-cp312-manylinux_2_17_x86_64.whl',
            hash: hash('b'),
          },
          {
            url: 'https://files.pythonhosted.org/packages/1/2/markupsafe-3.0.4-cp313-cp313-manylinux_2_17_x86_64.whl',
            hash: hash('c'),
          },
        ],
      }),
      // A Windows-only package fits nothing here: nothing is asked, uv's markers decide.
      pkg('pywin32', {
        wheels: [
          {
            url: 'https://files.pythonhosted.org/packages/1/2/pywin32-1.0-cp312-cp312-win_amd64.whl',
            hash: hash('d'),
          },
        ],
      }),
    ],
    target,
  );
  expect(plan.refused).toEqual([]);
  expect(plan.wheels).toEqual([
    {
      name: 'pytest',
      version: '1.0',
      filename: 'pytest-1.0-py3-none-any.whl',
      sha256: 'a'.repeat(64),
    },
    {
      name: 'markupsafe',
      version: '3.0.4',
      filename: 'markupsafe-3.0.4-cp312-cp312-manylinux_2_17_x86_64.whl',
      sha256: 'b'.repeat(64),
    },
  ]);
});

it('refuses Git, URL, path and other-index sources, sdist-only packages and a packaged project, by name', () => {
  const plan = planWheels(
    [
      { name: 'app', version: '0.1.0', source: { editable: '.' }, wheels: [], sdist: false },
      pkg('from-git', { source: { git: 'https://github.com/x/y?rev=main#abc' }, wheels: [] }),
      pkg('from-url', { source: { url: 'https://example.org/z-1.0.tar.gz' }, wheels: [] }),
      pkg('from-path', { source: { path: '../z' }, wheels: [] }),
      pkg('from-directory', { source: { directory: 'libs/z' }, wheels: [] }),
      pkg('editable-lib', { source: { editable: 'libs/z' }, wheels: [] }),
      pkg('mirrored', { source: { registry: 'https://mirror.example.org/simple' } }),
      pkg('sdist-only', { wheels: [] }),
      pkg('unhashed', {
        wheels: [{ url: 'https://files.pythonhosted.org/p/unhashed-1.0-py3-none-any.whl' }],
      }),
      pkg('md5', {
        wheels: [
          {
            url: 'https://files.pythonhosted.org/p/md5-1.0-py3-none-any.whl',
            hash: `md5:${'a'.repeat(32)}`,
          },
        ],
      }),
      pkg('fine'),
    ],
    target,
  );
  expect(plan.refused).toEqual([
    { name: 'app', reason: 'packaged-project' },
    { name: 'from-git', reason: 'git-source' },
    { name: 'from-url', reason: 'url-source' },
    { name: 'from-path', reason: 'path-source' },
    { name: 'from-directory', reason: 'path-source' },
    { name: 'editable-lib', reason: 'path-source' },
    { name: 'mirrored', reason: 'other-index' },
    { name: 'sdist-only', reason: 'sdist-only' },
    { name: 'unhashed', reason: 'unhashed-wheel' },
    { name: 'md5', reason: 'unhashed-wheel' },
  ]);
  expect(plan.wheels.map((wheel) => wheel.name)).toEqual(['fine']);
});

it("takes a wheel's file name from its URL only when the URL is PyPI's own files host", () => {
  const plan = planWheels(
    [
      pkg('elsewhere', {
        wheels: [{ url: 'https://example.org/elsewhere-1.0-py3-none-any.whl', hash: hash('e') }],
      }),
    ],
    target,
  );
  expect(plan.wheels).toEqual([]);
  expect(plan.refused).toEqual([{ name: 'elsewhere', reason: 'other-index' }]);
  // A file name that cannot be decoded is no PyPI file either.
  expect(
    planWheels(
      [
        pkg('garbled', {
          wheels: [{ url: `${'https://files.pythonhosted.org/p/'}%E0%A4%A.whl`, hash: hash('f') }],
        }),
      ],
      target,
    ).refused,
  ).toEqual([{ name: 'garbled', reason: 'other-index' }]);
});
