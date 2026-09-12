import {
  ownsIntegrationResolution,
  type Finalization,
  type WorkCycle,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { ExecutionRequestError } from './errors.js';

export function finalizationForCycle(
  storage: CraftingTableStorage,
  cycle: WorkCycle,
): Finalization | undefined {
  if (!cycle.finalizationId) return;
  const value = storage.execution.finalizations.find(cycle.workspaceId, cycle.finalizationId);
  if (
    value?.status !== 'active' ||
    value.cycleId !== cycle.id ||
    value.worktreeId !== cycle.worktreeId
  )
    throw new ExecutionRequestError('conflict', 'Finalization delegation is no longer active');
  return value;
}

/** One explicit questions section, bounded by the next heading (review reports follow it). */
export function finalizationHasNoQuestions(text: string): boolean {
  let fenced = false;
  let collecting = false;
  let count = 0;
  const body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (collecting) body.push(line);
      continue;
    }
    if (!fenced && /^## /u.test(line)) {
      collecting = /^## Open questions\s*$/u.test(line);
      if (collecting) count++;
    } else if (collecting) body.push(line);
  }
  return count === 1 && body.join('\n').trim().toLowerCase() === 'none';
}
export function finalizationInstructions(value: Finalization, cycle: WorkCycle): string {
  return [
    `This is a plan-wide finalization of plan version ${value.planVersionId}, not a single work item. Read ALL supplied plan documents and the complete work-item inventory.`,
    `Integration snapshot: ${value.integrationBranch} at ${value.integrationSha}. Final destination: ${value.targetBranch}. Evaluate the COMPLETE candidate diff against the current destination, including changes already integrated before this finalization.`,
    `Phase: ${cycle.polishPhase ?? 'assess'}; improvement round ${(cycle.polishRound ?? 0) + 1} of ${value.rounds.length}.`,
    'Conformance: explicitly assess every in-scope plan obligation and exit gate, interactions between items, regressions, and missing implementation or tests. Recorded work-item completion is not proof of conformance. Include a conformance assessment and check commands/results in your final outcome and review evidence.',
    'Simplification and polish: improve clarity, duplication, maintainability and user experience within the adopted plan. Avoid gratuitous changes; if no justified improvement remains, explain that. Do not change intended behavior, scope or acceptance criteria without asking the operator.',
    'Questions are never delegated decisions. Every final message must contain exactly one section headed ## Open questions with only none when no operator input is required; otherwise list the questions. For a review, put the questions section BEFORE another heading containing the structured review report and final VERDICT line.',
    ownsIntegrationResolution(cycle)
      ? 'For this reserved conflict resolution, stage and verify intended changes without committing. Follow the pinned merge instructions. Never push or advance the final destination.'
      : 'Implementation/polish runs must commit intended changes and verify them. Review runs remain independent and read-only. Never merge into the integration branch or final destination, and never push. The operator alone approves the final promotion.',
    value.instructions,
    cycle.polishPhase === 'final-review'
      ? 'Perform the final independent conformance and regression review. Prior passes are claims to verify. Do not approve merely because the round budget is exhausted.'
      : (value.rounds[cycle.polishRound ?? 0]?.instructions ?? ''),
  ]
    .filter(Boolean)
    .join('\n\n');
}
