import { randomUUID } from 'node:crypto';
import {
  asAuditEventId,
  asEventId,
  type ConcurrencyDefinition,
  type EvidenceDecision,
  type EvidenceSubmission,
  type EvidenceSubmissionHead,
  mapCapabilities,
  PLAN_ACCEPTANCE_INPUT_LABELS,
  PLAN_ACCEPTANCE_INPUTS,
  type PlanAcceptanceInput,
  type Roadmap,
  type RuntimeGeneration,
  submissionHead,
  type UserId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import {
  changedInputs,
  planCheckpoint,
  planInputArtifacts,
  recordedPlanInputs,
  savedPlanInputs,
  sha256,
} from './plan-acceptance-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import {
  acceptedEvidence,
  activeRuntime,
  prerequisiteIssues,
  submissionIssues,
  subjectRequirements,
} from './runtime-evidence-policy.js';

/**
 * The plan acceptance the operator last recorded for the roadmap: its newest accepted generated
 * plan, or, when that was carried forward, the operator's own review the carry chain starts
 * from (R-C6). A package generated for review names every input changed since then.
 */
export function lastPlanReview(
  tx: StorageRepositories,
  d: ConcurrencyDefinition,
  roadmapId: string,
):
  | { readonly submission: EvidenceSubmissionHead; readonly decision: EvidenceDecision }
  | undefined {
  const decisions = tx.runtimeEvidence.decisions(d.workspaceId);
  const accepted = new Map(
    decisions.filter((a) => a.outcome === 'accepted').map((a) => [a.submissionId, a]),
  );
  const byId = new Map(decisions.map((a) => [a.id, a]));
  const submissions = tx.runtimeEvidence.submissions(d.workspaceId, d.id);
  const newest = submissions.find(
    (s) => s.generatedPlan?.roadmapId === roadmapId && accepted.has(s.id),
  );
  let decision = newest && accepted.get(newest.id);
  const seen = new Set<string>();
  while (decision?.carriedFrom && !seen.has(decision.id)) {
    seen.add(decision.id);
    decision = byId.get(decision.carriedFrom);
  }
  const submission = decision && submissions.find((s) => s.id === decision.submissionId);
  return decision && submission ? { submission, decision } : undefined;
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
  const changed = options.changed.map((key) => PLAN_ACCEPTANCE_INPUT_LABELS[key]).join(', ');
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
      { name: 'plan-review-guide', content, digest: sha256(content) },
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
/** Inputs whose change means a new import, amendment or binding: the operator reviews those. */
const NEVER_CARRIED: ReadonlySet<PlanAcceptanceInput> = new Set(['map', 'binding', 'planArchives']);
/** The generated plan currently accepted for the map's plan checkpoint, if any. */
function acceptedGeneratedPlan(tx: StorageRepositories, ws: WorkspaceId, definitionId: string) {
  const d = tx.imports.definition(ws, definitionId);
  const checkpoint = d && planCheckpoint(d);
  const binding = tx.imports.bindings(ws, definitionId)[0];
  if (!checkpoint || !binding) return undefined;
  const accepted = acceptedEvidence(tx, ws, definitionId, binding.revision, {
    kind: 'checkpoint',
    sourceId: checkpoint,
  });
  return accepted?.generatedPlan ? accepted : undefined;
}
/**
 * Runs an operator command's `change` and carries the plan acceptance it re-opens (R-C6 D2,
 * ADR-050 as amended). The commands that change plan-acceptance inputs (a roadmap save, a
 * dependency refresh, approving decision clauses, an adoption) call it inside their own
 * transaction. When the roadmap's generated plan was accepted before `change` and is not after,
 * and only inputs other than the map, binding and plan archives changed, the re-generated
 * saved-plan-v2 is accepted as the command's operator, `carriedFrom` the prior decision,
 * audited as `evidence.decided` with the changed inputs. It opens no inbox item, since the
 * checkpoint never stops being accepted.
 *
 * Nothing else carries: the first acceptance for a map and binding stays the operator's (a
 * new definition or binding has no prior acceptance here), an acceptance that had already
 * lapsed before the command stays lapsed, and a context without an authenticated session (a
 * scheduler pass) never accepts.
 */
export function carryPlanAcceptance<T>(
  tx: StorageRepositories,
  context: AuthContext,
  scope: {
    readonly workspaceId: WorkspaceId;
    readonly definitionId: string;
    /** The operator command, as the package and the audit name it. */
    readonly command: string;
    readonly at: string;
  },
  change: () => T,
): T {
  const ws = scope.workspaceId;
  // Each side reads through its own snapshot, so the saved plan is collected once per side.
  const prior = context.session
    ? acceptedGeneratedPlan(mapReadSnapshot(tx), ws, scope.definitionId)
    : undefined;
  const result = change();
  if (!prior?.generatedPlan) return result;
  const read = mapReadSnapshot(tx);
  if (acceptedGeneratedPlan(read, ws, scope.definitionId)) return result;
  const d = read.imports.definition(ws, scope.definitionId);
  const binding = read.imports.bindings(ws, scope.definitionId)[0];
  const roadmap = read.roadmaps.find(ws, prior.generatedPlan.roadmapId);
  const runtime = binding && activeRuntime(read, ws, scope.definitionId, binding.revision);
  if (
    !d ||
    !roadmap ||
    !runtime ||
    !mapCapabilities(d.source).planAcceptance ||
    binding.revision !== prior.bindingRevision
  )
    return result;
  const current = savedPlanInputs(read, d, roadmap, runtime);
  const before = recordedPlanInputs(read, d, prior);
  if (!before) return result;
  const changed = changedInputs(before, current.inputs);
  if (changed.some((key) => NEVER_CARRIED.has(key))) return result;
  const priorDecision = read.runtimeEvidence
    .decisions(ws)
    .find((a) => a.submissionId === prior.id && a.outcome === 'accepted');
  if (!priorDecision) return result;
  const submission = generatedPlanSubmission(read, d, roadmap, runtime, {
    at: scope.at,
    userId: context.user.id,
    prior: priorDecision,
    changed,
    carriedBy: scope.command,
  });
  const head = submissionHead(submission);
  // Its validation includes the saved setup's issues (a stopped roadmap, a pending amendment,
  // a binding or runtime out of step), so it is the one check the package must pass.
  if (
    !withinArtifactLimits(submission) ||
    submissionIssues(read, d, runtime, head).length ||
    prerequisiteIssues(read, d, binding.revision, head.subject).length
  )
    return result;
  const labels =
    changed.map((key) => PLAN_ACCEPTANCE_INPUT_LABELS[key]).join(', ') ||
    'no plan-acceptance input';
  tx.runtimeEvidence.addSubmission(submission);
  tx.runtimeEvidence.addDecision({
    id: randomUUID(),
    workspaceId: ws,
    submissionId: submission.id,
    outcome: 'accepted',
    rationale: `Carried by your ${scope.command} from the plan acceptance of ${priorDecision.decidedAt}. Changed: ${labels}.`,
    decidedAt: scope.at,
    decidedByUserId: context.user.id,
    carriedFrom: priorDecision.id,
  });
  tx.audit.append({
    id: asAuditEventId(randomUUID()),
    workspaceId: ws,
    occurredAt: scope.at,
    actorKind: 'user',
    actorUserId: context.user.id,
    sessionId: context.session.id,
    action: 'evidence.decided',
    targetType: 'concurrency-definition',
    targetId: d.id,
    outcome: 'succeeded',
    metadata: {
      submissionId: submission.id,
      roadmapId: roadmap.id,
      carriedFrom: priorDecision.id,
      priorSubmissionId: prior.id,
      changedInputs: changed,
      command: scope.command,
    },
  });
  tx.workspaceEvents.appendEvent({
    id: asEventId(randomUUID()),
    workspaceId: ws,
    occurredAt: scope.at,
    actorUserId: context.user.id,
    kind: 'runtime-evidence-changed',
    payload: {
      definitionId: d.id,
      message: `${submission.subject.sourceId} acceptance carried by your ${scope.command}. Changed: ${labels}.`,
    },
  });
  return result;
}
/**
 * For an acceptance carried forward (R-C6 D2): when the operator last reviewed the plan, and
 * every input the carried packages changed since, in input order. Undefined for an acceptance
 * the operator recorded, or a chain that does not reach one.
 */
export function carriedAcceptance(
  decisions: readonly EvidenceDecision[],
  submissions: readonly EvidenceSubmissionHead[],
  submissionId: string,
): { readonly reviewedAt: string; readonly changedInputs: PlanAcceptanceInput[] } | undefined {
  const byId = new Map(decisions.map((a) => [a.id, a]));
  const heads = new Map(submissions.map((s) => [s.id, s]));
  let decision = decisions.find((a) => a.submissionId === submissionId);
  if (!decision?.carriedFrom) return undefined;
  const changed = new Set<PlanAcceptanceInput>();
  const seen = new Set<string>();
  while (decision?.carriedFrom && !seen.has(decision.id)) {
    seen.add(decision.id);
    const plan = heads.get(decision.submissionId)?.generatedPlan;
    if (plan?.kind === 'saved-plan-v2') for (const key of plan.changedInputs) changed.add(key);
    decision = byId.get(decision.carriedFrom);
  }
  return decision && !decision.carriedFrom && decision.outcome === 'accepted'
    ? {
        reviewedAt: decision.decidedAt,
        changedInputs: PLAN_ACCEPTANCE_INPUTS.filter((key) => changed.has(key)),
      }
    : undefined;
}
