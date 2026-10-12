import {
  type decisionPreparationGrantRequestSchema,
  type prepareRoadmapDecisionSchema,
  type RequestInput,
  roadmapViewSchema,
} from '@craftingtable/contracts';
import { request } from '../../lib/api-client.js';
import { roadmapAddress } from '../../lib/roadmap-api.js';

/**
 * The preparation kind's commands (R-A6): an agent-prepared brief for one decision
 * (PrepareDecisionBrief) and the roadmap's standing preparation grant (StandingPreparation).
 * Private to this kind: only modules in its directory may import it (R-A6; the operator kept the
 * boundary structural in R-H5's review, 2026-10-11).
 */
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});

/** `decisions/preparation/PrepareDecisionBrief`: an agent-prepared brief for one decision. */
export const prepareDecision = (
  workspaceId: string,
  roadmapId: string,
  input: RequestInput<typeof prepareRoadmapDecisionSchema>,
  csrfToken: string,
) =>
  request(
    `${roadmapAddress(workspaceId, roadmapId)}/prepare-decision`,
    roadmapViewSchema,
    mutation(csrfToken, input),
  );

/** `decisions/preparation/PrepareDecisionBrief#StandingPreparation`: the standing grant. */
export const saveDecisionPreparationGrant = (
  workspaceId: string,
  roadmapId: string,
  input: RequestInput<typeof decisionPreparationGrantRequestSchema>,
  csrfToken: string,
) =>
  request(
    `${roadmapAddress(workspaceId, roadmapId)}/decision-preparation-grant`,
    roadmapViewSchema,
    mutation(csrfToken, input),
  );
