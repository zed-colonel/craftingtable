/**
 * The gates a cycle's command or resume passes before it is accepted (R-B7): readiness, an
 * investigation in progress, and the stops a plain resume would only repeat.
 */
import {
  raisesOpenQuestions,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceId,
  heldStop,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { BranchService } from '../branch-service.js';
import { investigationLive, worktreeChangeOpen } from '../investigation.js';
import { ExecutionRequestError } from '../errors.js';
import { requireReady } from './core/facts.js';
import type { RuntimeEvidenceService } from '../runtime-evidence-service.js';
import { workflowContext, unsettledDecisionsAt } from '../workflow-policy.js';

export class CycleGates {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly branches: BranchService,
    private readonly runtimeEvidence: RuntimeEvidenceService,
  ) {}

  requireReady(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId | undefined,
    scope?: import('@craftingtable/domain').ExecutionScope,
  ) {
    return requireReady(this.storage, workspaceId, workItemId, scope);
  }

  /**
   * While a stop's investigation runs, the stop accepts no command but ending it; once it
   * found the worktree changed, none that would continue on that tree but acknowledging the
   * change, until the tree matches its record again (R-C16). Stopping the cycle is allowed.
   */
  requireNoInvestigation(cycle: WorkCycle, ending = false): void {
    if (investigationLive(cycle))
      throw new ExecutionRequestError(
        'conflict',
        'An investigation of this stop is running. Wait for it, or end it, first.',
      );
    // Ending the cycle never builds on the changed tree, so the change does not hold it.
    if (!ending && worktreeChangeOpen(cycle))
      throw new ExecutionRequestError(
        'conflict',
        'The worktree changed while this stop’s investigation ran. Inspect it, then acknowledge the change first.',
        {
          reason: 'investigation-worktree-changed',
          paths: cycle.investigation?.result?.worktreeChange?.paths ?? [],
        },
      );
  }

  /**
   * The launch gates a resumed step must pass, checked before the command is accepted so
   * the operator sees the real blocker instead of a resume that bounces seconds later
   * (R-A7, CTRL-12). The launch checks them again at the mutation boundary.
   */
  async transitionGate(cycle: WorkCycle): Promise<void> {
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    // An owned integration resolution is gated by resolveIntegration itself.
    if (tree?.status !== 'active' || !cycle.workItemId) return;
    // Only a resume that relaunches the same step goes straight to launch; a finished
    // step first refreshes integration, which can bring the predecessors in.
    const run = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (
      cycle.step !== 'review' &&
      (!run || ['failed', 'cancelled', 'interrupted'].includes(run.status))
    )
      await this.branches.validateLaunch(tree);
  }

  /**
   * An `upstream-pin-moved` stop resumes only once the dependency refresh has pinned what moved
   * (LIVE-15): until then a resume would meet the same pin, with or without guidance. A pause
   * taken at the stop keeps its code, so it is held to the same rule.
   */
  async assertPinsRefreshed(cycle: WorkCycle): Promise<void> {
    const stop = heldStop(cycle);
    if (stop?.code !== 'upstream-pin-moved') return;
    const tree = this.storage.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
    if (!tree) return;
    const recorded = new Set((stop.refs?.pins ?? []).map((p) => p.alias));
    const stale = (await this.runtimeEvidence.movedPins(tree)).filter(
      (p) => recorded.size === 0 || recorded.has(p.alias),
    );
    if (stale.length)
      throw new ExecutionRequestError(
        'conflict',
        `${stale.map((p) => p.alias).join(', ')} still differs from its saved pin. Preview and save the dependency refresh in the dependency environment, then resume.`,
      );
  }

  /**
   * A `shared-decision-required` stop resumes, plain or guided, only once every shared decision
   * the slice's merge needs is settled (LIVE-18): until then a resume only reviews again into
   * the same gate. A pause taken at the stop keeps its code, so it is held to the same rule.
   */
  assertDecisionsSettled(cycle: WorkCycle): void {
    const unsettled = unsettledDecisionsAt(this.storage, cycle);
    if (unsettled.length)
      throw new ExecutionRequestError(
        'conflict',
        `${unsettled.join(', ')} ${unsettled.length === 1 ? 'is' : 'are'} not approved for this slice yet. Prepare and approve ${unsettled.length === 1 ? 'it' : 'them'} in Shared architecture decisions (approval needs the roadmap paused), then resume.`,
      );
  }

  /**
   * A step whose report still has open questions resumes only with guidance that answers them:
   * a plain resume would reclassify the same report. The roadmap skips such a cycle when it
   * resumes, rather than failing (LIVE-18 review).
   */
  resumeNeedsGuidance(cycle: WorkCycle): boolean {
    if (
      cycle.finalizationId ||
      (cycle.executionScope && cycle.executionScope.kind !== 'slice') ||
      !['implement', 'remediate', 'review'].includes(cycle.step)
    )
      return false;
    const run = this.storage.execution.runs.listForWorktree(cycle.workspaceId, cycle.worktreeId)[0];
    const turn =
      run &&
      this.storage.execution.runEvents.latestOfKind(cycle.workspaceId, run.id, 'turn-completed');
    return turn?.kind === 'turn-completed' && raisesOpenQuestions(turn.payload.resultText);
  }

  /**
   * A checkpoint attestation stop whose inputs changed since its review ran: a plain resume
   * reviews new evidence, so it is not redirected (R-C13). Unchanged inputs would only
   * repeat the same failed attestation (LIVE-07). A pause taken at the stop keeps its code.
   */
  attestationInputsChanged(cycle: WorkCycle): boolean {
    const active = cycle.workflow?.activeReview;
    const stop = heldStop(cycle);
    return (
      stop?.code === 'checkpoint-attestation-failed' &&
      active?.kind === 'checkpoint' &&
      workflowContext(this.storage, cycle)?.contextDigest !== active.contextDigest
    );
  }
}
