import {
  asAuditEventId,
  asEventId,
  type ConcurrencyDefinition,
  type RuntimeGeneration,
} from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import type { RuntimeRefreshPreview } from '@craftingtable/contracts';
import type { StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import {
  currentScopeReceipt,
  scopeRuntimeChanges,
  submissionIssues,
} from './runtime-evidence-policy.js';
import { nativeApproval } from './native-verification-policy.js';
import { ExecutionRequestError } from './errors.js';

/** A disposable synchronous projection; the proposed generation is never written by preview. */
function withRuntime(tx: StorageRepositories, runtime: RuntimeGeneration): StorageRepositories {
  return mapReadSnapshot({
    ...tx,
    runtimeEvidence: {
      ...tx.runtimeEvidence,
      generations: (ws, id, revision) => {
        const saved = tx.runtimeEvidence.generations(ws, id, revision);
        return ws === runtime.workspaceId &&
          id === runtime.definitionId &&
          revision === runtime.bindingRevision
          ? [runtime, ...saved.filter((r) => r.id !== runtime.id)]
          : saved;
      },
      // Repository methods live on the prototype; keep them bound to the real repository.
      nativeApprovals: tx.runtimeEvidence.nativeApprovals.bind(tx.runtimeEvidence),
      submissions: tx.runtimeEvidence.submissions.bind(tx.runtimeEvidence),
      decisions: tx.runtimeEvidence.decisions.bind(tx.runtimeEvidence),
      run: tx.runtimeEvidence.run.bind(tx.runtimeEvidence),
      build: tx.runtimeEvidence.build.bind(tx.runtimeEvidence),
      addGeneration: tx.runtimeEvidence.addGeneration.bind(tx.runtimeEvidence),
      addNativeApproval: tx.runtimeEvidence.addNativeApproval.bind(tx.runtimeEvidence),
      addSubmission: tx.runtimeEvidence.addSubmission.bind(tx.runtimeEvidence),
      addDecision: tx.runtimeEvidence.addDecision.bind(tx.runtimeEvidence),
      addRun: tx.runtimeEvidence.addRun.bind(tx.runtimeEvidence),
      addBuild: tx.runtimeEvidence.addBuild.bind(tx.runtimeEvidence),
    },
  });
}

export function runtimeRefreshImpact(
  source: StorageRepositories,
  d: ConcurrencyDefinition,
  candidate: RuntimeGeneration,
): Pick<RuntimeRefreshPreview, 'evidence' | 'reviews' | 'nativeApproval'> {
  const tx = mapReadSnapshot(source),
    ws = d.workspaceId;
  const next = withRuntime(tx, candidate);
  const generations = tx.runtimeEvidence.generations(ws, d.id, candidate.bindingRevision);
  const binding = tx.imports
    .bindings(ws, d.id)
    .find((b) => b.revision === candidate.bindingRevision);
  const evidence: RuntimeRefreshPreview['evidence'] = [];
  const seen = new Set<string>();
  for (const item of binding?.bindings.flatMap((b) => b.workItems) ?? []) {
    for (const p of tx.scopeReceipts.list(ws, item.workItemId)) {
      const key = `${p.scope.kind}:${p.scope.sourceId}`;
      if (
        p.scope.definitionId !== d.id ||
        p.scope.bindingRevision !== candidate.bindingRevision ||
        seen.has(key)
      )
        continue;
      seen.add(key);
      const run = tx.runtimeEvidence.run(ws, p.reviewRunId);
      const reasons = scopeRuntimeChanges(tx, ws, p.scope, run?.runtimeId, candidate);
      const retained = currentScopeReceipt(next, ws, p);
      evidence.push({
        id: p.id,
        sourceId: p.scope.sourceId,
        kind: p.scope.kind,
        generation: generations.find((r) => r.id === run?.runtimeId)?.generation,
        disposition: retained
          ? 'retained'
          : currentScopeReceipt(tx, ws, p)
            ? 'reverify'
            : 'already-stale',
        reasons: retained
          ? ['Relevant dependency, environment and review authority inputs are unchanged.']
          : reasons.length
            ? reasons
            : ['Current source, repository policy or native approval requires fresh review.'],
      });
    }
  }
  const decisions = tx.runtimeEvidence.decisions(ws);
  for (const s of tx.runtimeEvidence.submissions(ws, d.id)) {
    const key = `${s.subject.kind}:${s.subject.sourceId}`;
    if (
      s.bindingRevision !== candidate.bindingRevision ||
      seen.has(key) ||
      !decisions.some((v) => v.submissionId === s.id && v.outcome === 'accepted')
    )
      continue;
    seen.add(key);
    const reasons = submissionIssues(next, d, candidate, s);
    evidence.push({
      id: s.id,
      sourceId: s.subject.sourceId,
      kind: s.subject.kind,
      generation: generations.find((r) => r.id === s.runtimeId)?.generation,
      disposition: reasons.length ? 'reverify' : 'retained',
      reasons: reasons.length
        ? reasons
        : ['Recorded subject inputs are unchanged; prerequisite gates still apply.'],
    });
  }
  const reviews: RuntimeRefreshPreview['reviews'] = [];
  for (const r of tx.roadmaps
    .list(ws)
    .filter(
      (r) =>
        r.status !== 'stopped' &&
        r.definition.crossProject?.definitionId === d.id &&
        r.definition.crossProject.bindingRevision === candidate.bindingRevision,
    )) {
    for (const a of r.attempts) {
      const entry = r.definition.entries.find((e) => e.id === a.entryId),
        scope = entry?.executionScope;
      if (a.recovery || !entry || !scope || scope.kind === 'slice') continue;
      const cycle = tx.execution.cycles.find(ws, a.cycleId);
      const env = cycle && tx.runtimeEvidence.run(ws, cycle.currentRunId);
      if (!cycle) continue;
      // Preflight can fail before either the agent or its environment is recorded.
      // Explicit refresh queues a guarded first review; it never fabricates evidence.
      const unstarted =
        ['paused', 'needs-attention'].includes(cycle.status) &&
        cycle.step === 'review' &&
        !tx.execution.runs.find(ws, cycle.currentRunId) &&
        tx.execution.worktrees.find(ws, cycle.worktreeId)?.status === 'active' &&
        tx.execution.runs.listForWorktree(ws, cycle.worktreeId).length === 0;
      if (
        !unstarted &&
        (!env || !scopeRuntimeChanges(tx, ws, scope, env.runtimeId, candidate).length)
      )
        continue;
      const recovery =
        r.scopeRecovery?.enabled &&
        r.attempts.some(
          (other) =>
            other.recovery &&
            other.recovery.phase !== 'completed' &&
            r.definition.entries.find((e) => e.id === other.entryId)?.workItemId ===
              entry.workItemId,
        );
      const action = recovery
        ? 'existing-recovery'
        : unstarted || ['completed', 'awaiting-merge'].includes(cycle.status)
          ? 'queue'
          : 'manual';
      reviews.push({
        roadmapId: r.id,
        attemptId: a.id,
        sourceId: scope.sourceId,
        action,
        reason: unstarted
          ? 'The first independent review never launched. It will retry with refreshed dependencies after plan acceptance and Resume.'
          : action === 'queue'
            ? 'Fresh independent review will run after plan acceptance and Resume; integrated source is retained.'
            : action === 'existing-recovery'
              ? 'The existing owning-slice recovery will verify with the refreshed dependencies; its repair round is retained.'
              : 'This unfinished review retains its questions or findings and existing recovery controls.',
      });
    }
  }
  return {
    evidence,
    reviews,
    nativeApproval: nativeApproval(next, ws, {
      kind: 'slice',
      definitionId: d.id,
      bindingRevision: candidate.bindingRevision,
      sourceId: '',
    })
      ? 'retained'
      : 'needs-approval',
  };
}

/** Runs inside the generation save transaction. Reservations do not start agents. */
export function queueRuntimeReviews(
  tx: StorageRepositories,
  context: AuthContext,
  runtime: RuntimeGeneration,
  reviews: RuntimeRefreshPreview['reviews'],
  at: string,
) {
  const ws = runtime.workspaceId;
  for (const roadmapId of new Set(
    reviews.filter((r) => r.action === 'queue').map((r) => r.roadmapId),
  )) {
    const r = tx.roadmaps.find(ws, roadmapId)!;
    const ids = new Set(
      reviews
        .filter((v) => v.roadmapId === roadmapId && v.action === 'queue')
        .map((v) => v.attemptId),
    );
    const updated = {
      ...r,
      version: r.version + 1,
      updatedAt: at,
      status: r.status === 'draft' ? ('draft' as const) : ('paused' as const),
      reason:
        'Dependency refresh saved. Accept the updated plan and Resume to run affected independent reviews.',
      attempts: r.attempts.map((a) =>
        ids.has(a.id)
          ? {
              ...a,
              dependencyRefresh: {
                runtimeId: runtime.id,
                generation: runtime.generation,
                sourceRunId: tx.execution.cycles.find(ws, a.cycleId)!.currentRunId,
              },
            }
          : a,
      ),
    };
    if (!tx.roadmaps.save(updated, r.version))
      throw new ExecutionRequestError('conflict', 'Roadmap changed during dependency refresh.');
    tx.audit.append({
      id: asAuditEventId(randomUUID()),
      workspaceId: ws,
      occurredAt: at,
      actorKind: 'user',
      actorUserId: context.user.id,
      sessionId: context.session.id,
      action: 'roadmap.updated',
      targetType: 'roadmap',
      targetId: r.id,
      outcome: 'succeeded',
      resultingVersion: updated.version,
      metadata: { action: 'dependency-refresh', runtimeId: runtime.id, queuedAttemptIds: [...ids] },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      workspaceId: ws,
      occurredAt: at,
      actorUserId: context.user.id,
      kind: 'roadmap-changed',
      payload: { roadmapId: r.id, status: updated.status, reason: updated.reason },
    });
  }
}
