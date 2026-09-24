import { createHash } from 'node:crypto';
import type { WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { zipFixture } from '../../../../packages/planning/src/archive-test-support.js';
import { collectDesignRecovery, readDesignRecoverySource } from './design-recovery.js';

const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const contract = '\uFEFFcontract_revision: STACK-2026-07-25-FOUNDATIONAL-2\n';
  const archive = zipFixture([
    { path: 'wi/contracts.yaml', bytes: Buffer.from(contract) },
    {
      path: 'wi/provenance/old.md',
      bytes: Buffer.from('STACK-2026-07-25-FOUNDATIONAL-2 historical source'),
    },
    { path: 'wi/validate.py', bytes: Buffer.from('STACK-2026-07-25-FOUNDATIONAL-2 executable') },
  ]);
  const archiveRecord = { id: 'wi-archive', digest: sha(archive), content: archive };
  const binding = {
    revision: 4,
    bindings: [{ planVersionId: 'exo-plan' }, { planVersionId: 'wi-plan' }],
  };
  const runtime = {
    id: 'runtime-1',
    digest: 'pin-generation-1',
    generation: 1,
    pins: [{ alias: 'aq', commitSha: 'abc' }],
    consumers: [],
  };
  const cycle = {
    id: 'cycle',
    workspaceId: 'ws',
    workItemId: 'exo',
    worktreeId: 'tree',
    currentRunId: 'design',
    version: 2,
    executionScope: {
      definitionId: 'map',
      bindingRevision: 4,
      kind: 'slice',
      sourceId: 'exo/EXO-01/domain',
    },
  } as WorkCycle;
  const tx = {
    planning: {
      projects: { find: () => undefined },
      dependencies: { listPredecessors: () => [] },
      workItems: { find: () => ({ id: 'exo', planVersionId: 'exo-plan', sourceId: 'EXO-01' }) },
      artifacts: { listForVersion: () => [], findWithContent: () => undefined },
    },
    execution: {
      cycles: { listActive: () => [], listForWorkspace: () => [] },
      branchSettings: {},
      sourceRepositories: {},
      worktrees: {
        find: () => ({ id: 'tree', branchName: 'ct/exo', baseSha: 'base', repositoryId: 'repo' }),
      },
      runs: {
        find: () => ({ id: 'design', worktreeId: 'tree', role: 'design' }),
        listRecent: () => [],
        listLive: () => [],
      },
      runEvents: {
        latestOfKind: () => ({
          kind: 'turn-completed',
          payload: {
            resultText: '## Open questions\nPlease supply STACK-2026-07-25-FOUNDATIONAL-2.',
          },
        }),
      },
    },
    imports: {
      bindings: () => [binding],
      definition: () => ({
        id: 'map',
        workspaceId: 'ws',
        digest: 'map-digest',
        source: { slices: [], work_items: [], checkpoints: [] },
      }),
      planLinks: (_ws: string, plan: string) =>
        plan === 'wi-plan' ? [{ archiveId: archiveRecord.id }] : [],
      archive: () => archiveRecord,
    },
    runtimeEvidence: { generations: () => [runtime], submissions: () => [], decisions: () => [] },
    roadmaps: { list: () => [] },
    scopeReceipts: {},
    phaseScheduling: {},
    amendments: {},
  } as unknown as StorageRepositories;
  return { tx, cycle, runtime, binding, contract, archiveRecord };
}

describe('design recovery source discovery', () => {
  it('finds the shared contract only through exact bound plan archives and retains byte identity', () => {
    const { tx, cycle, contract } = fixture();
    const preview = collectDesignRecovery(tx, cycle);
    expect(preview.sources).toHaveLength(1);
    const source = preview.sources[0];
    if (!source) throw new Error('Missing discovered source');
    expect(source.source.planVersionId).toBe('wi-plan');
    expect(source.source.name).toBe('wi/contracts.yaml');
    expect(source.source.digest).toBe(sha(contract));
    expect(readDesignRecoverySource(tx, cycle, source.source)).toBe(contract);
    expect(preview.facts).toContain('pin-generation-1');
    expect(preview.notices.join(' ')).toContain(
      'not fresh Git observations or passing test evidence',
    );
  });
  it('does not search unrelated plans or silently replace exact bindings with newer plans', () => {
    const { tx, cycle, binding } = fixture();
    binding.bindings = [{ planVersionId: 'exo-plan' }];
    expect(collectDesignRecovery(tx, cycle).sources).toHaveLength(0);
  });
  it('invalidates the snapshot when the runtime changes and refuses changed source bytes', () => {
    const { tx, cycle, runtime, archiveRecord } = fixture();
    const before = collectDesignRecovery(tx, cycle);
    runtime.digest = 'new-runtime-digest';
    expect(collectDesignRecovery(tx, cycle).snapshotDigest).not.toBe(before.snapshotDigest);
    archiveRecord.digest = 'different-archive';
    const source = before.sources[0];
    if (!source) throw new Error('Missing discovered source');
    expect(() => readDesignRecoverySource(tx, cycle, source.source)).toThrow('preserved identity');
  });
});
