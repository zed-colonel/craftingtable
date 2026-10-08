import { approvedArchitectureDecisions } from './architecture-decision-policy.js';
import { snapshotCalculation } from './map-read-snapshot.js';
import { createHash } from 'node:crypto';
import {
  type ConcurrencyDefinition,
  type EvidenceSubmissionHead,
  mapCapabilities,
  type Roadmap,
  type RuntimeGeneration,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { bindingIssues } from './map-binding-policy.js';
import { mapAdopted } from './map-adoption-policy.js';

/**
 * The plan checkpoint: the single plan approval the stack owns, whatever its id (R-F2). It is
 * there whether or not its contract is the one the generator attests (`supportsPlanEvidence`).
 */
export function planCheckpoint(d: ConcurrencyDefinition): string | undefined {
  return mapCapabilities(d.source).planCheckpoint;
}
/**
 * Whether the saved-plan generator may attest the plan checkpoint. It attests only the known
 * setup observations; changed or imported obligations need external evidence until a
 * generator explicitly supports their meaning (a `plan-contract-changed` gap).
 */
export function supportsPlanEvidence(d: ConcurrencyDefinition): boolean {
  return !!mapCapabilities(d.source).planAcceptance;
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
  // Staged decisions enter the facts, and so the snapshot digest, as their full records (R-H4).
  const stages = approvedArchitectureDecisions(tx, d.workspaceId, d.id, binding?.revision ?? 0)
    .filter((s) => s.architectureDecision?.coverage === 'clauses')
    .flatMap((s) => tx.runtimeEvidence.submission(d.workspaceId, d.id, s.id) ?? []);
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
  s: EvidenceSubmissionHead,
): string[] {
  const g = s.generatedPlan;
  if (!g) return [];
  if (
    g.kind !== 'saved-plan-v1' ||
    s.subject.kind !== 'checkpoint' ||
    s.subject.sourceId !== planCheckpoint(d) ||
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
