/**
 * A run's brief (R-B7 run-context, the launch's step 8): its input, the rules file it names and
 * `brief.md`; with the adopted checks' part of it and the report of those the daemon ran first.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  mapCapabilities,
  ownsIntegrationResolution,
  type RepositoryCheckDeclarationId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { BaselinePreparationService } from '../../baseline-preparation.js';
import {
  type BriefInput,
  briefRules,
  citedRunPaths,
  composeBrief,
  RULES_FILE,
} from '../../brief.js';
import { scopeBrief, scopeNeedsKata } from '../../execution-scope.js';
import type { RuntimeEvidenceService } from '../../runtime-evidence-service.js';
import type { RunFiles, RunLaunch } from './materialize.js';

/**
 * The repository's adopted checks a run's gates are held to (R-G13), and the command that runs
 * each: the gate counts only the daemon's runs of them, so the agent must know to ask (LIVE-23).
 * The review is the run whose gate needs them; a working run is told to use them early; a design
 * or decision-preparation run changes nothing and is told nothing.
 */
export function declaredChecksBrief(
  storage: CraftingTableStorage,
  workspaceId: WorkspaceId,
  role: string,
  /**
   * Whether the run's checks get the Python profile (one is configured and the tree has a root
   * uv.lock), and whether agents' commands reach PyPI through the `pypi` source (R-G17).
   */
  python: 'none' | 'offline' | 'sync',
  pinned:
    | {
        readonly kind?: undefined;
        readonly checkDeclarationId?: RepositoryCheckDeclarationId;
        readonly binDirectory: string;
        readonly verification: { readonly mode: string };
      }
    | {
        /** A check-only run: no pinned environment (R-G13 increment 4). */
        readonly kind: 'checks';
        readonly checkDeclarationId: RepositoryCheckDeclarationId;
        readonly binDirectory: string;
      },
): string {
  const declaration =
    role !== 'design' &&
    pinned.checkDeclarationId &&
    storage.runtimeEvidence.checkDeclaration(workspaceId, pinned.checkDeclarationId);
  if (!declaration) return '';
  const commands = declaration.checks
    .map((check) => {
      const argv = JSON.stringify(check.argv);
      return `- ${pinned.binDirectory}/ct-check --declared ${check.id}   (CraftingTable runs the adopted ${argv.length > 200 ? `${argv.slice(0, 200)}…` : argv}; running that yourself does not count)`;
    })
    .join('\n');
  const beside =
    pinned.kind === 'checks'
      ? 'Other ct-check commands are supplemental and never replace them.'
      : pinned.verification.mode === 'scoped-checks'
        ? 'Other ct-check commands and Cargo builds are supplemental and never replace them.'
        : 'They are needed beside the pinned Cargo build/test; other ct-check commands are supplemental.';
  // A check-only run has no pinned environment: its gate is these checks alone (increment 4).
  const checkOnly =
    pinned.kind !== 'checks'
      ? ''
      : `Repository checks: this run has no pinned dependency environment, so its merge is gated on the repository's adopted checks alone, run by CraftingTable. ${pinned.binDirectory}/ct-check is on PATH; ct-check -- <executable> <arguments> runs a command you choose, which is recorded and counts for nothing.
`;
  // A Python project's checks install their own environment, then run offline (R-G19).
  const pythonText =
    python === 'none'
      ? ''
      : `Python: CraftingTable runs each of these checks in a fresh environment it installs from the adopted uv.lock with \`uv sync --locked\` (the lock may name only PyPI and the repository; the project and its console scripts are installed), then runs the check itself offline: the tests cannot download anything. ${
          python === 'sync'
            ? "Run `uv sync` first to get the same packages in your worktree (the uv on PATH is the operator's, and reaches PyPI only)."
            : 'Your commands reach no PyPI on this workstation (no `pypi` outside source), so packages the lock names cannot be installed in your worktree.'
        }
`;
  return role === 'review'
    ? `${checkOnly}${pythonText}Adopted repository checks (version ${declaration.version}): this review's gate needs a successful run of EACH on the reviewed head. CraftingTable runs each from the adopted definition on a private clone of that commit before this review starts, and appends their results below these instructions; those runs count for the gate. Report a failing check as a finding. To run one again, read-only (do not commit):
${commands}
${beside}
`
    : `${checkOnly}${pythonText}Adopted repository checks (version ${declaration.version}): the review of this work will need a successful run of EACH on the committed head, which CraftingTable runs from the adopted definition on a private clone of your committed head. After committing, run them to check your work early:
${commands}
${beside} If one fails, fix the code, not the check's definition files, which the operator adopts.
`;
}

/**
 * The adopted checks CraftingTable ran before a review started (R-G13 increment 3), for the
 * reviewer: each check's outcome, and a failed one's output copied into the run directory, which
 * the reviewer can read and the check logs are not.
 */
export function declaredCheckReport(
  results: readonly import('../../check-request-service.js').DeclaredCheckResult[],
  runDirectory: string,
): string {
  if (!results.length) return '';
  const directory = join(runDirectory, 'declared-checks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // The run directory is the agent's once it starts: never write through a link in it.
  const safe = lstatSync(directory).isDirectory();
  const lines = results.map((result) => {
    if (result.exitCode === 0) return `- ${result.checkId}: exited 0.`;
    let output = '';
    try {
      if (!safe) throw new Error('The declared-checks directory is not a directory.');
      const log = readFileSync(result.logPath);
      const copy = join(directory, `${result.checkId}.log`);
      // The end of the log is where a check says why it failed.
      writeFileSync(copy, log.subarray(Math.max(0, log.length - DECLARED_LOG_TAIL_BYTES)), {
        mode: 0o600,
        // Created here, never through an existing file or link.
        flag: 'wx',
      });
      output = ` Output: ${copy}`;
    } catch {
      /* no log: the check did not start */
    }
    const said = result.diagnostic.trim();
    // A diagnostic that quotes its log's last lines keeps them to themselves (R-C17 part 1).
    return `- ${result.checkId}: failed (exit ${result.exitCode}).${said ? ` ${said}` : ''}${said.includes('\n') && output ? `\n ${output}` : output}`;
  });
  return `

Adopted checks CraftingTable ran on the reviewed head before this review:
${lines.join('\n')}
A check counts for the gate only when it succeeded on the clean reviewed head. Read a failed check's output, and report it as a finding when the change caused it.
`;
}

/**
 * Whether a worktree builds with Cargo, for its brief (R-F2 part 6, AGT-55): a `Cargo.toml` at
 * its root or in a directory just below it (`rust/Cargo.toml`), outside hidden directories and
 * build output.
 */
export function buildsWithCargo(worktree: string): boolean {
  if (existsSync(join(worktree, 'Cargo.toml'))) return true;
  try {
    return readdirSync(worktree, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'target' &&
        existsSync(join(worktree, entry.name, 'Cargo.toml')),
    );
  } catch {
    return false;
  }
}

/** How much of a failed check's log a reviewer is given. */
const DECLARED_LOG_TAIL_BYTES = 64 * 1024;

/** What the launch prepared for the brief beyond the run's documents. */
export interface BriefLaunch extends RunLaunch {
  readonly files: RunFiles;
  readonly reviewArtifacts: readonly string[] | undefined;
  readonly temporaryDirectory: string;
  readonly buildCacheDirectory: string | undefined;
  readonly pinned: Awaited<ReturnType<RuntimeEvidenceService['prepare']>> | undefined;
  readonly checksOnly: ReturnType<RuntimeEvidenceService['prepareChecks']> | undefined;
  readonly historical: Awaited<ReturnType<BaselinePreparationService['materialize']>> | undefined;
  readonly pythonChecks: 'none' | 'offline' | 'sync';
}

/** Composes the run's brief and writes it, with the rules file it names (step 8). */
export function briefFor(
  storage: CraftingTableStorage,
  runsRoot: string,
  launch: BriefLaunch,
): string {
  const {
    workspaceId,
    input,
    prepared,
    cycle,
    preparation,
    investigation,
    runDirectory,
    reviewBranchContext,
    reviewArtifacts,
    temporaryDirectory,
    buildCacheDirectory,
    pinned,
    checksOnly,
    historical,
    pythonChecks,
  } = launch;
  const {
    planDirectory,
    planDocuments,
    records,
    directories,
    parentTurn,
    handoff,
    parentAssessment,
    scope,
  } = launch.files;
  const parentContext = prepared.parentRun?.reviewBranchContext;
  const briefInput: BriefInput = {
    ...(scope ? { executionScope: scopeBrief(scope) } : {}),
    ...(prepared.worktree.planVersionId &&
    input.role === 'review' &&
    !(
      cycle &&
      ((cycle.attempt?.resultContinuations ?? 0) > 0 || cycle.attempt?.providerRecovery)
    ) &&
    parentAssessment?.status === 'invalid'
      ? {
          reviewReportRetry: {
            issues: parentAssessment.issues,
            reuseVerification: !!(
              !cycle?.finalizationProgress &&
              parentContext &&
              reviewBranchContext &&
              parentContext.headSha === reviewBranchContext.headSha &&
              parentContext.targetSha === reviewBranchContext.targetSha &&
              parentContext.targetBranch === reviewBranchContext.targetBranch &&
              prepared.parentRun?.status === 'finished' &&
              parentTurn?.kind === 'turn-completed' &&
              parentTurn.payload.outcome === 'success' &&
              !parentTurn.payload.truncated &&
              !parentTurn.payload.resultText.endsWith('…[truncated by CraftingTable]')
            ),
          },
        }
      : {}),
    ...(reviewArtifacts === undefined ? {} : { reviewContinuationArtifacts: reviewArtifacts }),
    resolvingIntegration: ownsIntegrationResolution(cycle),
    planFinalization: !!prepared.worktree.planVersionId && !preparation && !investigation,
    ...(investigation ? { investigation: true } : {}),
    ...(input.output?.workflow ? { workflow: input.output.workflow } : {}),
    ...(input.output?.finalizationStage
      ? { finalizationStage: input.output.finalizationStage }
      : {}),
    // A design proposes architecture decisions only where the map has such checkpoints.
    ...(preparation ||
    (scope && mapCapabilities(scope.definition.source).architectureDecisions.length)
      ? { architectureDecisions: true }
      : {}),
    temporaryDirectory,
    ...(buildCacheDirectory ? { buildCacheDirectory } : {}),
    // A pinned environment is Cargo's; otherwise the worktree's own manifest says (AGT-55).
    ...(pinned || buildsWithCargo(prepared.worktree.path) ? { cargo: true } : {}),
    ...(pinned || checksOnly || historical
      ? {
          environment: {
            ...(pinned
              ? {
                  pinned: {
                    manifestPath: pinned.manifestPath,
                    binDirectory: pinned.binDirectory,
                    ...(pinned.nativeVerification
                      ? { nativeApprovalId: pinned.nativeVerification.approvalId }
                      : {}),
                    verification: pinned.verification,
                    dependencies: pinned.dependencies,
                    adoptedChecks: !!pinned.checkDeclarationId,
                    declaredChecks: declaredChecksBrief(
                      storage,
                      workspaceId,
                      input.role,
                      pythonChecks,
                      pinned,
                    ),
                    ...(pinned.localCi ? { localCiImage: pinned.localCi.image } : {}),
                    kata: !!scope && scopeNeedsKata(scope),
                  },
                }
              : {}),
            // A check-only run's brief names its adopted checks, and nothing of Cargo (R-G13
            // increment 4).
            ...(checksOnly
              ? {
                  checkOnly: declaredChecksBrief(
                    storage,
                    workspaceId,
                    input.role,
                    pythonChecks,
                    checksOnly,
                  ),
                }
              : {}),
            ...(historical
              ? {
                  historical: {
                    manifestPath: historical.manifestPath,
                    workspacePath: historical.workspacePath,
                    launcher: historical.launcher,
                    receiptPath: historical.receiptPath,
                  },
                }
              : {}),
          },
        }
      : {}),
    role: input.role,
    projectName: prepared.project.name,
    workItem: {
      sourceId: prepared.row.sourceId,
      title: prepared.row.title,
      risk: prepared.row.risk,
      ...(prepared.row.phase === undefined ? {} : { phase: prepared.row.phase }),
      primaryAreas: prepared.row.primaryAreas,
      exitGate: prepared.row.exitGate,
      sourceFields: prepared.row.sourceFields,
    },
    requiredDependencies: prepared.predecessors.filter((entry) => entry.kind === 'required'),
    recommendedDependencies: prepared.predecessors.filter((entry) => entry.kind === 'recommended'),
    worktree: {
      path: prepared.worktree.path,
      branchName: prepared.worktree.branchName,
      baseBranch: prepared.worktree.baseBranch,
      baseSha: prepared.worktree.baseSha,
      ...(prepared.worktree.integrationBranch === undefined
        ? {}
        : { integrationBranch: prepared.worktree.integrationBranch }),
    },
    ...(reviewBranchContext === undefined ? {} : { reviewBranchContext }),
    planDocuments,
    runDirectory,
    planDirectory,
    records,
    directories,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.stepGuidance ? { stepGuidance: input.stepGuidance } : {}),
    ...(input.controllerInstructions
      ? { controllerInstructions: input.controllerInstructions }
      : {}),
    ...(prepared.parentRun === undefined
      ? {}
      : {
          parentRun: {
            role: prepared.parentRun.role,
            ...(prepared.parentRun.verdict === undefined
              ? {}
              : { verdict: prepared.parentRun.verdict }),
            finalMessage: prepared.parentFinalMessage ?? '',
            // A review's digest is its report's findings; without a valid report, the
            // brief quotes the message and says why (G6-2).
            ...(parentAssessment?.status === 'complete'
              ? {
                  findings: parentAssessment.report.findings.map((finding) => ({
                    id: finding.id,
                    severity: finding.severity,
                    status: finding.status,
                    title: finding.title,
                  })),
                  exitGate: parentAssessment.report.exitGate,
                }
              : parentAssessment
                ? { reportIssues: parentAssessment.issues }
                : {}),
            // Links into run directories that have since gone are marked (AGT-57).
            expiredPaths: citedRunPaths(prepared.parentFinalMessage ?? '', runsRoot).filter(
              (path) => !existsSync(resolve(path)),
            ),
            ...(handoff === undefined ? {} : { handoff }),
          },
        }),
  };
  // The rules the brief refers to are a file it names (AGT-50).
  const rules = briefRules(briefInput);
  const rulesPath = join(planDirectory, RULES_FILE);
  if (rules)
    writeFileSync(rulesPath, `# The rules this run's brief refers to\n\n${rules}\n`, {
      mode: 0o600,
    });
  const brief = composeBrief(rules ? { ...briefInput, rulesPath } : briefInput);
  writeFileSync(join(runDirectory, 'brief.md'), brief, { mode: 0o600 });
  return brief;
}
