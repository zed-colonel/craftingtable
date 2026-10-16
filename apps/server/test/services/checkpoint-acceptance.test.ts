import type { WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { beforeEach, expect, it, vi } from 'vitest';
import { decideRefusal } from '../../src/services/cycle-effects.js';
import { RuntimeEvidenceService } from '../../src/services/runtime-evidence-service.js';

/**
 * The checkpoint acceptance's entry check (R-B4 increment 4 re-check, NEW-LOW-1): a checkpoint
 * whose assignment, support or prerequisites changed while its review ran cannot attest. The pass
 * drops such a review before it calls this (`server-execution-checkpoint-changed.test.ts`); should
 * one still arrive, the stop names the checkpoint, not `controller-error`.
 */

const state = vi.hoisted(() => ({
  checkpoint: undefined as
    | { id: string; supported: boolean; assigned: boolean; pending: string[] }
    | undefined,
}));
vi.mock('../../src/services/workflow-policy.js', () => ({
  workflowDelegation: () => ({ runnable: true, roles: ['reviewer'] }),
  workflowContext: () => ({ checkpoints: state.checkpoint ? [state.checkpoint] : [] }),
}));

const ready = { id: 'LOCAL-REVIEW', supported: true, assigned: true, pending: [] as string[] };
beforeEach(() => {
  state.checkpoint = ready;
});

const cycle = {
  id: 'cycle-1',
  workspaceId: 'ws',
  createdByUserId: 'user-1',
  executionScope: { kind: 'slice', sourceId: 'domain', definitionId: 'def-1' },
  workflow: { activeReview: { kind: 'checkpoint', checkpointId: 'LOCAL-REVIEW' } },
} as unknown as WorkCycle;

/** The stop the acceptance's entry check decides, or the thrown value when it is not one. */
async function stopOf(user: unknown = { id: 'user-1', status: 'active' }) {
  const storage = { users: { findById: () => user } } as unknown as CraftingTableStorage;
  const refusal = new Error('passed the entry check');
  const workspaces = {
    requireRole: () => {
      throw refusal;
    },
  };
  const service = new RuntimeEvidenceService(storage, workspaces as never, {} as never, undefined);
  const error = await service.acceptWorkflowCheckpoint(cycle).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  return error === refusal ? 'passed' : (decideRefusal(error) ?? error);
}

it.each([
  ['unassigned', { assigned: false }],
  ['unsupported', { supported: false }],
  ['with a prerequisite pending again', { pending: ['LOCAL-ADR-01 is not accepted.'] }],
])('a checkpoint %s while its review ran stops as its attestation', async (_name, change) => {
  state.checkpoint = { ...ready, ...change };
  expect(await stopOf()).toMatchObject({
    kind: 'attention',
    code: 'checkpoint-attestation-failed',
    refs: { checkpointId: 'LOCAL-REVIEW' },
  });
});

it('a checkpoint removed from the slice stops as its attestation, by the review’s checkpoint', async () => {
  state.checkpoint = undefined;
  expect(await stopOf()).toMatchObject({
    code: 'checkpoint-attestation-failed',
    refs: { checkpointId: 'LOCAL-REVIEW' },
  });
});

it('a review whose starting user was disabled stops as lost authority', async () =>
  expect(await stopOf({ id: 'user-1', status: 'disabled' })).toMatchObject({
    kind: 'attention',
    code: 'authority-lost',
  }));

it('a ready checkpoint passes the entry check', async () => expect(await stopOf()).toBe('passed'));
