import { effectiveDelegation, historicalReviewerRoles } from './roadmap-delegation-policy.js';
import type { WorkspaceId } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { assignedReviewMatches } from './agent-profile-policy.js';
export function adoptedDecisions(
  tx: StorageRepositories,
  ws: WorkspaceId,
  id: string,
  revision: number,
): ReadonlySet<string> {
  if (tx.imports.bindings(ws, id)[0]?.revision !== revision) return new Set();
  return new Set(
    tx.imports
      .adoptions(ws, id)
      .filter((a) => a.bindingRevision === revision)
      .flatMap((a) => a.decisionIds),
  );
}
export function mapAdopted(
  tx: StorageRepositories,
  ws: WorkspaceId,
  id: string,
  revision: number,
): boolean {
  const d = tx.imports.definition(ws, id),
    adopted = adoptedDecisions(tx, ws, id, revision);
  return (
    !!d &&
    tx.imports.bindings(ws, id)[0]?.revision === revision &&
    tx.imports.adoptions(ws, id).some((a) => a.bindingRevision === revision) &&
    d.source.decisions.every((x) => adopted.has(x.id))
  );
}

/** Operator-designated reviewer responsibilities, frozen with an actual delegated attempt. */
export function scopeReviewerRoles(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: import('@craftingtable/domain').ExecutionScope,
  runId?: string,
): readonly string[] {
  for (const roadmap of tx.roadmaps.list(ws)) {
    if (
      !roadmap.definition.crossProject ||
      !['running', 'paused', 'needs-attention'].includes(roadmap.status)
    )
      continue;
    for (const entry of roadmap.definition.entries) {
      if (
        !entry.executionScope ||
        entry.executionScope.definitionId !== scope.definitionId ||
        entry.executionScope.bindingRevision !== scope.bindingRevision ||
        entry.executionScope.sourceId !== scope.sourceId ||
        entry.executionScope.kind !== (scope.kind === 'slice' ? 'slice-verification' : scope.kind)
      )
        continue;
      const attempt = roadmap.attempts.find((a) => a.entryId === entry.id);
      const definition = attempt
        ? tx.roadmaps.history(ws, roadmap.id).find((d) => d.revision === attempt.definitionRevision)
        : roadmap.definition;
      const bound = definition?.entries.find((e) => e.id === entry.id);
      if (runId) {
        const run = tx.execution.runs.find(ws, runId as import('@craftingtable/domain').AgentRunId),
          cycle = attempt && tx.execution.cycles.find(ws, attempt.cycleId);
        if (
          !run ||
          !cycle ||
          cycle.currentRunId !== run.id ||
          run.worktreeId !== attempt?.worktreeId ||
          run.role !== 'review' ||
          !bound ||
          !assignedReviewMatches(roadmap, bound, run)
        )
          continue;
      }
      const run =
        runId && tx.execution.runs.find(ws, runId as import('@craftingtable/domain').AgentRunId);
      return bound
        ? run
          ? historicalReviewerRoles(roadmap, bound, run)
          : effectiveDelegation(roadmap, bound, definition!).reviewerRoles
        : [];
    }
  }
  return [];
}
