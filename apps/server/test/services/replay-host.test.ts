import { nativeHostDigest } from '@craftingtable/agents';
import type { ExecutionScope, WorkspaceId } from '@craftingtable/domain';
import { asConcurrencyDefinitionId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { nativeApproval } from '../../src/services/native-verification-policy.js';
import { pinReplayHost } from '../../src/services/replay-host.js';
import { workstationDigest } from '../../src/services/workstation.js';

/**
 * The workstation a native approval must name (R-B4b's first step): the live digest in the
 * daemon, the digest the goldens were recorded under in a replay.
 */
afterEach(() => pinReplayHost(undefined));

const RECORDED = 'ab5c03931fe4cc09f7fb06c93b6d224a12ae7067f6607574d704a4a53016fa45';
const scope: ExecutionScope = {
  kind: 'slice',
  sourceId: 'slice',
  definitionId: asConcurrencyDefinitionId('definition'),
  bindingRevision: 1,
};
/** Just what `nativeApproval` reads: one approval given on a host, and its runtime. */
const storage = (hostDigest: string) =>
  ({
    runtimeEvidence: {
      nativeApprovals: () => [{ id: 'approval', approved: true, runtimeId: 'runtime', hostDigest }],
      generations: () => [{ id: 'runtime', pins: [], environments: [] }],
    },
  }) as unknown as StorageRepositories;

it('is the live host digest unless a replay pins it', () => {
  expect(workstationDigest()).toBe(nativeHostDigest());
  pinReplayHost(RECORDED);
  expect(workstationDigest()).toBe(RECORDED);
  pinReplayHost(undefined);
  expect(workstationDigest()).toBe(nativeHostDigest());
});

it('reads an approval current only on the host it names', () => {
  const ws = 'ws' as WorkspaceId;
  // A snapshot's approval, given on the host its goldens were recorded on, which this one is not.
  expect(RECORDED).not.toBe(nativeHostDigest());
  expect(nativeApproval(storage(RECORDED), ws, scope)).toBeUndefined();
  expect(nativeApproval(storage(nativeHostDigest()), ws, scope)?.id).toBe('approval');
  pinReplayHost(RECORDED);
  expect(nativeApproval(storage(RECORDED), ws, scope)?.id).toBe('approval');
  expect(nativeApproval(storage(nativeHostDigest()), ws, scope)).toBeUndefined();
});

it('pins only a host digest', () => {
  for (const digest of ['', 'ab5c', RECORDED.toUpperCase(), `${RECORDED}0`, ` ${RECORDED}`])
    expect(() => pinReplayHost(digest)).toThrow('A replay host is a 64-digit SHA-256 digest');
  expect(workstationDigest()).toBe(nativeHostDigest());
});
