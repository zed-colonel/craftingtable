import {
  type controlWorkCycleRequestSchema,
  type RequestInput,
  type StartInvestigationRequest,
  workCycleResponseSchema,
} from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';

/**
 * The cycle kind's commands (R-A6): the cycle control (CycleDecisions) and a question stop's
 * investigation (CycleInvestigation, R-C16). Private to this kind: only modules in its directory
 * may import it (R-A6; the operator kept the boundary structural in R-H5's review, 2026-10-11).
 */
const encode = encodeURIComponent;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
/** A cycle's address; each command spells its own route after it, so the route reads whole. */
const cycleUrl = (cycle: WorkCycle) =>
  `/api/workspaces/${encode(cycle.workspaceId)}/cycles/${encode(cycle.id)}`;

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
