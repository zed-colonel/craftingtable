import {
  type IntegrationResolutionRequest,
  type PrepareBaselineRequest,
  type RecoverDesignRequest,
  type RequestInput,
  type ScopeRepairRequest,
  type StartInvestigationRequest,
  type StartWorkCycleRequest,
  baselineEvidenceSchema,
  baselinePreviewSchema,
  type controlWorkCycleRequestSchema,
  designRecoveryPreviewSchema,
  scopeRepairPreviewSchema,
  workCycleResponseSchema,
  workCyclesResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { request } from './api-client.js';

const encode = encodeURIComponent;
/** A cycle's address; each command spells its own route after it, so the route reads whole. */
const cycleUrl = (cycle: WorkCycle) =>
  `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}`;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
/**
 * Without a work item: the cycles that have not ended, without design-recovery
 * detail (attention strip, rail count, run page). With one: that item's full
 * cycles, history included (work-item page).
 */
export function loadWorkCycles(workspaceId: WorkspaceId, workItemId?: WorkItemId) {
  const query = workItemId === undefined ? '' : `?workItemId=${encode(workItemId)}`;
  return request(`/api/workspaces/${encode(workspaceId)}/cycles${query}`, workCyclesResponseSchema);
}
export function startWorkCycle(
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  input: StartWorkCycleRequest,
  csrfToken: string,
) {
  return request(
    `/api/workspaces/${encode(workspaceId)}/work-items/${encode(workItemId)}/cycles`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}

export function loadBaselineEvidence(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/baseline-evidence`, baselineEvidenceSchema);
}

// Decision commands on a cycle, one owner each (R-A6); the boundary test checks it.

/**
 * `decisions/cycle/CycleDecisions`: continuing a stopped cycle, the manual pause, resume and stop,
 * and a service retry.
 */
export function controlCycle(
  cycle: WorkCycle,
  body: RequestInput<typeof controlWorkCycleRequestSchema>,
  csrfToken: string,
) {
  return request(`${cycleUrl(cycle)}/control`, workCycleResponseSchema, mutation(csrfToken, body));
}

/** `decisions/integration/IntegrationConflict`: the decision on an integration conflict. */
export function resolveIntegration(
  cycle: WorkCycle,
  input: Omit<IntegrationResolutionRequest, 'expectedVersion'>,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/integration-resolution`,
    workCycleResponseSchema,
    mutation(csrfToken, { ...input, expectedVersion: cycle.version }),
  );
}

/**
 * `decisions/design/DesignQuestions`: continue, clarify or restart a stopped design step, and the
 * preview it decides on.
 */
export function previewDesignRecovery(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/design-recovery`, designRecoveryPreviewSchema);
}
export function recoverDesign(cycle: WorkCycle, input: RecoverDesignRequest, csrfToken: string) {
  return request(
    `${cycleUrl(cycle)}/design-recovery`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}
/**
 * `decisions/design/BaselinePreparation`: the historical baseline a design step's evidence is
 * read against, and its preview.
 */
export function previewBaseline(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/baseline-preparation`, baselinePreviewSchema);
}
export function prepareBaseline(
  cycle: WorkCycle,
  input: PrepareBaselineRequest,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/baseline-preparation`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}

/**
 * `decisions/scope-repair/ScopeRepair`: delegate a scope review's source findings to their owning
 * slice, and the preview it decides on.
 */
export function previewScopeRepair(cycle: WorkCycle) {
  return request(`${cycleUrl(cycle)}/scope-repair`, scopeRepairPreviewSchema);
}
export function delegateScopeRepair(
  cycle: WorkCycle,
  input: ScopeRepairRequest,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/scope-repair`,
    workCycleResponseSchema,
    mutation(csrfToken, input),
  );
}

/**
 * `decisions/cycle/CycleInvestigation`, a question stop's investigation (R-C16): start a
 * read-only investigation of the stop's questions, end it, and acknowledge that the worktree
 * changed while it ran.
 */
export function startInvestigation(
  cycle: WorkCycle,
  input: Omit<StartInvestigationRequest, 'expectedVersion'>,
  csrfToken: string,
) {
  return request(
    `${cycleUrl(cycle)}/investigation`,
    workCycleResponseSchema,
    mutation(csrfToken, { action: 'start', expectedVersion: cycle.version, ...input }),
  );
}
export function endInvestigation(cycle: WorkCycle, csrfToken: string) {
  return request(
    `${cycleUrl(cycle)}/investigation`,
    workCycleResponseSchema,
    mutation(csrfToken, { action: 'end', expectedVersion: cycle.version }),
  );
}
export function acknowledgeWorktreeChange(cycle: WorkCycle, csrfToken: string) {
  return request(
    `${cycleUrl(cycle)}/investigation`,
    workCycleResponseSchema,
    mutation(csrfToken, { action: 'acknowledge-change', expectedVersion: cycle.version }),
  );
}
