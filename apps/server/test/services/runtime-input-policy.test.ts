import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeConcurrencyArchive } from '@craftingtable/planning';
import {
  asWorkspaceId,
  asSourceRepositoryId,
  asUserId,
  type RuntimeGeneration,
  type ConcurrencyDefinition,
} from '@craftingtable/domain';
import {
  runtimeInputChanges,
  sameRuntimeEnvironments,
} from '../../src/services/runtime-input-policy.js';
import { evidenceInputs } from '../../src/services/runtime-evidence-policy.js';

function generation(): RuntimeGeneration {
  return {
    id: 'generation-1',
    workspaceId: asWorkspaceId('workspace'),
    definitionId: 'map',
    bindingRevision: 1,
    generation: 1,
    digest: 'a'.repeat(64),
    createdAt: '2026-09-19T00:00:00Z',
    createdByUserId: asUserId('operator'),
    pins: ['aq', 'wi'].map((alias) => ({
      alias,
      ref: 'revision',
      repositoryId: asSourceRepositoryId(alias),
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      conformanceRevision: 'plan-v1',
      packages: [{ name: alias, path: '', version: '1.0.0' }],
    })),
    consumers: [
      { alias: 'wi', upstreams: ['aq'] },
      { alias: 'exo', upstreams: ['aq', 'wi'] },
    ],
    environments: [
      {
        id: 'local',
        kind: 'local-development',
        identityDigest: 'a'.repeat(64),
        fixtureDigest: 'b'.repeat(64),
        toolchainDigest: 'c'.repeat(64),
        authorization: 'Non-sensitive fixtures only',
      },
    ],
  };
}
it('retains completed upstream baseline proof across consumer pin changes, but not provider or environment changes', () => {
  const source = analyzeConcurrencyArchive(
    readFileSync(
      new URL(
        '../../../../fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip',
        import.meta.url,
      ),
    ),
  ).source!;
  const inputs = evidenceInputs({ source } as ConcurrencyDefinition, {
    kind: 'checkpoint',
    sourceId: 'AQ-BASELINE-ACCEPTED',
  });
  const before = generation();
  const changedPin = (alias: string) => ({
    ...before,
    pins: before.pins.map((p) => (p.alias === alias ? { ...p, commitSha: 'c'.repeat(40) } : p)),
  });
  expect(runtimeInputChanges(before, changedPin('wi'), inputs)).toEqual([]);
  expect(runtimeInputChanges(before, changedPin('aq'), inputs)).toEqual([
    expect.stringContaining('aq dependency commit'),
  ]);
  expect(
    runtimeInputChanges(
      before,
      {
        ...before,
        environments: before.environments.map((e) => ({ ...e, toolchainDigest: 'd'.repeat(64) })),
      },
      inputs,
    ),
  ).toEqual([expect.stringContaining('toolchain')]);
});
it('retains WI evidence but requires EXO re-verification when the WI pin advances', () => {
  const before = generation();
  const after = {
    ...before,
    id: 'generation-2',
    generation: 2,
    pins: before.pins.map((p) => (p.alias === 'wi' ? { ...p, commitSha: 'c'.repeat(40) } : p)),
  };
  expect(runtimeInputChanges(before, after, { consumers: ['wi'] })).toEqual([]);
  expect(runtimeInputChanges(before, after, { consumers: ['exo'] })).toEqual([
    expect.stringContaining('wi dependency commit'),
  ]);
  expect(runtimeInputChanges(before, after)).toHaveLength(1);
  expect(sameRuntimeEnvironments(before, after)).toBe(true);
  expect(before.pins[1]?.commitSha).toBe('a'.repeat(40));
});
it.each(['commitSha', 'treeSha', 'repositoryId', 'conformanceRevision', 'packages'] as const)(
  'does not reuse a relevant pin with changed %s',
  (key) => {
    const before = generation();
    const after = {
      ...before,
      pins: before.pins.map((p) =>
        p.alias === 'aq'
          ? {
              ...p,
              [key]:
                key === 'packages'
                  ? [{ name: 'aq', path: 'different', version: '2.0.0' }]
                  : 'changed',
            }
          : p,
      ),
    } as RuntimeGeneration;
    expect(runtimeInputChanges(before, after, { consumers: ['wi'] })).toHaveLength(1);
  },
);
it.each(['identityDigest', 'fixtureDigest', 'toolchainDigest', 'authorization', 'kind'] as const)(
  'invalidates host approval and receipts when environment %s changes',
  (key) => {
    const before = generation();
    const after = {
      ...before,
      environments: before.environments.map((e) => ({
        ...e,
        [key]: key === 'kind' ? 'external-kata' : 'changed',
      })),
    } as RuntimeGeneration;
    expect(runtimeInputChanges(before, after, { consumers: ['wi'] })).toHaveLength(1);
    expect(sameRuntimeEnvironments(before, after)).toBe(false);
  },
);
it('ignores ordering and ref labels but rejects lost bindings or dependency relationships', () => {
  const before = generation();
  expect(
    runtimeInputChanges(before, {
      ...before,
      id: 'next',
      pins: [...before.pins].reverse().map((p) => ({ ...p, ref: p.commitSha })),
      consumers: [...before.consumers]
        .reverse()
        .map((c) => ({ ...c, upstreams: [...c.upstreams].reverse() })),
    }),
  ).toEqual([]);
  expect(
    runtimeInputChanges(before, { ...before, consumers: [] }, { consumers: ['wi'] }),
  ).not.toEqual([]);
  expect(runtimeInputChanges(before, { ...before, bindingRevision: 2 })).not.toEqual([]);
  expect(runtimeInputChanges(undefined, before)).not.toEqual([]);
  expect(
    runtimeInputChanges(before, { ...before, environments: [] }, { environmentId: 'local' }),
  ).not.toEqual([]);
});
it('qualification evidence freezes its named environment rather than an unrelated one', () => {
  const before = generation();
  const after = {
    ...before,
    environments: [
      ...before.environments,
      { ...before.environments[0]!, id: 'new-qualified-host', kind: 'external-native' as const },
    ],
  };
  expect(runtimeInputChanges(before, after, { consumers: ['wi'], environmentId: 'local' })).toEqual(
    [],
  );
  expect(sameRuntimeEnvironments(before, after)).toBe(false);
});
