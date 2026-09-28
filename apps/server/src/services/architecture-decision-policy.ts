import { createHash } from 'node:crypto';
import type {
  ConcurrencyDefinition,
  EvidenceSubmission,
  ExecutionScope,
  WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { snapshotCalculation } from './map-read-snapshot.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requirements = [
  'accepted decision artifact digest and revision',
  'source contract and affected schema or protocol references',
  'decision owner approval and applicability to the active plan generation',
];
/** Only the known decision-owner review contract is supported, never test/qualification gates. */
export function supportsArchitectureDecision(d: ConcurrencyDefinition, id: string) {
  const c = d.source.checkpoints.find((c) => c.id === id);
  const p = d.source.evidence_profiles.find((p) => p.id === c?.evidence_profile);
  return (
    !!c &&
    c.kind === 'architecture_decision' &&
    !!p &&
    p.independence_required &&
    p.reviewer_roles.length === 1 &&
    p.reviewer_roles[0] === 'repository-maintainer' &&
    p.required_evidence.length === requirements.length &&
    requirements.every((r) => p.required_evidence.includes(r)) &&
    !d.source.acceptance_coverage.some((a) => a.checkpoint === id) &&
    !d.source.baseline_acceptance_coverage.some((a) => a.capability_gate === id)
  );
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
  s: EvidenceSubmission,
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
  id: string,
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
) {
  const d = tx.imports.definition(ws, scope.definitionId);
  if (!d) return [];
  const slice = d.source.slices.find((s) => s.id === scope.sourceId);
  const parent = d.source.work_items.find((p) => p.id === (slice?.work_item ?? scope.sourceId));
  const slices =
    scope.kind === 'parent-acceptance'
      ? d.source.slices.filter((s) => s.work_item === parent?.id)
      : slice
        ? [slice]
        : [];
  const checkpoints = new Set(
    slices
      .flatMap((s) => [...s.start_requires, ...s.merge_requires, ...s.verify_requires])
      .filter((r) => r.kind === 'checkpoint')
      .map((r) => r.id),
  );
  return approvedArchitectureDecisions(tx, ws, scope.definitionId, scope.bindingRevision).filter(
    (s) =>
      checkpoints.has(s.subject.sourceId) ||
      s.architectureDecision?.consumers.some((c) => slices.some((slice) => slice.id === c.sliceId)),
  );
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
  submissions: readonly EvidenceSubmission[],
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
