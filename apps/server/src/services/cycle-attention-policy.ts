import {
  type AttentionClaim,
  type CycleAttention,
  type CycleAttentionCode,
  cycleAttention,
  effectiveCycleAttention,
  mergeAdoptsChecks,
  type WorkCycle,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { attemptDelegation } from './roadmap-delegation-policy.js';
import { scopeMergeWait, scopeReviewWait } from './scope-repair.js';
import { automatedScopeRecoveryWait, roadmapCarriesRound } from './scope-recovery-policy.js';
import { cycleOwnership } from './cycle-ownership.js';

/**
 * The attention a stopped cycle declares right now (R-A3, NOTIF-02).
 *
 * The code comes from the transition that stopped the cycle. On top of it the controller
 * records whether automation will act next: while a roadmap policy, scope recovery or
 * prerequisite work claims the stop it is controller-owned, and the claim lapses on its own
 * when that automation no longer applies (a paused roadmap, a hold, a changed policy).
 * A slice waiting for merge approval whose merge requirements are unmet is at a different
 * stop than one the operator can merge. The notification service and the browser read the
 * result; neither predicts automation itself.
 */
export function currentCycleAttention(
  storage: StorageRepositories,
  cycle: WorkCycle,
): CycleAttention | undefined {
  const declared = effectiveCycleAttention(cycle);
  if (!declared) return undefined;
  const tx = mapReadSnapshot(storage);
  let code: CycleAttentionCode =
    declared.code === 'merge-requirements' ? 'merge-approval' : declared.code;
  let detail = code === declared.code ? declared.detail : undefined;
  if (code === 'merge-approval') {
    const requirements = scopeMergeWait(tx, cycle);
    if (requirements) {
      code = 'merge-requirements';
      detail = requirements;
    }
  }
  const prerequisites = scopeReviewWait(tx, cycle);
  const claim: AttentionClaim | undefined = automatedScopeRecoveryWait(tx, cycle)
    ? 'scope-recovery'
    : prerequisites
      ? 'prerequisite-work'
      : roadmapClaim(tx, cycle);
  const shown = claim === 'prerequisite-work' ? prerequisites : detail;
  return cycleAttention(code, declared.refs, {
    ...(claim ? { claim } : {}),
    ...(shown ? { detail: shown } : {}),
    ...(declared.repairAttempts ? { repairAttempts: declared.repairAttempts } : {}),
  });
}

/** A running roadmap whose policy completes this stop itself, exactly as it schedules it. */
function roadmapClaim(tx: StorageRepositories, cycle: WorkCycle): AttentionClaim | undefined {
  const owner = cycleOwnership(tx, cycle);
  if (owner?.roadmap.status !== 'running') return undefined;
  const { roadmap, attempt } = owner;
  if (roadmap.entryHolds?.[attempt.entryId]) return undefined;
  if (
    attempt.recovery &&
    (!roadmapCarriesRound(roadmap, attempt) || roadmap.entryHolds?.[attempt.recovery.sourceEntryId])
  )
    return undefined;
  const delegation = attemptDelegation(tx, roadmap, attempt);
  const tree = tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
  if (cycle.status === 'awaiting-merge') {
    if (tree?.executionScope?.kind === 'slice-verification') return 'roadmap-verification';
    if (tree?.executionScope?.kind === 'parent-acceptance')
      return delegation?.definition.crossProject?.parentAcceptance === 'automatic'
        ? 'roadmap-acceptance'
        : undefined;
    // A merge that adopts check definitions is a person's (R-G13 increment 5).
    if (
      delegation?.automation.integrationMerge === 'automatic' &&
      !mergeAdoptsChecks(effectiveCycleAttention(cycle))
    )
      return 'roadmap-merge';
  }
  if (
    cycle.integrationResolution?.status === 'detected' &&
    delegation?.automation.integrationConflicts === 'automatic'
  )
    return 'conflict-automation';
  return undefined;
}
