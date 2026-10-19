/**
 * The documents a run is given (R-B7 run-context, the launch's steps 6 and 7): the plan's
 * documents, CraftingTable's records and the directories it supplies, the parent's handoff and the
 * repository policy's evidence, written into the run directory with their refusals in today's
 * order.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentRun,
  DecisionPreparation,
  WorkCycle,
  WorkspaceId,
  Worktree,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { BranchService } from '../../branch-service.js';
import {
  type BriefDirectory,
  type BriefPlanDocument,
  type BriefRecord,
  RUN_RECORDS,
  SUPPLIED_DIRECTORIES,
} from '../../brief.js';
import { decisionPreparationDocuments } from '../../decision-preparation-policy.js';
import { collectDesignRecovery, readDesignRecoverySource } from '../../design-recovery.js';
import { ExecutionRequestError } from '../../errors.js';
import {
  resolveScope,
  scopeDefinitionRecord,
  scopeEvidenceIndex,
  scopeEvidenceLedger,
} from '../../execution-scope.js';
import { operatorDecisions } from '../../operator-decisions.js';
import { policyMismatch, REPOSITORY_POLICY_RULES, worktreePlan } from '../../repository-policy.js';
import { type StoppedWorktree, writeRunHandoff } from '../../run-handoff.js';
import { latestReviewReport, runCutOff } from '../../run-lineage.js';
import { scopeRepairPacket } from '../../scope-repair.js';
import type { InvestigationLaunch, StartRunInput } from '../shared.js';

/** What the launch read in its snapshot transaction, for the run's documents and brief. */
export interface LaunchSnapshot {
  readonly planVersionId: import('@craftingtable/domain').PlanVersionId;
  readonly worktree: Worktree;
  readonly project: { readonly name: string };
  readonly row: {
    readonly sourceId: string;
    readonly title: string;
    readonly risk: string;
    readonly phase?: string | undefined;
    readonly primaryAreas: readonly string[];
    readonly exitGate: string;
    readonly sourceFields: import('@craftingtable/domain').JsonValue;
  };
  readonly predecessors: readonly import('@craftingtable/storage').WorkItemDependencySummary[];
  readonly parentRun: AgentRun | undefined;
  readonly parentFinalMessage: string | undefined;
  readonly artifacts: readonly import('@craftingtable/storage').StoredPlanArtifact[];
}

/** The launch a run's documents and brief are for. */
export interface RunLaunch {
  readonly workspaceId: WorkspaceId;
  readonly input: StartRunInput;
  readonly prepared: LaunchSnapshot;
  readonly cycle: WorkCycle | undefined;
  readonly preparation: { readonly value: DecisionPreparation } | undefined;
  readonly investigation: InvestigationLaunch | undefined;
  readonly runDirectory: string;
  readonly reviewBranchContext: AgentRun['reviewBranchContext'];
}

/** The run's documents, and what reading them found, for its brief. */
export interface RunFiles {
  readonly planDirectory: string;
  readonly planDocuments: readonly BriefPlanDocument[];
  readonly records: readonly BriefRecord[];
  readonly directories: readonly BriefDirectory[];
  readonly parentTurn: ReturnType<CraftingTableStorage['execution']['runEvents']['latestOfKind']>;
  readonly handoff: ReturnType<typeof writeRunHandoff> | undefined;
  readonly parentAssessment: ReturnType<typeof latestReviewReport> | undefined;
  readonly scope: ReturnType<typeof resolveScope> | undefined;
}

/**
 * Where a worktree stands, for the handoff of a run that was cut off (`runCutOff`): its head
 * commit and uncommitted files, or why they could not be read (R-C17 part 2, its L-4 and part 4).
 */
async function whereStopped(branches: BranchService, worktree: Worktree): Promise<StoppedWorktree> {
  try {
    return await branches.uncommitted(worktree);
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : 'Git could not read it.' };
  }
}

/**
 * Writes the run's documents into its run directory (steps 6 and 7). Asynchronous in signature:
 * the parent's handoff reads where its worktree stopped, and the repository policy's evidence
 * reads the repository.
 */
export async function materializeRunFiles(
  storage: CraftingTableStorage,
  branches: BranchService,
  launch: RunLaunch,
): Promise<RunFiles> {
  const {
    workspaceId,
    input,
    prepared,
    cycle,
    preparation,
    investigation,
    runDirectory,
    reviewBranchContext,
  } = launch;
  const planDirectory = join(runDirectory, 'plan');
  mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
  const planDocuments = prepared.artifacts.map((artifact) => {
    const path = join(planDirectory, artifact.logicalFilename);
    writeFileSync(path, artifact.content, { mode: 0o600 });
    return { filename: artifact.logicalFilename, role: artifact.role, path };
  });
  // CraftingTable's own files for the run, each named in the brief with what it holds, and
  // the directories it supplies, each listed once (AGT-50, AGT-58).
  const records: BriefRecord[] = [];
  const directories: BriefDirectory[] = [];
  for (const record of input.records ?? []) {
    const path = join(planDirectory, record.filename);
    writeFileSync(path, record.content, { mode: 0o600 });
    records.push({ path, about: record.about });
  }
  if (preparation) {
    const directory = join(runDirectory, 'decision-preparation');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const documents = decisionPreparationDocuments(storage, preparation.value);
    for (const document of documents)
      writeFileSync(join(directory, document.name), document.content, { mode: 0o600 });
    directories.push({
      path: directory,
      ...SUPPLIED_DIRECTORIES.decisionPreparation(documents.length - 1),
    });
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          preparation: preparation.value,
          documents: documents.map((d) => ({ name: d.name, digest: d.digest })),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  if (investigation) {
    const directory = join(runDirectory, 'investigation');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const document of investigation.documents)
      writeFileSync(join(directory, document.name), document.content, { mode: 0o600 });
    directories.push({
      path: directory,
      ...SUPPLIED_DIRECTORIES.investigation(investigation.documents.map((d) => d.name)),
    });
  }
  if (cycle?.scopeRepair) {
    const path = join(planDirectory, 'craftingtable-scope-repair.json');
    writeFileSync(
      path,
      JSON.stringify(scopeRepairPacket(storage, cycle, { history: true }), null, 2),
      {
        mode: 0o600,
      },
    );
    records.push({ path, about: RUN_RECORDS['craftingtable-scope-repair.json'] });
  }
  if (cycle?.designRecovery) {
    const recovery = cycle.designRecovery;
    if (cycle.step === 'design' && recovery.runId === cycle.currentRunId) {
      const current = storage.readTransaction((tx) =>
        collectDesignRecovery(tx, cycle, recovery.sourceRunId),
      );
      if (current.snapshotDigest !== recovery.snapshotDigest)
        throw new ExecutionRequestError(
          'conflict',
          'Design recovery inputs changed before launch. Refresh discovery.',
        );
    }
    const recoveryDirectory = join(runDirectory, 'design-recovery');
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const entries = [
      { name: 'context.json', content: recovery.facts },
      ...recovery.sources.map((source, i) => ({
        name: `source-${i + 1}.txt`,
        content: readDesignRecoverySource(storage, cycle, source),
      })),
      ...recovery.attachments.map((attachment, i) => ({
        name: `operator-${i + 1}.txt`,
        content: `Operator-supplied supporting material: ${attachment.name}\nNot independently verified.\n\n${attachment.content}`,
      })),
      {
        name: 'manifest.json',
        content: JSON.stringify(
          {
            snapshotDigest: recovery.snapshotDigest,
            sources: recovery.sources.map((source, i) => ({
              file: `source-${i + 1}.txt`,
              ...source,
            })),
            attachments: recovery.attachments.map((attachment, i) => ({
              file: `operator-${i + 1}.txt`,
              name: attachment.name,
            })),
          },
          null,
          2,
        ),
      },
    ];
    for (const entry of entries)
      writeFileSync(join(recoveryDirectory, entry.name), entry.content, { mode: 0o600 });
    directories.push({
      path: recoveryDirectory,
      ...SUPPLIED_DIRECTORIES.designRecovery(recovery.sources.length, recovery.attachments.length),
    });
  }
  if (prepared.worktree.planVersionId) {
    const inventoryPath = join(planDirectory, 'craftingtable-work-items.json');
    writeFileSync(
      inventoryPath,
      JSON.stringify(
        storage.planning.workItems.listForVersion(workspaceId, prepared.planVersionId),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    records.push({ path: inventoryPath, about: RUN_RECORDS['craftingtable-work-items.json'] });
  }
  if (cycle?.finalizationProgress && cycle.finalizationId) {
    const staged = storage.execution.finalizations.find(workspaceId, cycle.finalizationId);
    const path = join(planDirectory, 'craftingtable-finalization-state.json');
    writeFileSync(
      path,
      JSON.stringify(
        {
          planVersionId: prepared.planVersionId,
          stages: staged?.stages,
          progress: cycle.finalizationProgress,
          reviewBaseline: reviewBranchContext,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    records.push({ path, about: RUN_RECORDS['craftingtable-finalization-state.json'] });
  }
  const parentTurn =
    prepared.parentRun &&
    storage.execution.runEvents.latestOfKind(workspaceId, prepared.parentRun.id, 'turn-completed');
  // A parent cut off (it never completed a turn, its latest completed turn ended in error, or it
  // was cut off in a later turn) left its work in the worktree: where it stopped goes into the
  // handoff (R-C17 part 2, its L-4 and part 4). Read once, for the worktree read and the record.
  const cutOff = prepared.parentRun && runCutOff(storage.execution, prepared.parentRun);
  const handoff =
    prepared.parentRun === undefined
      ? undefined
      : writeRunHandoff(
          storage.execution,
          prepared.parentRun,
          join(runDirectory, 'handoff'),
          cutOff === undefined
            ? undefined
            : { end: cutOff, worktree: await whereStopped(branches, prepared.worktree) },
        );
  const parentAssessment =
    prepared.parentRun && latestReviewReport(storage.execution, prepared.parentRun);
  const scope =
    prepared.worktree.executionScope && prepared.worktree.workItemId
      ? resolveScope(
          storage,
          workspaceId,
          prepared.worktree.workItemId,
          prepared.worktree.executionScope,
        )
      : undefined;
  if (scope) {
    const path = join(planDirectory, 'craftingtable-scope-evidence.json');
    // Accepted evidence as an index, its artifacts' bodies in files beside it (AGT-56); the
    // scope's definition, its identifiers and digests, here and not in the brief (AGT-58).
    const { ledger, bodies } = scopeEvidenceIndex(scopeEvidenceLedger(storage, scope));
    for (const body of bodies) {
      mkdirSync(dirname(join(planDirectory, body.file)), { recursive: true, mode: 0o700 });
      writeFileSync(join(planDirectory, body.file), body.content, { mode: 0o600 });
    }
    writeFileSync(
      path,
      JSON.stringify({ ...ledger, definition: scopeDefinitionRecord(scope) }, null, 2),
      { mode: 0o600 },
    );
    records.push({ path, about: RUN_RECORDS['craftingtable-scope-evidence.json'] });
  }
  const policyPlan = worktreePlan(storage, prepared.worktree);
  if (policyPlan) {
    const evidence = await branches.policyEvidence(workspaceId, policyPlan);
    if (policyMismatch(evidence.policy, prepared.worktree))
      throw new ExecutionRequestError(
        'conflict',
        'The worktree does not match the adopted repository policy.',
      );
    if (evidence.policy && evidence.issues.length)
      throw new ExecutionRequestError('conflict', evidence.issues.join(' '));
    if (
      reviewBranchContext &&
      evidence.policy?.version !== reviewBranchContext.repositoryPolicyVersion
    )
      throw new ExecutionRequestError(
        'conflict',
        'Repository policy changed during review preparation. Start a fresh review.',
      );
    const path = join(planDirectory, 'craftingtable-repository-policy.json');
    writeFileSync(path, JSON.stringify({ ...evidence, rules: REPOSITORY_POLICY_RULES }, null, 2), {
      mode: 0o600,
    });
    records.push({ path, about: RUN_RECORDS['craftingtable-repository-policy.json'] });
  }
  if (policyPlan) {
    const decisions = scope
      ? scopeEvidenceLedger(storage, scope).operatorDecisions
      : operatorDecisions(
          storage,
          workspaceId,
          prepared.worktree.workItemId
            ? [prepared.worktree.workItemId]
            : storage.planning.workItems.listForVersion(workspaceId, policyPlan).map((w) => w.id),
        );
    const path = join(planDirectory, 'craftingtable-operator-decisions.json');
    writeFileSync(
      path,
      JSON.stringify(
        { kind: 'operator-decisions-v1', planVersionId: policyPlan, decisions },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    records.push({ path, about: RUN_RECORDS['craftingtable-operator-decisions.json'] });
  }
  return {
    planDirectory,
    planDocuments,
    records,
    directories,
    parentTurn,
    handoff,
    parentAssessment,
    scope,
  };
}
