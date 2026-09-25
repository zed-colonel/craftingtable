import { approvedArchitectureDecisions } from './architecture-decision-policy.js';
import { snapshotCalculation } from './map-read-snapshot.js';
import { createHash } from 'node:crypto';
import type {
  ConcurrencyDefinition,
  EvidenceSubmission,
  Roadmap,
  RuntimeGeneration,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { bindingIssues } from './map-binding-policy.js';
import { mapAdopted } from './map-adoption-policy.js';

export const PLAN_CHECKPOINT = 'STACK-PLAN-ACCEPTED';
// This generator attests only these known setup observations. Changed/imported obligations
// require external evidence until a generator explicitly supports their meaning.
export const PLAN_REQUIREMENTS = [
  'approved map digest and all three exact source archive/source-file digests',
  'exact WI/EXO application project/plan-version bindings and the immutable implemented AQ source/build dependency binding',
  'approval of CS-D01 through CS-D18, or a separately versioned replacement definition',
  'configured independent reviewers, version/evidence bindings, target selection, and resources',
] as const;
export const PLAN_CRITERIA = [
  'Map structure is valid, source hashes match, and the expanded state graph is acyclic.',
  'All draft decisions are explicitly approved for this map digest.',
  'Application resolves exact project/plan-version bindings atomically; missing bindings fail closed.',
] as const;
function same(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
}
export function supportsPlanEvidence(d: ConcurrencyDefinition): boolean {
  const c = d.source.checkpoints.find((c) => c.id === PLAN_CHECKPOINT);
  const p = d.source.evidence_profiles.find((p) => p.id === c?.evidence_profile);
  return (
    !!c &&
    c.kind === 'plan_approval' &&
    c.owner === 'stack' &&
    !c.requires.length &&
    !!p &&
    same(p.required_evidence, PLAN_REQUIREMENTS) &&
    same(c.pass_criteria, PLAN_CRITERIA) &&
    same(p.reviewer_roles, ['stack-integration-owner']) &&
    !d.source.acceptance_coverage.some((x) => x.checkpoint === c.id) &&
    !d.source.baseline_acceptance_coverage.some((x) => x.capability_gate === c.id)
  );
}
function collectSavedPlanSnapshot(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmap: Roadmap,
  runtime: RuntimeGeneration | undefined,
) {
  const c = roadmap.definition.crossProject;
  const binding = tx.imports.bindings(d.workspaceId, d.id)[0];
  const issues: string[] = [];
  if (!supportsPlanEvidence(d))
    issues.push(
      'This plan checkpoint has unsupported obligations. Submit independently reviewed evidence manually.',
    );
  if (!c || c.definitionId !== d.id || c.bindingRevision !== binding?.revision)
    issues.push('Save the roadmap with the current exact map binding.');
  if (!binding) issues.push('Save exact plan bindings first.');
  else issues.push(...bindingIssues(tx, d.workspaceId, d.id, binding.revision));
  if (!binding || !mapAdopted(tx, d.workspaceId, d.id, binding.revision))
    issues.push('Review and adopt all scheduling proposals for the saved binding.');
  if (!runtime || runtime.bindingRevision !== binding?.revision)
    issues.push('Save the pinned dependency environment first.');
  if (tx.amendments.list(d.workspaceId).some((a) => !a.decision))
    issues.push(
      'Resolve the pending planning amendment before generating or accepting plan evidence.',
    );
  if (roadmap.status === 'stopped')
    issues.push('This roadmap is stopped. Select a current saved roadmap.');
  const adoptions = tx.imports
    .adoptions(d.workspaceId, d.id)
    .filter((a) => a.bindingRevision === binding?.revision);
  const stages = approvedArchitectureDecisions(
    tx,
    d.workspaceId,
    d.id,
    binding?.revision ?? 0,
  ).filter((s) => s.architectureDecision?.coverage === 'clauses');
  const facts = {
    ...(stages.length ? { architectureStaging: stages } : {}),
    map: {
      id: d.id,
      mapId: d.mapId,
      revision: d.revision,
      digest: d.digest,
      archive: tx.imports.archiveInfo(d.workspaceId, d.archiveId),
      validation: {
        outcome: 'accepted on import',
        nodes: d.graphNodeCount,
        edges: d.graphEdgeCount,
      },
      sourceFiles: d.source.source_files,
      decisions: d.source.decisions,
      sourceArchives: d.source.repositories.map((r) => ({
        alias: r.id,
        revision: r.artifact_revision,
        role: r.role,
      })),
    },
    binding,
    planArchives:
      binding?.bindings.flatMap((b) =>
        b.planVersionId
          ? tx.imports.planLinks(d.workspaceId, b.planVersionId).map((l) => ({
              alias: b.alias,
              planVersionId: b.planVersionId,
              archive: tx.imports.archiveInfo(d.workspaceId, l.archiveId),
            }))
          : [],
      ) ?? [],
    // Additional adoptions of the same proposal set do not invalidate accepted configuration.
    adoption: adoptions.at(-1),
    runtime,
    roadmap: roadmap.definition,
    resources: {
      profiles: d.source.resource_profiles,
      locks: d.source.resource_locks,
      developmentCapacity: tx.phaseScheduling.capacity('local-development'),
      verificationCapacity: tx.phaseScheduling.capacity('local-verification'),
    },
  };
  const snapshotDigest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return { facts, snapshotDigest, issues };
}
export function savedPlanSnapshot(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmap: Roadmap,
  runtime: RuntimeGeneration | undefined,
) {
  return snapshotCalculation(
    tx,
    `saved-plan:${d.id}:${roadmap.id}:${roadmap.definition.revision}:${runtime?.id ?? 'none'}`,
    () => collectSavedPlanSnapshot(tx, d, roadmap, runtime),
  );
}
export function generatedPlanIssues(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  runtime: RuntimeGeneration | undefined,
  s: EvidenceSubmission,
): string[] {
  const g = s.generatedPlan;
  if (!g) return [];
  if (
    g.kind !== 'saved-plan-v1' ||
    s.subject.kind !== 'checkpoint' ||
    s.subject.sourceId !== PLAN_CHECKPOINT ||
    !supportsPlanEvidence(d)
  )
    return ['Generated plan evidence cannot satisfy this subject.'];
  const roadmap = tx.roadmaps.find(d.workspaceId, g.roadmapId);
  if (!roadmap) return ['The saved roadmap is unavailable.'];
  if (
    tx.roadmaps
      .list(d.workspaceId)
      .some(
        (r) =>
          r.id !== roadmap.id &&
          r.definition.crossProject?.definitionId === d.id &&
          ['running', 'paused', 'needs-attention'].includes(r.status),
      )
  )
    return ['Generate plan evidence for the currently delegated roadmap.'];
  const snapshot = savedPlanSnapshot(tx, d, roadmap, runtime);
  return [
    ...snapshot.issues,
    ...(roadmap.definition.revision !== g.definitionRevision ||
    snapshot.snapshotDigest !== g.snapshotDigest
      ? ['Saved configuration changed. Generate and review new plan-acceptance evidence.']
      : []),
  ];
}
