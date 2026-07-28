import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIGURATION_DEPENDENCIES,
  parseGitVersion,
  resolveInspectorConfiguration,
} from '../src/configuration.js';
import { createRepositoryInspector } from '../src/index.js';
import {
  GIT_EXECUTABLE,
  createRepositoryFixture,
  makeExecutableProxy,
  repositoryInspectorOptions,
} from './test-support.js';

function countedVersionProxyBody(countPath: string, version: string, delayMs = 0): string {
  const writeVersion = `fs.writeSync(1, ${JSON.stringify(`git version ${version}\n`)});`;
  return `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(countPath)}, 'probe\\n');
${delayMs === 0 ? writeVersion : `setTimeout(() => { ${writeVersion} }, ${String(delayMs)});`}
`;
}

describe('Git inspector configuration', () => {
  it('imports without performing executable resolution', async () => {
    const module = await import('../src/index.js');
    expect(module.createRepositoryInspector).toBeTypeOf('function');
  });

  it('accepts vendor-tolerant Git version forms', () => {
    expect(parseGitVersion(Buffer.from('git version 2.54.0\n'))).toEqual({
      major: 2,
      minor: 54,
      patch: 0,
    });
    expect(parseGitVersion(Buffer.from('git version 2.39.3 (Apple Git-146)\n'))).toEqual({
      major: 2,
      minor: 39,
      patch: 3,
    });
    expect(parseGitVersion(Buffer.from('git version 2.45.1.windows.1\n'))).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
    });
    expect(parseGitVersion(Buffer.from('git version 2.32\n'))).toEqual({
      major: 2,
      minor: 32,
      patch: 0,
    });
  });

  it('rejects malformed and overflowing version output', () => {
    for (const value of [
      '',
      'version 2.54.0',
      'git version x.y.z',
      'git version 99999999999999999999.2.3',
    ]) {
      expect(parseGitVersion(Buffer.from(value)), value).toBeUndefined();
    }
  });

  it('creates an inspector with an explicit executable and ignores search path', async () => {
    const fixture = createRepositoryFixture();
    try {
      const result = await createRepositoryInspector({
        ...repositoryInspectorOptions(fixture),
        executableSearchPath: 'relative:/missing',
      });
      expect(result.ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts exact bound endpoints and rejects incoherent bounds', async () => {
    const fixture = createRepositoryFixture();
    try {
      const accepted = await createRepositoryInspector({
        ...repositoryInspectorOptions(fixture),
        commandTimeoutMs: 100,
        creationTimeoutMs: 1000,
        inspectionTimeoutMs: 1000,
        stdoutLimitBytes: 16384,
        stderrLimitBytes: 1024,
        terminationGraceMs: 50,
      });
      expect(accepted.ok).toBe(true);
      const maximumCreationTimeout = await createRepositoryInspector({
        ...repositoryInspectorOptions(fixture),
        creationTimeoutMs: 90000,
      });
      expect(maximumCreationTimeout.ok).toBe(true);

      for (const invalid of [
        { commandTimeoutMs: 99 },
        { stdoutLimitBytes: 16383 },
        { stderrLimitBytes: 1023 },
        { terminationGraceMs: 49 },
        { creationTimeoutMs: 999 },
        { creationTimeoutMs: 90001 },
        { creationTimeoutMs: 1000.5 },
        { commandTimeoutMs: 1001, creationTimeoutMs: 1000 },
        { commandTimeoutMs: 1000, inspectionTimeoutMs: 1999 },
        { commandTimeoutMs: 100.5 },
        { commandTimeoutMs: null },
        { creationTimeoutMs: null },
        { inspectionTimeoutMs: null },
        { stdoutLimitBytes: null },
        { stderrLimitBytes: null },
        { terminationGraceMs: null },
      ]) {
        const result = await createRepositoryInspector({
          ...repositoryInspectorOptions(fixture),
          ...invalid,
        } as never);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('invalid-options');
          expect(result.error.subject).toBe('policy-configuration');
          expect(result.error.retryability).toBe('configuration-required');
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses unsupported platforms and root daemon authority before Git', async () => {
    const fixture = createRepositoryFixture();
    try {
      const unsupported = await resolveInspectorConfiguration(repositoryInspectorOptions(fixture), {
        ...DEFAULT_CONFIGURATION_DEPENDENCIES,
        platform: 'win32',
      });
      expect(unsupported.ok).toBe(false);
      if (!unsupported.ok) {
        expect(unsupported.error.code).toBe('unsupported-platform');
      }

      const root = await resolveInspectorConfiguration(repositoryInspectorOptions(fixture), {
        ...DEFAULT_CONFIGURATION_DEPENDENCIES,
        effectiveUid: 0,
      });
      expect(root.ok).toBe(false);
      if (!root.ok) {
        expect(root.error.code).toBe('root-daemon-refused');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('does not fall back to ambient PATH when an explicit search path is supplied', async () => {
    const fixture = createRepositoryFixture();
    try {
      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        executableSearchPath: '/definitely/not/a/git/search/path',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('git-not-found');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects malformed executable options as policy configuration', async () => {
    const fixture = createRepositoryFixture();
    try {
      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        gitExecutable: 42,
      } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: 'invalid-options',
          subject: 'policy-configuration',
          retryability: 'configuration-required',
        });
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects an explicit symlink but accepts a search-path symlink after canonicalization', async () => {
    const fixture = createRepositoryFixture();
    try {
      const bin = join(fixture.root, 'bin');
      mkdirSync(bin);
      const linkedGit = join(bin, 'git');
      symlinkSync(GIT_EXECUTABLE, linkedGit);

      const explicit = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        gitExecutable: linkedGit,
      });
      expect(explicit.ok).toBe(false);
      if (!explicit.ok) {
        expect(explicit.error.code).toBe('git-not-executable');
      }

      const searched = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        executableSearchPath: `relative${process.platform === 'win32' ? ';' : ':'}${bin}`,
      });
      expect(searched.ok).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('enforces the Git 2.32 floor', async () => {
    const fixture = createRepositoryFixture();
    try {
      const oldGit = makeExecutableProxy(
        fixture.root,
        'old-git',
        "import fs from 'node:fs'; fs.writeSync(1, 'git version 2.31.1\\n');",
      );
      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        gitExecutable: oldGit,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unsupported-git-version');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('selects the first search-path executable whose version probe passes', async () => {
    const fixture = createRepositoryFixture();
    try {
      const staleBins = ['old-bin-1', 'old-bin-2', 'old-bin-3'].map((name) =>
        join(fixture.root, name),
      );
      const currentBin = join(fixture.root, 'current-bin');
      const countPath = join(fixture.root, 'viable-probe-count');
      for (const staleBin of staleBins) {
        mkdirSync(staleBin);
        makeExecutableProxy(staleBin, 'git', countedVersionProxyBody(countPath, '2.31.1'));
      }
      mkdirSync(currentBin);
      makeExecutableProxy(currentBin, 'git', countedVersionProxyBody(countPath, '2.54.0'));

      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        executableSearchPath: [...staleBins, currentBin].join(
          process.platform === 'win32' ? ';' : ':',
        ),
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(4);
    } finally {
      fixture.cleanup();
    }
  });

  it('reports the first meaningful probe failure when no search candidate is viable', async () => {
    const fixture = createRepositoryFixture();
    try {
      const oldBin = join(fixture.root, 'old-bin');
      mkdirSync(oldBin);
      makeExecutableProxy(
        oldBin,
        'git',
        "import fs from 'node:fs'; fs.writeSync(1, 'git version 2.31.1\\n');",
      );

      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        executableSearchPath: oldBin,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unsupported-git-version');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('deduplicates repeated search entries by canonical executable path', async () => {
    const fixture = createRepositoryFixture();
    try {
      const oldBin = join(fixture.root, 'old-bin');
      const countPath = join(fixture.root, 'deduplicated-probe-count');
      mkdirSync(oldBin);
      makeExecutableProxy(oldBin, 'git', countedVersionProxyBody(countPath, '2.31.1'));

      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        executableSearchPath: [oldBin, oldBin, oldBin].join(
          process.platform === 'win32' ? ';' : ':',
        ),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unsupported-git-version');
      }
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('bounds aggregate creation time and starts no later candidate after expiry', async () => {
    const fixture = createRepositoryFixture();
    try {
      const firstBin = join(fixture.root, 'first-bin');
      const secondBin = join(fixture.root, 'second-bin');
      const thirdBin = join(fixture.root, 'third-bin');
      const countPath = join(fixture.root, 'creation-timeout-probe-count');
      for (const bin of [firstBin, secondBin, thirdBin]) {
        mkdirSync(bin);
      }
      makeExecutableProxy(firstBin, 'git', countedVersionProxyBody(countPath, '2.31.1', 550));
      makeExecutableProxy(secondBin, 'git', countedVersionProxyBody(countPath, '2.31.1', 550));
      makeExecutableProxy(thirdBin, 'git', countedVersionProxyBody(countPath, '2.54.0'));

      const result = await createRepositoryInspector({
        allowedSourceRoots: [fixture.sourceRoot],
        executableSearchPath: [firstBin, secondBin, thirdBin].join(
          process.platform === 'win32' ? ';' : ':',
        ),
        commandTimeoutMs: 900,
        creationTimeoutMs: 1000,
        terminationGraceMs: 50,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          code: 'timed-out',
          subject: 'git-boundary-fault',
          retryability: 'retryable',
        });
      }
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Git package production boundary', () => {
  it('exports only the public entry point and emits no test capability', () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    });
    expect(Object.keys(manifest.exports)).not.toContain('*');

    const compiler = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const build = spawnSync(process.execPath, [compiler, '-b', packageRoot], {
      cwd: repositoryRoot,
      env: { LC_ALL: 'C', LANG: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(build.status, build.stderr.toString('utf8')).toBe(0);

    const dist = join(packageRoot, 'dist');
    const emittedJavaScript = readdirSync(dist)
      .filter((name) => name.endsWith('.js'))
      .sort();
    expect(emittedJavaScript.some((name) => name.includes('test'))).toBe(false);
    expect(emittedJavaScript.some((name) => name.includes('fixture'))).toBe(false);
    expect(
      emittedJavaScript.filter((name) =>
        readFileSync(join(dist, name), 'utf8').includes('node:child_process'),
      ),
    ).toEqual(['command-runner.js']);

    const sourceDirectory = join(packageRoot, 'src');
    const productionSources = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({
        name,
        source: readFileSync(join(sourceDirectory, name), 'utf8'),
      }));
    expect(
      productionSources
        .filter(({ source }) => source.includes('GIT_CEILING_DIRECTORIES'))
        .map(({ name }) => name),
    ).toEqual(['environment.ts']);
    expect(
      productionSources
        .filter(({ source }) => source.includes('asCanonicalPath('))
        .map(({ name }) => name),
    ).toEqual(['path-policy.ts']);
    expect(
      productionSources
        .filter(({ source }) => source.includes('as GitCeilingDirectory'))
        .map(({ name }) => name),
    ).toEqual(['environment.ts']);
    expect(readFileSync(join(sourceDirectory, 'index.ts'), 'utf8')).not.toMatch(
      /CanonicalPath|GitCeilingDirectory|asCanonicalPath|createGitCeilingDirectory/,
    );
    expect(readFileSync(join(sourceDirectory, 'configuration.ts'), 'utf8')).not.toContain(
      'as string',
    );
  });
});
