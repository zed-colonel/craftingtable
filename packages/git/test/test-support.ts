import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FIXED_OBSERVED_AT = new Date('2026-07-26T12:00:00.000Z');

export const FIXTURE_GIT_ENVIRONMENT = Object.freeze({
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
});

export function findGitExecutable(): string {
  for (const entry of process.env.PATH?.split(delimiter) ?? []) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue to the next explicit test-only search entry.
    }
  }
  throw new Error('A Git executable is required for CT-04A1 real-Git tests.');
}

export const GIT_EXECUTABLE = findGitExecutable();

export function runFixtureGit(
  args: readonly string[],
  options: { readonly cwd?: string; readonly environment?: Readonly<Record<string, string>> } = {},
): Buffer {
  const result = spawnSync(GIT_EXECUTABLE, [...args], {
    cwd: options.cwd,
    env: { ...FIXTURE_GIT_ENVIRONMENT, ...options.environment },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `Fixture Git failed (${String(result.status)}): ${result.stderr.toString('utf8')}`,
    );
  }
  return result.stdout;
}

export interface RepositoryFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly repository: string;
  cleanup(): void;
}

export function createRepositoryFixture(name = 'repository'): RepositoryFixture {
  const root = realpathSync(mkdtempSync(join(process.cwd(), '.ct04a-git-test-')));
  const sourceRoot = join(root, 'sources');
  const repository = join(sourceRoot, name);
  mkdirSync(sourceRoot);
  runFixtureGit(['init', '--initial-branch=main', repository]);
  writeFileSync(join(repository, 'README.md'), '# fixture\n');
  runFixtureGit([
    '-C',
    repository,
    '-c',
    'user.name=CraftingTable',
    '-c',
    'user.email=craftingtable.invalid',
    'add',
    '--all',
  ]);
  runFixtureGit([
    '-C',
    repository,
    '-c',
    'user.name=CraftingTable',
    '-c',
    'user.email=craftingtable.invalid',
    'commit',
    '--no-gpg-sign',
    '-m',
    'initial',
  ]);
  return {
    root,
    sourceRoot,
    repository,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function createBareRepository(fixture: RepositoryFixture, name = 'bare.git'): string {
  const path = join(fixture.sourceRoot, name);
  runFixtureGit(['init', '--bare', path]);
  return path;
}

export function makeExecutableProxy(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return realpathSync(path);
}

export function repositoryInspectorOptions(fixture: RepositoryFixture) {
  return {
    allowedSourceRoots: [fixture.sourceRoot],
    gitExecutable: GIT_EXECUTABLE,
  } as const;
}

export const repositoryInspectorModuleUrl = fileURLToPath(
  new URL('../src/repository-inspector.ts', import.meta.url),
);
