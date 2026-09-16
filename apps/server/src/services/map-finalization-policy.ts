import { amendmentHoldsBinding } from './scope-lineage.js';
import type { Finalization, WorkspaceId, PlanVersionId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { activeRuntime, parentAccepted } from './runtime-evidence-policy.js';
import { mapAdopted } from './map-adoption-policy.js';
import { ExecutionRequestError } from './errors.js';
export function mapProjectReadiness(
  tx: StorageRepositories,
  ws: WorkspaceId,
  definitionId: string,
  revision: number,
) {
  const d = tx.imports.definition(ws, definitionId),
    binding = tx.imports.bindings(ws, definitionId).find((b) => b.revision === revision);
  if (!d || !binding) return [];
  return binding.bindings.flatMap((b) => {
    if (!b.projectId || !b.planVersionId) return [];
    const items = tx.planning.workItems.listForVersion(ws, b.planVersionId),
      parents = d.source.work_items.filter((p) => p.repository === b.alias);
    const accepted = parents.filter((p) => parentAccepted(tx, ws, d.id, revision, p.id)).length;
    const finalization = tx.execution.finalizations
      .list(ws)
      .find((f) => f.planVersionId === b.planVersionId && f.status !== 'stopped');
    const blockers: string[] = [];
    if (
      tx.amendments.superseded(ws, d.id, revision) ||
      tx.imports.bindings(ws, d.id)[0]?.revision !== revision
    )
      blockers.push('This exact binding was superseded; use its reviewed replacement.');
    if (tx.planning.projects.find(ws, b.projectId)?.activePlanVersionId !== b.planVersionId)
      blockers.push('The bound plan is not active.');
    if (!mapAdopted(tx, ws, d.id, revision))
      blockers.push('Adopt the exact map binding and its decisions.');
    if (!activeRuntime(tx, ws, d.id, revision))
      blockers.push('Configure the pinned dependency environment.');
    if (amendmentHoldsBinding(tx, ws, d.id, revision))
      blockers.push('Decide the pending planning amendment first.');
    if (
      items.some((i) => i.status !== 'completed') ||
      parents.length !== items.length ||
      accepted !== parents.length
    )
      blockers.push(
        'Every original plan work item requires current parent acceptance. Completing a partial target does not complete the plan.',
      );
    const settings = tx.execution.branchSettings.find(ws, b.planVersionId);
    if (
      settings?.repositoryId !== b.repositoryId ||
      settings?.integrationBranch !== b.integrationBranch ||
      settings?.version !== b.branchSettingsVersion
    )
      blockers.push('Reconcile changed branch settings.');
    return [
      {
        alias: b.alias,
        projectId: b.projectId,
        planVersionId: b.planVersionId,
        accepted,
        total: items.length,
        status:
          finalization?.status === 'completed'
            ? 'promoted'
            : finalization
              ? 'finalizing'
              : blockers.length
                ? 'blocked'
                : 'ready',
        blockers,
        integrationBranch: b.integrationBranch ?? '',
        ...(finalization
          ? { finalizationId: finalization.id, integrationSha: finalization.integrationSha }
          : {}),
      },
    ];
  });
}
/** Saved roadmap binding is authority; no implicit latest-plan/map selection. */
export function finalizationMapContext(
  tx: StorageRepositories,
  ws: WorkspaceId,
  plan: PlanVersionId,
): Finalization['mapContext'] {
  const candidates = new Map<string, NonNullable<Finalization['mapContext']>>();
  const matching = tx.roadmaps.list(ws).filter((r) => {
    const c = r.definition.crossProject;
    return (
      c &&
      !tx.amendments.superseded(ws, c.definitionId, c.bindingRevision) &&
      tx.imports
        .bindings(ws, c.definitionId)
        .find((b) => b.revision === c.bindingRevision)
        ?.bindings.some((b) => b.planVersionId === plan)
    );
  });
  const delegated = matching.filter((r) =>
    ['running', 'paused', 'needs-attention'].includes(r.status),
  );
  const retained = matching.filter((r) => r.status !== 'stopped');
  for (const roadmap of delegated.length ? delegated : retained.length ? retained : matching) {
    const c = roadmap.definition.crossProject;
    if (!c || tx.amendments.superseded(ws, c.definitionId, c.bindingRevision)) continue;
    const b = tx.imports
      .bindings(ws, c.definitionId)
      .find((b) => b.revision === c.bindingRevision)
      ?.bindings.find((b) => b.planVersionId === plan);
    if (!b) continue;
    const readiness = mapProjectReadiness(tx, ws, c.definitionId, c.bindingRevision).find(
      (p) => p.planVersionId === plan,
    );
    if (readiness?.blockers.length)
      throw new ExecutionRequestError('conflict', readiness.blockers.join(' '));
    candidates.set(`${c.definitionId}:${c.bindingRevision}`, {
      definitionId: c.definitionId,
      bindingRevision: c.bindingRevision,
      runtimeId: activeRuntime(tx, ws, c.definitionId, c.bindingRevision)!.id,
      alias: b.alias,
    });
  }
  if (candidates.size > 1)
    throw new ExecutionRequestError(
      'conflict',
      'Multiple roadmap bindings cover this plan. Reconcile them before finalization.',
    );
  return [...candidates.values()][0];
}
export function assertFinalizationMap(tx: StorageRepositories, f: Finalization) {
  if (!f.mapContext) return;
  const current = finalizationMapContext(tx, f.workspaceId, f.planVersionId);
  if (
    !current ||
    current.definitionId !== f.mapContext.definitionId ||
    current.bindingRevision !== f.mapContext.bindingRevision ||
    current.runtimeId !== f.mapContext.runtimeId
  )
    throw new ExecutionRequestError(
      'conflict',
      'Finalization map or pinned dependency environment changed. Stop and prepare a new finalization after reconciliation.',
    );
}
/** Promotion changes the provider authority; downstream pins still require explicit review. */
export function providerBranch(
  tx: StorageRepositories,
  ws: WorkspaceId,
  b: { planVersionId?: PlanVersionId; integrationBranch?: string },
): string | undefined {
  const completion = b.planVersionId && tx.planning.queries.versionCompletion(ws, b.planVersionId);
  return completion ? completion.targetBranch : b.integrationBranch;
}
