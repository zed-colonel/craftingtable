import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIGURATION_DEPENDENCIES } from '../src/configuration.js';
import { createRepositoryInspector, REPOSITORY_RISK_SCAN_PATTERN } from '../src/index.js';
import { NODE_FILE_SYSTEM_BOUNDARY } from '../src/path-policy.js';
import { createRepositoryInspectorWithDependencies } from '../src/repository-inspector.js';
import {
  FIXED_OBSERVED_AT,
  GIT_EXECUTABLE,
  createBareRepository,
  createRepositoryFixture,
  makeExecutableProxy,
  repositoryInspectorOptions,
  runFixtureGit,
} from './test-support.js';

async function createFixedInspector(
  fixture: ReturnType<typeof createRepositoryFixture>,
  executable = GIT_EXECUTABLE,
) {
  return await createRepositoryInspectorWithDependencies(
    {
      allowedSourceRoots: [fixture.sourceRoot],
      gitExecutable: executable,
    },
    {
      ...DEFAULT_CONFIGURATION_DEPENDENCIES,
      now: () => FIXED_OBSERVED_AT,
    },
  );
}

function createCountingGitProxy(
  fixture: ReturnType<typeof createRepositoryFixture>,
  countPath: string,
): string {
  return makeExecutableProxy(
    fixture.root,
    'counting-git',
    `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(countPath)}, 'spawn\\n');
const result = spawnSync(${JSON.stringify(GIT_EXECUTABLE)}, process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
`,
  );
}

function treeEvidence(root: string): readonly string[] {
  const evidence: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = statSync(path, { bigint: true });
      evidence.push(
        `${path.slice(root.length)}:${metadata.mode.toString()}:${metadata.size.toString()}:${metadata.mtimeNs.toString()}:${metadata.ino.toString()}`,
      );
      if (metadata.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  return evidence;
}

describe('real Git repository observation', () => {
  it('observes an exact SHA-1 primary checkout with self-describing empty scan evidence', async () => {
    const fixture = createRepositoryFixture();
    try {
      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.observation).toMatchObject({
          observationVersion: 1,
          inspectionPolicyVersion: 1,
          observedAt: FIXED_OBSERVED_AT.toISOString(),
          canonicalTopLevel: fixture.repository,
          canonicalGitDirectory: join(fixture.repository, '.git'),
          canonicalCommonGitDirectory: join(fixture.repository, '.git'),
          objectFormat: 'sha1',
          riskScan: {
            scanScopeVersion: 1,
            scannedKeyPattern: REPOSITORY_RISK_SCAN_PATTERN,
            classification: 'no-signals-in-scanned-set',
            signals: [],
          },
        });
        expect(result.observation.coreIdentity.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.observation.coreIdentity.topLevelInode).toMatch(/^[0-9]+$/);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('collects every scanned config class and hook evidence without executing values', async () => {
    const fixture = createRepositoryFixture();
    try {
      const marker = join(fixture.root, 'must-not-exist');
      const settings = [
        ['extensions.worktreeconfig', 'true'],
        ['core.hookspath', '.git/hooks'],
        ['core.fsmonitor', 'false'],
        ['core.worktree', fixture.repository],
        ['diff.external', 'false'],
        ['diff.custom.command', 'false'],
        ['diff.custom.textconv', 'false'],
        ['filter.custom.clean', 'false'],
        ['filter.custom.smudge', 'false'],
        ['filter.custom.process', 'false'],
        ['include.path', join(fixture.root, 'missing-include')],
        ['includeif.gitdir:example.path', join(fixture.root, 'missing-conditional')],
        ['alias.pwn', `!touch ${marker}`],
        ['merge.custom.driver', 'false'],
        ['credential.helper', 'false'],
      ] as const;
      for (const [key, value] of settings) {
        runFixtureGit(['-C', fixture.repository, 'config', '--local', key, value]);
      }
      writeFileSync(join(fixture.repository, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');

      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.observation.riskScan.classification).toBe('signals-observed');
        expect(result.observation.riskScan.signals).toEqual([
          'conditional-config-include',
          'config-include',
          'core-fsmonitor',
          'core-hooks-path',
          'core-worktree-redirection',
          'diff-driver-command',
          'diff-driver-textconv',
          'diff-external',
          'filter-clean',
          'filter-process',
          'filter-smudge',
          'hook-entry',
          'worktree-config-enabled',
        ]);
      }
      expect(() => statSync(marker)).toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('records a hooks-directory symlink without following it', async () => {
    const fixture = createRepositoryFixture();
    try {
      const hooks = join(fixture.repository, '.git', 'hooks');
      const target = join(fixture.root, 'external-hooks');
      mkdirSync(target);
      writeFileSync(join(target, 'pre-commit'), 'must not be inspected');
      const original = `${hooks}-original`;
      runFixtureGit(['-C', fixture.repository, 'config', '--local', 'core.hooksPath', hooks]);
      const { renameSync, symlinkSync } = await import('node:fs');
      renameSync(hooks, original);
      symlinkSync(target, hooks);

      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.observation.riskScan.signals).toContain('hooks-directory-symlink');
        expect(result.observation.riskScan.signals).not.toContain('hook-entry');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts leading-dash and newline basenames as one path value', async () => {
    const fixture = createRepositoryFixture('-repo\nwith-newline');
    try {
      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.observation.canonicalTopLevel).toBe(fixture.repository);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('supports SHA-256 object-format evidence when local Git supports it', async () => {
    const fixture = createRepositoryFixture();
    try {
      const sha256 = join(fixture.sourceRoot, 'sha256');
      runFixtureGit(['init', '--object-format=sha256', '--initial-branch=main', sha256]);
      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: sha256 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.observation.objectFormat).toBe('sha256');
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe('real Git repository-class rejection', () => {
  it('distinguishes nested stray metadata, bare layouts, linked worktrees, and separate Git dirs', async () => {
    const fixture = createRepositoryFixture();
    try {
      const nested = join(fixture.repository, 'nested');
      mkdirSync(join(nested, '.git'), { recursive: true });
      const bare = createBareRepository(fixture);
      const linked = join(fixture.sourceRoot, 'linked-worktree');
      runFixtureGit(['-C', fixture.repository, 'worktree', 'add', '--detach', linked, 'HEAD']);
      const separated = join(fixture.sourceRoot, 'separated-worktree');
      const separateGit = join(fixture.root, 'separate-git');
      runFixtureGit(['init', `--separate-git-dir=${separateGit}`, separated]);

      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      for (const requestedPath of [nested, bare, linked, separated]) {
        const result = await creation.inspector.inspect({ requestedPath });
        expect(result.ok, requestedPath).toBe(false);
        if (!result.ok) {
          expect(result.error.code, requestedPath).toBe('not-primary-repository');
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('classifies core.bare and unknown repository extensions honestly', async () => {
    const bareFixture = createRepositoryFixture();
    try {
      runFixtureGit(['-C', bareFixture.repository, 'config', '--local', 'core.bare', 'true']);
      const creation = await createFixedInspector(bareFixture);
      expect(creation.ok).toBe(true);
      if (creation.ok) {
        const result = await creation.inspector.inspect({
          requestedPath: bareFixture.repository,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('not-primary-repository');
        }
      }
    } finally {
      bareFixture.cleanup();
    }

    const extensionFixture = createRepositoryFixture();
    try {
      runFixtureGit([
        '-C',
        extensionFixture.repository,
        'config',
        '--local',
        'core.repositoryformatversion',
        '1',
      ]);
      runFixtureGit([
        '-C',
        extensionFixture.repository,
        'config',
        '--local',
        'extensions.unknown',
        'true',
      ]);
      const creation = await createFixedInspector(extensionFixture);
      expect(creation.ok).toBe(true);
      if (creation.ok) {
        const result = await creation.inspector.inspect({
          requestedPath: extensionFixture.repository,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('unsupported-repository-extension');
        }
      }
    } finally {
      extensionFixture.cleanup();
    }
  });

  it('keeps unreadable config distinct from an empty scanned set', async () => {
    const fixture = createRepositoryFixture();
    const config = join(fixture.repository, '.git', 'config');
    try {
      chmodSync(config, 0o000);
      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (creation.ok) {
        const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('repository-metadata-unreadable');
        }
      }
    } finally {
      chmodSync(config, 0o600);
      fixture.cleanup();
    }
  });
});

describe('inspection isolation and side-effect proof', () => {
  it('performs exactly two repository spawns after the version probe', async () => {
    const fixture = createRepositoryFixture();
    try {
      const countPath = join(fixture.root, 'spawn-count');
      const proxy = createCountingGitProxy(fixture, countPath);
      const creation = await createFixedInspector(fixture, proxy);
      expect(creation.ok, creation.ok ? undefined : creation.error.code).toBe(true);
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(1);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(true);
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(3);
    } finally {
      fixture.cleanup();
    }
  });

  it('supports concurrent observations without shared mutable state', async () => {
    const fixture = createRepositoryFixture();
    try {
      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const [left, right] = await Promise.all([
        creation.inspector.inspect({ requestedPath: fixture.repository }),
        creation.inspector.inspect({ requestedPath: fixture.repository }),
      ]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      if (left.ok && right.ok) {
        expect(left.observation).toEqual(right.observation);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('constructs fixtures independently of hostile HOME and global Git config', async () => {
    const environmentRoot = mkdtempSync(join(process.cwd(), '.ct04a-hostile-home-'));
    const hostileHome = join(environmentRoot, 'hostile');
    const emptyHome = join(environmentRoot, 'empty');
    const template = join(environmentRoot, 'template');
    mkdirSync(join(template, 'hooks'), { recursive: true });
    mkdirSync(hostileHome);
    mkdirSync(emptyHome);
    writeFileSync(join(template, 'hooks', 'hostile-hook'), 'must not be copied');
    writeFileSync(
      join(hostileHome, '.gitconfig'),
      `[init]\n\ttemplateDir = ${template}\n[core]\n\thooksPath = ${template}/hooks\n[include]\n\tpath = ${environmentRoot}/missing\n`,
    );

    const previousHome = process.env.HOME;
    let hostileFixture: ReturnType<typeof createRepositoryFixture> | undefined;
    let emptyFixture: ReturnType<typeof createRepositoryFixture> | undefined;
    try {
      process.env.HOME = hostileHome;
      hostileFixture = createRepositoryFixture();
      process.env.HOME = emptyHome;
      emptyFixture = createRepositoryFixture();

      expect(readFileSync(join(hostileFixture.repository, '.git', 'config'), 'utf8')).toBe(
        readFileSync(join(emptyFixture.repository, '.git', 'config'), 'utf8'),
      );
      expect(readdirSync(join(hostileFixture.repository, '.git', 'hooks')).sort()).toEqual(
        readdirSync(join(emptyFixture.repository, '.git', 'hooks')).sort(),
      );
      expect(readdirSync(join(hostileFixture.repository, '.git', 'hooks'))).not.toContain(
        'hostile-hook',
      );

      const hostileInspector = await createFixedInspector(hostileFixture);
      const emptyInspector = await createFixedInspector(emptyFixture);
      expect(hostileInspector.ok).toBe(true);
      expect(emptyInspector.ok).toBe(true);
      if (hostileInspector.ok && emptyInspector.ok) {
        const [hostileObservation, emptyObservation] = await Promise.all([
          hostileInspector.inspector.inspect({ requestedPath: hostileFixture.repository }),
          emptyInspector.inspector.inspect({ requestedPath: emptyFixture.repository }),
        ]);
        expect(hostileObservation.ok).toBe(true);
        expect(emptyObservation.ok).toBe(true);
        if (hostileObservation.ok && emptyObservation.ok) {
          expect(hostileObservation.observation.riskScan).toEqual(
            emptyObservation.observation.riskScan,
          );
        }
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      hostileFixture?.cleanup();
      emptyFixture?.cleanup();
      rmSync(environmentRoot, { recursive: true, force: true });
    }
  });

  it('creates or changes no repository file during production inspection', async () => {
    const fixture = createRepositoryFixture();
    try {
      const before = treeEvidence(fixture.root);
      const creation = await createFixedInspector(fixture);
      expect(creation.ok).toBe(true);
      if (creation.ok) {
        const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
        expect(result.ok).toBe(true);
      }
      expect(treeEvidence(fixture.root)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails closed when repository metadata changes during observation', async () => {
    const fixture = createRepositoryFixture();
    const configPath = join(fixture.repository, '.git', 'config');
    let configStats = 0;
    try {
      const creation = await createRepositoryInspectorWithDependencies(
        repositoryInspectorOptions(fixture),
        {
          ...DEFAULT_CONFIGURATION_DEPENDENCIES,
          fs: {
            ...NODE_FILE_SYSTEM_BOUNDARY,
            lstat: async (path) => {
              const metadata = await NODE_FILE_SYSTEM_BOUNDARY.lstat(path);
              if (path === configPath && ++configStats > 1) {
                Object.defineProperty(metadata, 'mtimeNs', {
                  value: metadata.mtimeNs + 1n,
                });
              }
              return metadata;
            },
          },
          now: () => FIXED_OBSERVED_AT,
        },
      );
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('observation-raced');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('does not start a Git command after the total inspection budget expires', async () => {
    const fixture = createRepositoryFixture();
    const countPath = join(fixture.root, 'budget-spawn-count');
    const proxy = createCountingGitProxy(fixture, countPath);
    let delayFilesystem = false;
    let delayed = false;
    try {
      const creation = await createRepositoryInspectorWithDependencies(
        {
          allowedSourceRoots: [fixture.sourceRoot],
          gitExecutable: proxy,
          commandTimeoutMs: 100,
          inspectionTimeoutMs: 1000,
        },
        {
          ...DEFAULT_CONFIGURATION_DEPENDENCIES,
          fs: {
            ...NODE_FILE_SYSTEM_BOUNDARY,
            lstat: async (path) => {
              if (delayFilesystem && !delayed) {
                delayed = true;
                await new Promise((resolve) => setTimeout(resolve, 1100));
              }
              return await NODE_FILE_SYSTEM_BOUNDARY.lstat(path);
            },
          },
          now: () => FIXED_OBSERVED_AT,
        },
      );
      expect(creation.ok).toBe(true);
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(1);
      if (!creation.ok) {
        return;
      }
      delayFilesystem = true;
      const result = await creation.inspector.inspect({ requestedPath: fixture.repository });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('timed-out');
      }
      expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('returns pre-aborted before request-path access', async () => {
    const fixture = createRepositoryFixture();
    try {
      const creation = await createRepositoryInspector(repositoryInspectorOptions(fixture));
      expect(creation.ok).toBe(true);
      if (!creation.ok) {
        return;
      }
      const controller = new AbortController();
      controller.abort();
      const result = await creation.inspector.inspect({
        requestedPath: join(fixture.sourceRoot, 'missing'),
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('aborted');
      }
    } finally {
      fixture.cleanup();
    }
  });
});
