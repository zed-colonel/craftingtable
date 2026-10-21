import { createHash } from 'node:crypto';
import {
  type ConcurrencyDefinition,
  type EvidenceSubmissionHead,
  type ExecutionScope,
  isInvestigationRun,
  mapCapabilities,
  type WorkspaceId,
  type ConcurrencyDefinitionId,
  type Worktree,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { snapshotCalculation } from './map-read-snapshot.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/**
 * Only the known decision-owner review contract is supported, never test/qualification gates.
 * Any other contract is a `decision-contract-changed` gap and needs independent evidence.
 */
export function supportsArchitectureDecision(d: ConcurrencyDefinition, id: string) {
  return mapCapabilities(d.source).architectureDecisions.some((c) => c.checkpointId === id);
}
/** The role that records a supported decision, as the map declares it. */
export function decisionReviewerRole(d: ConcurrencyDefinition, id: string) {
  return mapCapabilities(d.source).architectureDecisions.find((c) => c.checkpointId === id)
    ?.reviewerRole;
}
export function decisionBindingDigest(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  revision: number,
) {
  return snapshotCalculation(
    tx,
    `decision-binding:${d.workspaceId}:${d.id}:${d.digest}:${revision}`,
    () =>
      hash({
        map: d.digest,
        binding: tx.imports.bindings(d.workspaceId, d.id).find((b) => b.revision === revision),
      }),
  );
}
export function architectureDecisionIssues(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  s: EvidenceSubmissionHead,
): string[] {
  const a = s.architectureDecision;
  if (!a) return ['Missing architecture decision proposal.'];
  const issues: string[] = [];
  if (s.subject.kind !== 'checkpoint' || !supportsArchitectureDecision(d, s.subject.sourceId))
    issues.push(
      'This checkpoint requires an unsupported review contract; submit independent evidence.',
    );
  if (
    tx.imports.bindings(d.workspaceId, d.id)[0]?.revision !== s.bindingRevision ||
    a.bindingDigest !== decisionBindingDigest(tx, d, s.bindingRevision)
  )
    issues.push('The exact plan binding changed. Prepare a new decision proposal.');
  if (!a.proposal.trim() || !a.sourceReferences.trim())
    issues.push('Decision text and source references are required.');
  // Full architecture approval can still name separate implementation/test obligations.
  // Only partial coverage may substitute gates for named consumers.
  if (a.coverage === 'full' && a.consumers.length)
    issues.push('Full approval cannot also stage or defer clauses.');
  if (a.coverage === 'clauses') {
    if (!a.consumers.length || !a.retainedObligations.trim())
      issues.push('Staging needs named consumers and explicit retained full obligations.');
    if (new Set(a.consumers.map((c) => c.sliceId)).size !== a.consumers.length)
      issues.push('Each consumer slice may appear only once.');
    for (const consumer of a.consumers) {
      const slice = d.source.slices.find((slice) => slice.id === consumer.sliceId);
      if (!slice) {
        issues.push(`Unknown consumer ${consumer.sliceId}.`);
        continue;
      }
      const original = [
        ...slice.start_requires,
        ...slice.merge_requires,
        ...slice.verify_requires,
      ].filter((r) => r.kind === 'checkpoint' && r.id === s.subject.sourceId);
      if (consumer.replacesFullCheckpoint !== !!original.length)
        issues.push(
          `${consumer.sliceId}: explicitly acknowledge replacement of its existing full-checkpoint gate, or addition of a new clause gate.`,
        );
      if (
        slice.start_requires.some((r) => r.kind === 'checkpoint' && r.id === s.subject.sourceId) &&
        consumer.phase !== 'start'
      )
        issues.push('An existing start gate cannot move to merge.');
    }
    // A staged definition cannot erase the last downstream consumer of the full ADR.
    if (
      !d.source.slices.some(
        (slice) =>
          !a.consumers.some((c) => c.sliceId === slice.id) &&
          [...slice.start_requires, ...slice.merge_requires, ...slice.verify_requires].some(
            (r) => r.kind === 'checkpoint' && r.id === s.subject.sourceId,
          ),
      )
    )
      issues.push('Retain at least one later slice requiring the full architecture checkpoint.');
  }
  return issues;
}
/** Current immutable approvals. Staged approval never passes the full checkpoint. */
export function approvedArchitectureDecisions(
  tx: StorageRepositories,
  ws: WorkspaceId,
  id: ConcurrencyDefinitionId,
  revision: number,
) {
  return snapshotCalculation(tx, `approved-decisions:${ws}:${id}:${revision}`, () => {
    const d = tx.imports.definition(ws, id);
    if (!d) return [];
    const decisions = tx.runtimeEvidence.decisions(ws);
    const seen = new Set<string>();
    return tx.runtimeEvidence.submissions(ws, id).filter((s) => {
      if (
        !s.architectureDecision ||
        s.bindingRevision !== revision ||
        !decisions.some((a) => a.submissionId === s.id && a.outcome === 'accepted') ||
        architectureDecisionIssues(tx, d, s).length
      )
        return false;
      const key = `${s.subject.sourceId}:${s.architectureDecision.coverage}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}
export function scopeArchitectureDecisions(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
): ReturnType<typeof approvedArchitectureDecisions> {
  // Once per read snapshot for a scope: its blockers, receipts and the map's coverage all ask
  // (R-D8). Only a parent acceptance reads its kind.
  return snapshotCalculation(tx, scopeDecisionsKey(ws, scope), () =>
    decisionsForScope(tx, ws, scope),
  );
}
/**
 * The memo key of `scopeArchitectureDecisions`: the scope's definition, revision and source, and
 * whether it is a parent acceptance, the only kind its answer tells apart (R-D8).
 */
export function scopeDecisionsKey(ws: WorkspaceId, scope: ExecutionScope): string {
  return JSON.stringify([
    'scope-architecture-decisions',
    ws,
    scope.definitionId,
    scope.bindingRevision,
    scope.sourceId,
    scope.kind === 'parent-acceptance',
  ]);
}
/** The slices a scope reads decisions for: its own, or a parent acceptance's every slice. */
function scopeSlices(d: ConcurrencyDefinition, scope: ExecutionScope) {
  const slice = d.source.slices.find((s) => s.id === scope.sourceId);
  const parent = d.source.work_items.find((p) => p.id === (slice?.work_item ?? scope.sourceId));
  return scope.kind === 'parent-acceptance'
    ? d.source.slices.filter((s) => s.work_item === parent?.id)
    : slice
      ? [slice]
      : [];
}
/** Whether a scope's decision packet holds this decision: one its slices require, or name. */
function scopeUsesDecision(
  slices: ReturnType<typeof scopeSlices>,
  s: Pick<EvidenceSubmissionHead, 'subject' | 'architectureDecision'>,
) {
  return (
    slices.some((slice) =>
      [...slice.start_requires, ...slice.merge_requires, ...slice.verify_requires].some(
        (r) => r.kind === 'checkpoint' && r.id === s.subject.sourceId,
      ),
    ) ||
    !!s.architectureDecision?.consumers.some((c) => slices.some((slice) => slice.id === c.sliceId))
  );
}
function decisionsForScope(tx: StorageRepositories, ws: WorkspaceId, scope: ExecutionScope) {
  const d = tx.imports.definition(ws, scope.definitionId);
  if (!d) return [];
  const slices = scopeSlices(d, scope);
  return approvedArchitectureDecisions(tx, ws, scope.definitionId, scope.bindingRevision).filter(
    (s) => scopeUsesDecision(slices, s),
  );
}
/**
 * The active worktrees whose decision packet approving this proposal changes (R-B6, decision 6):
 * those of a scope on its binding revision whose slices require its checkpoint, or that a clause
 * decision names as a consumer, as `decisionsForScope` reads them. A packet holds the newest
 * approval per checkpoint and coverage, so the approval it displaces leaves its own consumers'
 * packets too (increment 3 review M-1).
 */
export function decisionAffectedTrees(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  s: EvidenceSubmissionHead,
  displaced: readonly Pick<
    EvidenceSubmissionHead,
    'subject' | 'architectureDecision'
  >[] = approvedArchitectureDecisions(tx, d.workspaceId, d.id, s.bindingRevision).filter(
    (a) =>
      a.subject.sourceId === s.subject.sourceId &&
      a.architectureDecision?.coverage === s.architectureDecision?.coverage,
  ),
): readonly Worktree[] {
  return tx.execution.worktrees.listActive(d.workspaceId).filter((tree) => {
    if (
      tree.executionScope?.definitionId !== d.id ||
      tree.executionScope.bindingRevision !== s.bindingRevision
    )
      return false;
    const slices = scopeSlices(d, tree.executionScope);
    return [s, ...displaced].some((decision) => scopeUsesDecision(slices, decision));
  });
}
/** What a tree has in flight that read its decision packet and would finish against it. */
export interface DecisionTreeWork {
  readonly branchName: string;
  readonly liveRun: boolean;
  readonly launching: boolean;
  readonly phaseReserved: boolean;
  readonly mergeReserved: boolean;
  readonly review?: 'reassessment' | 'security' | 'checkpoint';
}
export function decisionTreeWork(tx: StorageRepositories, tree: Worktree): DecisionTreeWork {
  const ws = tree.workspaceId;
  const cycle = tx.execution.cycles.activeForWorktree(ws, tree.id);
  // A question stop's investigation reads no packet and freezes no digest (review L-4).
  const liveRun = tx.execution.runs
    .liveForWorktree(ws, tree.id)
    .some((run) => !isInvestigationRun(run));
  // A review is at work while its cycle runs or its session is live; one left at a stop waits
  // for the operator and reads the packet again when resumed (R-B6 increment 2 review HIGH-1).
  const review =
    cycle?.status === 'running' || liveRun ? cycle?.workflow?.activeReview?.kind : undefined;
  return {
    branchName: tree.branchName,
    liveRun,
    launching: tx.maintenance
      .launchReservations()
      .some((r) => r.workspaceId === ws && r.worktreeId === tree.id),
    phaseReserved: tx.phaseScheduling.active().some((r) => r.worktreeId === tree.id),
    mergeReserved: tx.execution.merges.latest(ws, tree.id)?.status === 'reserved',
    ...(review ? { review } : {}),
  };
}
/**
 * What approving a decision waits for on its affected trees (R-B6, decision 6): each one's work in
 * flight that read the packet it changes, which would otherwise finish against a stale one and be
 * refused at its merge, receipt or launch. A run (or its launch), a reserved merge (merged without
 * the digest checked again), a controller review (accepted after an await) and a phase
 * reservation's holder. A cycle between steps waits for nothing: its next launch reads the new
 * packet.
 */
export function decisionApprovalWaits(trees: readonly DecisionTreeWork[]): string[] {
  return trees.flatMap((t) => {
    const work = [
      ...(t.liveRun ? ['the live run'] : []),
      ...(t.launching ? ['the run being launched'] : []),
      ...(t.review ? [`the ${t.review} review`] : []),
      ...(t.mergeReserved ? ['the merge'] : []),
      ...(t.phaseReserved && !t.liveRun && !t.launching && !t.mergeReserved
        ? ['the work holding its phase reservation']
        : []),
    ];
    if (!work.length) return [];
    const things =
      work.length === 1 ? work[0] : `${work.slice(0, -1).join(', ')} and ${work.at(-1)}`;
    return [
      `Wait for ${things} on ${t.branchName} to finish${t.liveRun ? ', or end the run' : ''}: this decision is one of its inputs.`,
    ];
  });
}
export function architectureDecisionDigest(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
): string | undefined {
  const decisions = scopeArchitectureDecisions(tx, ws, scope);
  return decisions.length ? hash(decisions.map((s) => s.id).sort()) : undefined;
}
export function stagedDecision(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
  checkpoint: string,
) {
  if (scope.kind === 'parent-acceptance') return undefined;
  return scopeArchitectureDecisions(tx, ws, scope).find(
    (s) =>
      s.subject.sourceId === checkpoint &&
      s.architectureDecision?.coverage === 'clauses' &&
      s.architectureDecision.consumers.some((c) => c.sliceId === scope.sourceId),
  );
}

/** Supply exact approved choices without repeating each source design report in every run. */
export function architectureDecisionPacket(
  tx: StorageRepositories,
  ws: WorkspaceId,
  scope: ExecutionScope,
) {
  return decisionPacketEntries(tx, ws, scopeArchitectureDecisions(tx, ws, scope));
}
/** Accepted decisions as a reviewer is given them: the decision record and its approval. */
export function decisionPacketEntries(
  tx: StorageRepositories,
  ws: WorkspaceId,
  submissions: readonly EvidenceSubmissionHead[],
) {
  const approvals = tx.runtimeEvidence.decisions(ws);
  return submissions.map((s) => ({
    submissionId: s.id,
    checkpoint: s.subject.sourceId,
    definitionId: s.definitionId,
    bindingRevision: s.bindingRevision,
    decision: s.architectureDecision,
    approval: approvals.find((a) => a.submissionId === s.id && a.outcome === 'accepted'),
    sourceRunId: s.sourceRunId,
    sourceRunDigest: s.sourceRunDigest,
    artifacts: s.artifacts.map((a) => ({ name: a.name, digest: a.digest })),
  }));
}
