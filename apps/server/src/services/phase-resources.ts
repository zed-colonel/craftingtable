import { randomUUID } from 'node:crypto';
import type { ExecutionPhase, PhaseBlocker, Worktree } from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';
import type { ResolvedScope } from './execution-scope.js';
import { nativeApproval } from './native-verification-policy.js';

export class PhaseGateError extends ExecutionRequestError {
  constructor(readonly blockers: readonly PhaseBlocker[]) {
    super('conflict', blockers.map((b) => b.message).join('\n'));
  }
  get waiting() {
    return this.blockers.every(
      (b) =>
        (b.kind !== 'authorization' && b.kind !== 'review') ||
        (b.kind === 'authorization' && b.message.startsWith('Resource ')),
    );
  }
}
export function phaseResources(tx: StorageRepositories, r: ResolvedScope, phase: ExecutionPhase) {
  const resources: { key: string; capacity: number }[] = [];
  const blockers: PhaseBlocker[] = [];
  // Requirements inherit earlier phases; resource occupancy deliberately does not.
  for (const id of r.slice?.resources_by_phase[phase === 'accept' ? 'verify' : phase] ?? []) {
    const profile = r.definition.source.resource_profiles.find((p) => p.id === id);
    if (
      id === 'controlled-native-test-host' &&
      profile &&
      !profile.requires_hardware_virtualization &&
      nativeApproval(tx, r.item.workspaceId, r.scope)
    ) {
      resources.push({
        key: 'local-verification',
        capacity: tx.phaseScheduling.capacity('local-verification'),
      });
      continue;
    }
    if (
      id !== 'isolated-development-workspace' ||
      !profile ||
      profile.requires_hardware_virtualization ||
      profile.fixture_authorization_required
    ) {
      blockers.push({
        kind: 'authorization',
        message:
          id === 'controlled-native-test-host'
            ? 'Resource controlled-native-test-host needs a qualified environment approval. Open Dependency environments and evidence → Verification environments, audit this workstation, then approve native verification.'
            : `Resource ${id} has no managed execution adapter. Review its requirements in Verification environments; externally reviewed evidence remains available.`,
      });
      continue;
    }
    const key =
      phase === 'verify' || phase === 'accept' ? 'local-verification' : 'local-development';
    resources.push({ key, capacity: tx.phaseScheduling.capacity(key) });
  }
  if (phase === 'accept')
    resources.push({
      key: 'local-verification',
      capacity: tx.phaseScheduling.capacity('local-verification'),
    });
  if (phase === 'merge' && r.slice?.merge_lock) {
    const lock = r.definition.source.resource_locks.find((l) => l.id === r.slice?.merge_lock);
    const repo =
      r.binding.repositoryId &&
      tx.execution.sourceRepositories.find(r.item.workspaceId, r.binding.repositoryId);
    if (!lock || !repo || lock.repository !== r.binding.alias)
      blockers.push({
        kind: 'authorization',
        message: 'The merge resource does not match the frozen repository binding.',
      });
    else resources.push({ key: `repository:${repo.rootPath}`, capacity: 1 });
  }
  return { resources: [...new Map(resources.map((r) => [r.key, r])).values()], blockers };
}
export function resourceBlockers(
  tx: StorageRepositories,
  r: ResolvedScope,
  phase: ExecutionPhase,
  ownerId?: string,
) {
  const { resources, blockers } = phaseResources(tx, r, phase);
  const active = tx.phaseScheduling.active();
  for (const resource of resources) {
    const claims = active.filter((c) => c.resourceKey === resource.key && c.ownerId !== ownerId);
    const capacity = ['local-development', 'local-verification'].includes(resource.key)
      ? resource.capacity
      : Math.min(resource.capacity, ...claims.map((c) => c.capacity));
    if (claims.length >= capacity)
      blockers.push({
        kind: 'resource',
        message: `Waiting for ${resource.key}: ${claims.length}/${capacity} reservations occupied.`,
      });
  }
  return blockers;
}
export function reservePhase(
  tx: StorageRepositories,
  r: ResolvedScope,
  tree: Worktree,
  phase: ExecutionPhase,
  ownerId: string,
  at: string,
) {
  const blockers = resourceBlockers(tx, r, phase, ownerId);
  if (blockers.length) throw new PhaseGateError(blockers);
  for (const resource of phaseResources(tx, r, phase).resources) {
    if (
      tx.phaseScheduling
        .active()
        .some((c) => c.ownerId === ownerId && c.resourceKey === resource.key)
    )
      continue;
    tx.phaseScheduling.acquire({
      id: randomUUID(),
      workspaceId: tree.workspaceId,
      worktreeId: tree.id,
      ownerId,
      phase,
      resourceKey: resource.key,
      capacity: resource.capacity,
      acquiredAt: at,
    });
  }
}
/** All claims commit together before Git; any unavailable requirement leaves no claims. */
export async function withPhaseReservation<T>(
  storage: CraftingTableStorage,
  r: ResolvedScope | undefined,
  tree: Worktree,
  phase: ExecutionPhase,
  operation: () => Promise<T>,
): Promise<T> {
  if (!r) return operation();
  const ownerId = `operation:${randomUUID()}`;
  storage.transaction((tx) => reservePhase(tx, r, tree, phase, ownerId, new Date().toISOString()));
  try {
    return await operation();
  } finally {
    storage.transaction((tx) =>
      tx.phaseScheduling.release(ownerId, new Date().toISOString(), 'operation-finished'),
    );
  }
}
