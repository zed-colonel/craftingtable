import { assertFinalizationMap } from './map-finalization-policy.js';
import {
  type Finalization,
  ownsIntegrationResolution,
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
  assertFinalizationMap(storage, value);
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
/** The finalization part of a run's instructions. Only staged finalizations run (R-B10). */
export function finalizationInstructions(value: Finalization, cycle: WorkCycle): string {
  const stage = value.stages?.[cycle.finalizationProgress?.stageIndex ?? 0];
  if (!stage) return '';
  const state = cycle.finalizationProgress?.stages[cycle.finalizationProgress.stageIndex];
  const optional = stage.kind === 'simplification' || stage.kind === 'polish';
  const discovery = optional && state?.status !== 'verifying';
  return [
    `Staged finalization: ${stage.name} (${stage.kind}), ${discovery ? 'DISCOVERY' : optional ? 'SELECTED-BATCH VERIFICATION' : 'REQUIRED REVIEW'}. Read craftingtable-finalization-state.json for the authoritative stage configuration, selected IDs, adopted obligations, prior evidence and retained follow-ups. Read the supplied plan documents and inventory for context.`,
    `Integration snapshot: ${value.integrationBranch} at ${value.integrationSha}; destination ${value.targetBranch}. Scope: ${stage.workItemSourceIds.length ? `work items ${stage.workItemSourceIds.join(', ')} and their contract interactions` : 'whole candidate, including cross-subsystem interactions'}.`,
    stage.kind === 'correctness'
      ? 'Focus on invariants, failure paths, regressions, tests and interactions. Do not perform an unrestricted simplification or cosmetic review.'
      : stage.kind === 'conformance'
        ? 'Map every adopted obligation in this scope to implementation and verification. Include obligations found in plan prose as well as imported work-item exit gates. Add individually actionable obligations with stable IDs, source citations and exact requirement text. Preserve previously adopted IDs, sources and requirements.'
        : stage.kind === 'final-review'
          ? 'Independently assess the whole final candidate for correctness, conformance and regressions. Run ALL repository-required checks, including cross-boundary checks, and report every configured requiredChecks name across ALL stages. Revalidate EVERY adopted obligation against this exact candidate; previous passes are claims, never approval. Evidence reuse is forbidden in this final review.'
          : discovery
            ? 'Discover worthwhile optional improvements only in this stage category. Report them for operator selection; do not edit code. Discovery happens once. The operator may choose none.'
            : `Implement or verify ONLY the selected batch: ${(cycle.findingFocus ?? []).join(', ') || 'none'}. Do not restart optional discovery or fix unselected suggestions. New discretionary ideas belong in follow-up findings and do not prolong this batch.`,
    'Every finding must have category correctness, conformance, simplification or polish, separate from severity. A simplification that reveals a correctness defect is a correctness finding. Split bundled concerns into separate IDs. Correctness/conformance findings, all blocking/major findings, failed checks and selected batch findings are required work. Optional minor/nit simplification and polish suggestions may remain OPEN as follow-up; never mark them resolved merely because they were not selected.',
    'Keep the normal craftingtable-review JSON report and final VERDICT line. Add a finalization object: {"stageId":"' +
      stage.id +
      '","fullChecks":' +
      (stage.kind === 'final-review' ? 'true' : 'false') +
      ',"checks":[{"name":"exact configured check name or repository check","status":"passed|failed|not-run","evidence":"concise command/result and log location"}],"obligations":[{"id":"stable obligation ID from ledger or new plan obligation","source":"exact adopted source citation","requirement":"exact adopted requirement","workItemSourceId":"only if present in ledger","status":"met|gap|change-requested","evidence":"implementation location and verification evidence"}]}. Use actual values, not these placeholders. Report all configured requiredChecks by exact name. Include at least one relevant verification check. A met exitGate requires all reported checks passed and all reported obligations met.',
    'For an existing obligation, report only its id, status, concise evidence and any explicit proposedRequirement or reusedFromRunId. Omit unchanged source, requirement and workItemSourceId; the controller retains them from the ledger. Include source and requirement when adding a NEW obligation. Do not copy the whole ledger into each report. Conformance and final review must report every adopted obligation in scope. Other stages report affected obligations. Do not silently alter adopted requirements or scope. To propose a plan adjustment use status change-requested plus proposedRequirement with the exact proposed replacement, explain it, set exitGate.met false and ask the operator. A proposal is not approval; after approval the ledger contains the adopted replacement and it must still be implemented and verified. Required checks cannot be waived by a plan adjustment, stage budget or nit allowance.',
    'Keep evidence concise: cite source locations, commands, results and verification log paths. Do not repeat closed findings or earlier reports. Follow-up IDs listed in the ledger may be omitted while unchanged; report them if resolved, withdrawn, materially changed or reclassified as required. Never recycle IDs. New optional suggestions do not negate an otherwise met technical exit gate or require a changes-requested verdict. A real technical concern always does.',
    'Outside final review, an obligation may cite reusedFromRunId only for a completed stage at the SAME candidate and destination commits, with unchanged source, requirement and evidence. Omit reusedFromRunId when performing new verification. Prior evidence after any candidate/destination change is stale; verify affected obligations again. Final review revalidates them all.',
    'Every final message must contain exactly one ## Open questions section, containing only none if no operator input is required. Put it before ## Review report and the structured block. Genuine questions always stop progression.',
    ownsIntegrationResolution(cycle)
      ? 'Follow the owned conflict-resolution instructions: stage and verify, but do not commit or advance branches.'
      : 'Implementation runs must commit intended changes, run relevant checks and leave a clean worktree. Review runs are independent and read-only. Never merge or push; final promotion belongs exclusively to the operator.',
    value.instructions,
    stage.instructions,
  ]
    .filter(Boolean)
    .join('\n\n');
}
