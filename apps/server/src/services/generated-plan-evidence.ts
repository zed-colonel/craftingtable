import { createHash, randomUUID } from 'node:crypto';
import {
  type ConcurrencyDefinition,
  type EvidenceDecision,
  type EvidenceSubmission,
  type EvidenceSubmissionHead,
  mapCapabilities,
  PLAN_ACCEPTANCE_INPUTS,
  type PlanAcceptanceInput,
  type Roadmap,
  type RuntimeGeneration,
  type UserId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import {
  changedInputs,
  planInputArtifacts,
  recordedPlanInputs,
  savedPlanInputs,
} from './plan-acceptance-policy.js';
import { subjectRequirements } from './runtime-evidence-policy.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** The roadmap's newest generated plan the operator accepted, current or not, with its decision. */
export function newestAcceptedPlan(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmapId: string,
):
  | { readonly submission: EvidenceSubmissionHead; readonly decision: EvidenceDecision }
  | undefined {
  const accepted = new Map(
    tx.runtimeEvidence
      .decisions(d.workspaceId)
      .filter((a) => a.outcome === 'accepted')
      .map((a) => [a.submissionId, a]),
  );
  const submission = tx.runtimeEvidence
    .submissions(d.workspaceId, d.id)
    .find((s) => s.generatedPlan?.roadmapId === roadmapId && accepted.has(s.id));
  return submission && { submission, decision: accepted.get(submission.id)! };
}
/**
 * The inputs that changed since `prior` was accepted: every input when its record cannot be
 * read back, none when there is no prior.
 */
export function changesSince(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  prior: EvidenceSubmissionHead | undefined,
  roadmap: Roadmap,
  runtime: RuntimeGeneration,
): PlanAcceptanceInput[] {
  if (!prior) return [];
  const before = recordedPlanInputs(tx, d, prior);
  return before
    ? changedInputs(before, savedPlanInputs(tx, d, roadmap, runtime).inputs)
    : [...PLAN_ACCEPTANCE_INPUTS];
}
const LABELS: Readonly<Record<PlanAcceptanceInput, string>> = {
  map: 'map',
  binding: 'binding',
  planArchives: 'plan archives',
  adoptedDecisions: 'adopted scheduling decisions',
  stagedDecisions: 'staged decision clauses',
  reviewerRoles: 'reviewer roles',
  target: 'target and selection',
  resources: 'resource profiles and locks',
  upstreamPins: 'implemented-upstream pins',
};
/**
 * A saved-plan-v2 package for the roadmap's current inputs (ADR-050 as amended by R-C6): a
 * review guide and one artifact per input. The caller has checked the saved setup has no
 * issues and the generator supports the plan checkpoint. `carried` names the operator command
 * that carries an acceptance forward; the package then says so instead of asking for review.
 */
export function generatedPlanSubmission(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmap: Roadmap,
  runtime: RuntimeGeneration,
  options: {
    readonly at: string;
    readonly userId: UserId;
    readonly prior?: { readonly decidedAt: string };
    readonly changed: readonly PlanAcceptanceInput[];
    readonly carriedBy?: string;
  },
): EvidenceSubmission {
  const plan = mapCapabilities(d.source).planAcceptance!;
  const current = savedPlanInputs(tx, d, roadmap, runtime);
  const subject = { kind: 'checkpoint' as const, sourceId: plan.checkpointId };
  const spec = subjectRequirements(d, subject);
  const crossProject = roadmap.definition.crossProject!;
  const binding = tx.imports.bindings(d.workspaceId, d.id)[0]!;
  const upstream = new Set(
    d.source.repositories.filter((r) => r.role === 'implemented_upstream').map((r) => r.id),
  );
  const changed = options.changed.map((key) => LABELS[key]).join(', ');
  const content = [
    `Saved roadmap: ${roadmap.definition.name} (revision ${roadmap.definition.revision})`,
    `Map: ${d.mapId} ${d.revision}; binding ${runtime.bindingRevision}; environment generation ${runtime.generation}`,
    `Target: ${crossProject.targetId}; selection: ${crossProject.selection}`,
    `Import validation: structure, source snapshots and graph acyclicity checked (${d.graphNodeCount} milestones, ${d.graphEdgeCount} edges).`,
    `Scheduling proposals: ${d.source.decisions.length} adopted for the exact binding.`,
    ...binding.bindings.map(
      (b) =>
        `Binding ${b.alias}: plan ${b.planVersionId ?? 'implemented upstream'}; repository ${b.repositoryId}; integration ${b.integrationBranch ?? 'upstream ref below'}`,
    ),
    ...runtime.pins.map(
      (p) =>
        `Pin ${p.alias}: ${p.ref} at ${p.commitSha}; conformance ${p.conformanceRevision}${
          upstream.has(p.alias) ? '' : ' (a consumer integration pin: not a plan-acceptance input)'
        }`,
    ),
    `Saved activities: ${roadmap.definition.entries.length}. Review their reviewer responsibilities in the reviewerRoles artifact.`,
    !options.prior
      ? 'No plan has been accepted for this roadmap yet.'
      : changed
        ? `Changed since the plan accepted at ${options.prior.decidedAt}: ${changed}.`
        : `No plan-acceptance input changed since the plan accepted at ${options.prior.decidedAt}.`,
    '',
    `The daemon collected these plan-acceptance inputs. This package does not claim a human review, test execution, AQ qualification or release approval. ${
      options.carriedBy
        ? `Your ${options.carriedBy} changed only the inputs named above, so it carried your acceptance forward as ${plan.reviewerRole}.`
        : `Review the artifacts and record your decision as ${plan.reviewerRole}. The authenticated acceptance decision and rationale are the independent plan review.`
    }`,
  ].join('\n');
  return {
    id: randomUUID(),
    workspaceId: d.workspaceId,
    definitionId: d.id,
    bindingRevision: runtime.bindingRevision,
    runtimeId: runtime.id,
    subject,
    environmentId: runtime.environments[0]!.id,
    executedBy: 'CraftingTable setup collector',
    executedAt: options.at,
    reviewers: [],
    requirements: spec.requirements.map((requirement) => ({
      requirement,
      artifact: 'plan-review-guide',
    })),
    cases: [],
    artifacts: [
      { name: 'plan-review-guide', content, digest: hash(content) },
      ...planInputArtifacts(current.inputs),
    ],
    createdAt: options.at,
    createdByUserId: options.userId,
    generatedPlan: {
      kind: 'saved-plan-v2',
      roadmapId: roadmap.id,
      definitionRevision: roadmap.definition.revision,
      inputsDigest: current.inputsDigest,
      changedInputs: [...options.changed],
    },
  };
}
/** Whether a package stays inside the evidence artifact limits. */
export function withinArtifactLimits(s: EvidenceSubmission): boolean {
  return (
    s.artifacts.every((a) => Buffer.byteLength(a.content) <= 512 * 1024) &&
    s.artifacts.reduce((n, a) => n + Buffer.byteLength(a.content), 0) <= 4 * 1024 * 1024
  );
}
