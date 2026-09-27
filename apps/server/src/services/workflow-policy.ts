import { supportsTechnicalCheckpoint } from './technical-checkpoint-policy.js';
import { attemptDefinition, effectiveDelegation } from './roadmap-delegation-policy.js';
import { stagedDecision, supportsArchitectureDecision } from './architecture-decision-policy.js';
import { mapReadSnapshot } from './map-read-snapshot.js';
import { createHash } from 'node:crypto';
import { parseWorkflowReport } from '@craftingtable/contracts';
import {
  asAgentRunId,
  type AgentRun,
  type WorkCycle,
  type WorkflowQuestion,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { resolveScope } from './execution-scope.js';
import {
  acceptedEvidence,
  scopeRuntimeChanges,
  prerequisiteIssues,
  subjectRequirements,
} from './runtime-evidence-policy.js';
import { cycleOwnership } from './cycle-ownership.js';

export function workflowDelegation(tx: StorageRepositories, cycle: WorkCycle) {
  const owner = cycleOwnership(tx, cycle);
  if (!owner?.roadmap.definition.crossProject) return undefined;
  const { roadmap, attempt } = owner;
  const saved = attemptDefinition(tx, roadmap, attempt);
  const entry = saved?.entries.find((e) => e.id === attempt.entryId);
  return entry
    ? {
        roadmap,
        attempt,
        entry,
        roles: effectiveDelegation(roadmap, entry, saved!).reviewerRoles,
        runnable: roadmap.status === 'running' && !roadmap.entryHolds?.[entry.id],
      }
    : undefined;
}
/**
 * Whether a controller review may start or launch for this cycle now. A cross-project roadmap
 * delegates its reviews and holds them while paused. A slice cycle no such roadmap delegates
 * still owes its source-required security review: the operator who started the cycle
 * authorizes it, and an owning roadmap that is paused or holds the entry holds it.
 */
export function controllerReviewRunnable(tx: StorageRepositories, cycle: WorkCycle): boolean {
  const delegation = workflowDelegation(tx, cycle);
  if (delegation) return delegation.runnable;
  const owner = cycleOwnership(tx, cycle);
  return (
    !owner ||
    (owner.roadmap.status === 'running' && !owner.roadmap.entryHolds?.[owner.attempt.entryId])
  );
}
export function workflowContext(tx: StorageRepositories, cycle: WorkCycle) {
  tx = mapReadSnapshot(tx);
  if (!cycle.workItemId || cycle.executionScope?.kind !== 'slice') return undefined;
  const scope = resolveScope(tx, cycle.workspaceId, cycle.workItemId, cycle.executionScope);
  const delegation = workflowDelegation(tx, cycle);
  const ids = new Set(
    scope.slice?.merge_requires.filter((r) => r.kind === 'checkpoint').map((r) => r.id),
  );
  const checkpoints = scope.definition.source.checkpoints
    .filter((c) => ids.has(c.id))
    .map((checkpoint) => {
      const subject = { kind: 'checkpoint' as const, sourceId: checkpoint.id };
      const spec = subjectRequirements(scope.definition, subject, cycle.executionScope!.sourceId);
      const alias = tx.imports
        .bindings(cycle.workspaceId, scope.definition.id)
        .find((b) => b.revision === cycle.executionScope!.bindingRevision)
        ?.bindings.find((b) => b.workItems.some((w) => w.workItemId === cycle.workItemId))?.alias;
      const supported = supportsTechnicalCheckpoint(scope.definition, checkpoint.id, alias);
      return {
        id: checkpoint.id,
        title: checkpoint.title,
        kind: checkpoint.kind,
        sharedDecision: supportsArchitectureDecision(scope.definition, checkpoint.id),
        supported,
        // The merge gate lets an approved clause-level decision stand in for the full checkpoint
        // for its named slice (execution-scope.ts); the workflow must agree, or it stops a
        // mergeable review for an approval that already exists.
        accepted:
          !!acceptedEvidence(
            tx,
            cycle.workspaceId,
            scope.definition.id,
            cycle.executionScope!.bindingRevision,
            subject,
            new Set(),
            cycle.executionScope,
          ) || !!stagedDecision(tx, cycle.workspaceId, cycle.executionScope!, checkpoint.id),
        requirements: spec.requirements,
        caseIds: spec.cases.map((c) => c.id),
        roles: spec.reviewerRoles,
        pending: prerequisiteIssues(
          tx,
          scope.definition,
          cycle.executionScope!.bindingRevision,
          subject,
        ),
        assigned: spec.reviewerRoles.every((r) => delegation?.roles.includes(r)),
        sources: checkpoint.source_refs,
      };
    });
  const value = {
    definitionId: scope.definition.id,
    digest: scope.definition.digest,
    bindingRevision: cycle.executionScope.bindingRevision,
    checkpoints,
    roles: delegation?.roles ?? [],
  };
  return {
    ...value,
    contextDigest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
}
/** A specialist receipt follows the candidate, policy and consumed dependency inputs. */
export function securityReviewCurrent(tx: StorageRepositories, cycle: WorkCycle, review: AgentRun) {
  const receipt = cycle.workflow?.securityReceipt;
  const security =
    receipt && tx.execution.runs.find(cycle.workspaceId, asAgentRunId(receipt.runId));
  const old = security?.reviewBranchContext;
  const current = review.reviewBranchContext;
  if (
    !receipt ||
    !security ||
    !old ||
    !current ||
    security.status !== 'finished' ||
    security.role !== 'review' ||
    security.verdict !== 'mergeable' ||
    security.worktreeId !== cycle.worktreeId ||
    receipt.headSha !== current.headSha ||
    receipt.targetSha !== current.targetSha ||
    old.headSha !== current.headSha ||
    old.targetSha !== current.targetSha ||
    old.targetBranch !== current.targetBranch ||
    old.worktreeVersion !== current.worktreeVersion ||
    old.repositoryPolicyVersion !== current.repositoryPolicyVersion
  )
    return false;
  return (
    !cycle.executionScope ||
    scopeRuntimeChanges(
      tx,
      cycle.workspaceId,
      cycle.executionScope,
      tx.runtimeEvidence.run(cycle.workspaceId, security.id)?.runtimeId,
    ).length === 0
  );
}

export function workflowQuestions(
  tx: StorageRepositories,
  cycle: WorkCycle,
  text: string,
): readonly WorkflowQuestion[] {
  const parsed = parseWorkflowReport(text);
  const context = workflowContext(tx, cycle);
  const questions = parsed.status === 'complete' ? parsed.report.questions : [];
  return questions.map((q) => {
    if (q.destination !== 'shared-decision') return q;
    const definition = context && tx.imports.definition(cycle.workspaceId, context.definitionId);
    const checkpoint = definition?.source.checkpoints.find(
      (c) => c.id === q.checkpointId && c.kind === 'architecture_decision',
    );
    return checkpoint && definition && supportsArchitectureDecision(definition, checkpoint.id)
      ? q
      : { question: q.question, destination: 'work-item' as const };
  });
}
export function workflowPrompt(tx: StorageRepositories, cycle: WorkCycle): string {
  const context = workflowContext(tx, cycle);
  if (!context) return '';
  const active = cycle.workflow?.activeReview;
  return `Controller workflow contract: technical candidate review and permission to merge are separate. Assess source defects and required tests now. Pending merge checkpoints, predecessor work and a separate scheduled review are controller obligations, not code defects or unanswered operator questions. Do not claim they passed; record their pending state in prose. The controller still enforces every transition gate. Withdraw obsolete administrative findings with their stable IDs and an explanation, without hiding actual source defects. Never waive architectural approvals, safety requirements, unproven tests or exceptions.
Resolve questions already answered by the exact approved plan, recorded decisions or supplied evidence; cite the answer. Genuine new architectural decisions require the operator. Direct mapped ADR questions to shared-decision with the exact checkpointId; local implementation choices, contradictions and unsupported controller actions go to work-item.
For security-sensitive changes, declare the source requirement for a second security review below, with citations. The controller schedules a DISTINCT read-only security review after technical remediation, if the saved roadmap assigns independent-security-reviewer-if-required-by-source, or on the operator's authority when no roadmap delegates this cycle. The ordinary reviewer does not claim two reviews. Security requirements remain until a separate successful review of the same candidate and integration target is recorded.
Before ## Open questions, include exactly one fenced craftingtable-workflow JSON block:
${JSON.stringify({ version: 1, questions: [], resolved: [], securityReview: { required: false, sources: [] } })}
questions entries: {question, destination:"shared-decision"|"work-item", checkpointId?:"exact ADR ID"}. resolved entries: {question, answer, sources:["exact plan section or accepted evidence ID"]}. If a security review is required, set required:true and cite the source policy. Open questions contains only none when questions is empty; otherwise repeat every genuine operator question. Never put controller-managed pending obligations there. Return your normal complete review report and final verdict when reviewing; that verdict assesses technical candidate correctness, while the daemon separately enforces permission to merge.
Current controller obligations (required states are not successful evidence): ${JSON.stringify(context)}
${active ? `This is a separate ${active.kind} review. Source run: ${active.sourceRunId}. Responsibilities: ${active.roles.join(', ')}. Read the full lineage and verify the exact candidate without source edits. ${active.kind === 'reassessment' ? 'Classify the prior questions against current plan/evidence and independently assess the technical candidate. Do not resolve genuine operator decisions yourself.' : active.kind === 'security' ? 'Independently examine identity, authorization, disclosure, cross-principal isolation, lifecycle recovery and root-key boundaries. Exercise negative and recovery paths. Include every actual code defect in the normal findings report.' : `Independently assess checkpoint ${active.checkpointId}. Add checkpoint:{id:${JSON.stringify(active.checkpointId)},passed:boolean,requirements:[{requirement:"exact required text",evidence:"observations and immutable references"}],caseIds:["actually verified case IDs"]} to the workflow report. Required claims: ${JSON.stringify(active.requirements)}. Required cases: ${JSON.stringify(active.caseIds)}. Never infer a passing case from eligibility or a plan hash. If prerequisites or proof cannot be established, report passed:false and explain the missing evidence; operator choices belong in questions. This checkpoint review is an agent attestation under the saved responsibilities, never a claim that a human reviewed it.`}` : ''}`;
}

/** Presentation only: recognizing an ADR reference never approves it. */
export function operatorQuestionRoutes(
  tx: StorageRepositories,
  cycle: WorkCycle,
  text: string,
): readonly WorkflowQuestion[] {
  const parsed = parseWorkflowReport(text);
  if (parsed.status === 'complete') return workflowQuestions(tx, cycle, text);
  const section = text
    .match(/^## Open questions[ \t]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
    ?.trim();
  if (!section || /^none[.!]?$/i.test(section)) return [];
  const definition =
    cycle.executionScope &&
    tx.imports.definition(cycle.workspaceId, cycle.executionScope.definitionId);
  const ids =
    definition?.source.checkpoints
      .filter((c) => supportsArchitectureDecision(definition!, c.id) && section.includes(c.id))
      .map((c) => c.id) ?? [];
  return ids.length
    ? ids.map((checkpointId) => ({
        question: section.slice(0, 4000),
        destination: 'shared-decision' as const,
        checkpointId,
      }))
    : [{ question: section.slice(0, 4000), destination: 'work-item' }];
}
