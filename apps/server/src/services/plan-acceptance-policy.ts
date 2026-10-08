import { approvedArchitectureDecisions } from './architecture-decision-policy.js';
import { snapshotCalculation } from './map-read-snapshot.js';
import { createHash } from 'node:crypto';
import {
  type ConcurrencyDefinition,
  type EvidenceSubmissionHead,
  mapCapabilities,
  PLAN_ACCEPTANCE_INPUTS,
  type PlanAcceptanceInput,
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
/**
 * Frozen (R-C6 D3): the facts saved-plan-v1 records are bound to, hashed as they always were.
 * v1 records keep validating against this digest, so nothing re-opens at deploy. Plan
 * acceptance itself is bound to the facts' inputs (`planAcceptanceInputs`).
 */
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

/**
 * The saved facts as plan acceptance reads them: the shape `collectSavedPlanSnapshot` builds
 * and saved-plan-v1 records keep as artifacts, so a v1 record's inputs are read back the same
 * way. Only the fields the inputs use are named.
 */
interface SavedPlanFacts {
  readonly architectureStaging?: readonly {
    readonly id: string;
    readonly subject: { readonly sourceId: string };
    readonly architectureDecision?: unknown;
  }[];
  readonly map: {
    readonly sourceArchives: readonly { readonly alias: string; readonly role: string }[];
  };
  readonly binding?: unknown;
  readonly planArchives: unknown;
  readonly adoption?: { readonly decisionIds: readonly string[] };
  readonly runtime?: {
    readonly pins: readonly {
      readonly alias: string;
      readonly ref?: string;
      readonly packages: readonly { readonly name: string }[];
    }[];
  };
  readonly roadmap: {
    readonly crossProject?: { readonly targetId: string; readonly selection: string };
    readonly entries: readonly {
      readonly id: string;
      readonly workItemId: string;
      readonly reviewerRoles?: readonly string[];
      readonly executionScope?: { readonly kind: string; readonly sourceId: string };
    }[];
  };
  readonly resources: { readonly profiles: unknown; readonly locks: unknown };
}
export type PlanAcceptanceInputs = { readonly [K in PlanAcceptanceInput]: unknown };
const byKey =
  <T>(key: (value: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
/**
 * What plan acceptance covers (R-C6 D1): the map's identity and archives; the binding and plan
 * archives; the adopted scheduling decisions; decisions with staged clauses (ADR-059); each
 * entry's reviewer roles; the target and selection; the map's resource profiles and locks; and
 * the implemented-upstream pins. Names, instructions, model profiles, automation, policy
 * (parent acceptance included), timestamps, consumer integration pins (ADR-069) and host
 * capacities are not inputs, and neither are the saved revision or the runtime generation.
 */
export function planAcceptanceInputs(facts: SavedPlanFacts): PlanAcceptanceInputs {
  const upstream = new Set(
    facts.map.sourceArchives.filter((r) => r.role === 'implemented_upstream').map((r) => r.alias),
  );
  const crossProject = facts.roadmap.crossProject;
  return {
    map: facts.map,
    binding: facts.binding ?? null,
    planArchives: facts.planArchives,
    adoptedDecisions: [...(facts.adoption?.decisionIds ?? [])].sort(),
    stagedDecisions: (facts.architectureStaging ?? [])
      .map((s) => ({ id: s.id, checkpoint: s.subject.sourceId, decision: s.architectureDecision }))
      .sort(byKey((s) => s.id)),
    reviewerRoles: facts.roadmap.entries
      .map((e) => ({
        entry: e.executionScope
          ? `${e.executionScope.kind}:${e.executionScope.sourceId}`
          : `${e.id}:${e.workItemId}`,
        roles: [...(e.reviewerRoles ?? [])].sort(),
      }))
      .sort(byKey((e) => e.entry)),
    target: crossProject
      ? { targetId: crossProject.targetId, selection: crossProject.selection }
      : null,
    resources: { profiles: facts.resources.profiles, locks: facts.resources.locks },
    // The commit, crate mappings and conformance identity, as runtime inputs compare them.
    upstreamPins: (facts.runtime?.pins ?? [])
      .filter((p) => upstream.has(p.alias))
      .map(({ ref: _ref, ...pin }) => ({
        ...pin,
        packages: [...pin.packages].sort(byKey((p) => p.name)),
      }))
      .sort(byKey((p) => p.alias)),
  };
}
/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every depth, keys whose value is
 * `undefined` left out as `JSON.stringify` leaves them, no whitespace. Equal values give equal
 * text whatever order their keys were built in (FMT-17).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** SHA-256 in hex: the saved-plan-v2 digests. */
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The digest a saved-plan-v2 record is bound to. */
export function planInputsDigest(inputs: PlanAcceptanceInputs): string {
  return sha256(canonicalJson(inputs));
}
/** The inputs whose canonical JSON differs, in `PLAN_ACCEPTANCE_INPUTS` order. */
export function changedInputs(
  before: PlanAcceptanceInputs,
  after: PlanAcceptanceInputs,
): PlanAcceptanceInput[] {
  return PLAN_ACCEPTANCE_INPUTS.filter(
    (key) => canonicalJson(before[key]) !== canonicalJson(after[key]),
  );
}
/** One reviewable artifact per input: its canonical JSON, indented. */
export function planInputArtifacts(inputs: PlanAcceptanceInputs) {
  return PLAN_ACCEPTANCE_INPUTS.map((name) => {
    const content = JSON.stringify(JSON.parse(canonicalJson(inputs[name])), null, 2);
    return { name, content, digest: sha256(content) };
  });
}
/** The current plan-acceptance inputs of a saved roadmap, with the setup issues. */
export function savedPlanInputs(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmap: Roadmap,
  runtime: RuntimeGeneration | undefined,
) {
  return snapshotCalculation(
    tx,
    `saved-plan-inputs:${d.id}:${roadmap.id}:${roadmap.definition.revision}:${runtime?.id ?? 'none'}`,
    () => {
      const { facts, issues } = savedPlanSnapshot(tx, d, roadmap, runtime);
      const inputs = planAcceptanceInputs(facts);
      return { inputs, inputsDigest: planInputsDigest(inputs), issues };
    },
  );
}
/**
 * The inputs a generated plan recorded, read back from its artifacts: a v2 record keeps one
 * artifact per input, a v1 record the facts they are read from. Undefined when the record or
 * an artifact cannot be read.
 */
export function recordedPlanInputs(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  s: EvidenceSubmissionHead,
): PlanAcceptanceInputs | undefined {
  const record = s.generatedPlan && tx.runtimeEvidence.submission(d.workspaceId, d.id, s.id);
  if (!record?.generatedPlan) return undefined;
  try {
    const parsed = Object.fromEntries(
      record.artifacts
        .filter((a) => a.name !== 'plan-review-guide')
        .map((a) => [a.name, JSON.parse(a.content) as unknown]),
    );
    if (record.generatedPlan.kind === 'saved-plan-v1')
      return planAcceptanceInputs(parsed as unknown as SavedPlanFacts);
    if (PLAN_ACCEPTANCE_INPUTS.some((key) => !(key in parsed))) return undefined;
    return Object.fromEntries(
      PLAN_ACCEPTANCE_INPUTS.map((key) => [key, parsed[key]]),
    ) as PlanAcceptanceInputs;
  } catch {
    return undefined;
  }
}
/** Whether a generated plan describes the roadmap's current saved setup. */
export function currentGeneratedPlan(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmap: Roadmap,
  runtime: RuntimeGeneration | undefined,
  s: EvidenceSubmissionHead,
): boolean {
  const g = s.generatedPlan;
  if (g?.roadmapId !== roadmap.id) return false;
  return g.kind === 'saved-plan-v1'
    ? g.definitionRevision === roadmap.definition.revision &&
        g.snapshotDigest === savedPlanSnapshot(tx, d, roadmap, runtime).snapshotDigest
    : g.inputsDigest === savedPlanInputs(tx, d, roadmap, runtime).inputsDigest;
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
    (g.kind !== 'saved-plan-v1' && g.kind !== 'saved-plan-v2') ||
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
  // v1 keeps its frozen rule (the whole snapshot and the same revision); v2 is bound to the
  // inputs alone (R-C6 D3).
  const issues =
    g.kind === 'saved-plan-v1'
      ? savedPlanSnapshot(tx, d, roadmap, runtime).issues
      : savedPlanInputs(tx, d, roadmap, runtime).issues;
  return [
    ...issues,
    ...(currentGeneratedPlan(tx, d, roadmap, runtime, s)
      ? []
      : ['Saved configuration changed. Generate and review new plan-acceptance evidence.']),
  ];
}
