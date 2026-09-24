import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkCycle } from '@craftingtable/domain';
import { createGitOperations } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import type { ExecutionConfig } from '../config.js';
import { BaselinePreparationService } from './baseline-preparation.js';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ct-baseline-service-'));
  roots.push(root);
  const repos = ['aq', 'wi', 'exo'].map((alias) => {
    const rootPath = join(root, alias);
    mkdirSync(rootPath);
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: rootPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init', '-b', 'main']);
    writeFileSync(join(rootPath, 'README.md'), `${alias} baseline`);
    git(['add', '.']);
    git(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'baseline']);
    const sha = git(['rev-parse', 'HEAD']);
    if (alias === 'aq') git(['tag', 'actionqueue/pre-redesign']);
    return { id: alias, rootPath, status: 'active', sha, git };
  });
  const binding = {
    revision: 1,
    bindings: repos.map((repo) => ({
      alias: repo.id,
      repositoryId: repo.id,
      ...(repo.id === 'aq' ? {} : { planVersionId: repo.id }),
    })),
  };
  const definition = {
    digest: 'map-1',
    source: {
      repositories: repos.map((repo) => ({
        id: repo.id,
        repository: `example/${repo.id === 'aq' ? 'actionqueue' : repo.id === 'wi' ? 'worldinterface' : 'exoskeleton'}`,
        role: repo.id === 'aq' ? 'implemented_upstream' : 'planned_application',
        source_baseline_commit: repo.id === 'aq' ? null : repo.sha,
      })),
    },
  };
  const cycle = {
    id: 'cycle',
    workspaceId: 'ws',
    workItemId: 'item',
    worktreeId: 'tree',
    version: 2,
    createdByUserId: 'user',
    executionScope: { definitionId: 'map', bindingRevision: 1 },
  } as WorkCycle;
  const storage = {
    execution: {
      sourceRepositories: { find: (_ws: string, id: string) => repos.find((r) => r.id === id) },
      worktrees: {
        find: () => ({
          id: 'tree',
          repositoryId: 'exo',
          baseSha: repos[2]!.sha,
          integrationBranch: 'exo-v3',
        }),
      },
    },
    planning: {
      workItems: { find: () => ({ id: 'item', planVersionId: 'exo' }) },
      artifacts: {
        listForVersion: (_ws: string, id: string) => [{ id }],
        findWithContent: (_ws: string, id: string) => ({
          content: Buffer.from(
            id === 'wi' ? 'Tag `worldinterface/pre-wi-fabric-2`.' : 'Tag `exoskeleton/pre-exo-v3`.',
          ),
        }),
      },
    },
    imports: { definition: () => definition, bindings: () => [binding] },
  } as unknown as CraftingTableStorage;
  const service = new BaselinePreparationService(
    storage,
    createGitOperations({ gitExecutable: 'git' }),
    { worktreeRoot: join(root, 'storage') } as ExecutionConfig,
  );
  return { service, cycle, repos, definition, root };
}
it('discovers exact historical tags and imported baselines, provisions siblings and keeps tags idempotent', async () => {
  const { service, cycle, repos } = fixture();
  const preview = await service.preview(cycle);
  expect(preview.sources.map((s) => s.directoryName)).toEqual([
    'actionqueue',
    'worldinterface',
    'exoskeleton',
  ]);
  expect(preview.sources.map((s) => s.ref)).toEqual(repos.map((r) => r.sha));
  expect(preview.sources.map((s) => s.tag)).toEqual([
    '',
    'worldinterface/pre-wi-fabric-2',
    'exoskeleton/pre-exo-v3',
  ]);
  const input = {
    expectedVersion: preview.expectedVersion,
    contextDigest: preview.contextDigest,
    sources: preview.sources.map((s) => ({
      alias: s.alias,
      ref: s.ref,
      ...(s.tag ? { tag: s.tag } : {}),
    })),
  };
  const prepared = await service.resolve(cycle, input);
  await service.prepare(
    cycle,
    prepared,
    () => {},
    async (_path, fn) => fn(),
  );
  expect(readFileSync(join(prepared.directory, 'actionqueue', 'README.md'), 'utf8')).toBe(
    'aq baseline',
  );
  expect(repos[1]!.git(['rev-parse', 'worldinterface/pre-wi-fabric-2'])).toBe(repos[1]!.sha);
  expect(repos[2]!.git(['rev-parse', 'exoskeleton/pre-exo-v3'])).toBe(repos[2]!.sha);
  const retry = await service.resolve(cycle, input);
  await service.prepare(
    cycle,
    retry,
    () => {},
    async (_path, fn) => fn(),
  );
  expect(repos.every((r) => r.git(['status', '--porcelain']) === '')).toBe(true);
});
it('rejects stale bindings, unknown repositories, tag injection and changing the imported application baseline', async () => {
  const { service, cycle, repos, definition } = fixture();
  const preview = await service.preview(cycle);
  const input = {
    expectedVersion: preview.expectedVersion,
    contextDigest: preview.contextDigest,
    sources: preview.sources.map((s) => ({
      alias: s.alias,
      ref: s.ref,
      ...(s.tag ? { tag: s.tag } : {}),
    })),
  };
  await expect(
    service.resolve(cycle, {
      ...input,
      sources: input.sources.map((s, i) => (i === 0 ? { ...s, alias: 'unknown' } : s)),
    }),
  ).rejects.toThrow('Unknown');
  await expect(
    service.resolve(cycle, {
      ...input,
      sources: input.sources.map((s, i) =>
        i === 0 ? { ...s, tag: 'actionqueue/pre-unapproved' } : s,
      ),
    }),
  ).rejects.toThrow('exact baseline tag');
  repos[2]!.git([
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'new',
  ]);
  await expect(
    service.resolve(cycle, {
      ...input,
      sources: input.sources.map((s) => (s.alias === 'exo' ? { ...s, ref: 'main' } : s)),
    }),
  ).rejects.toThrow('imported plan');
  definition.digest = 'map-2';
  await expect(service.resolve(cycle, input)).rejects.toThrow('context changed');
});
