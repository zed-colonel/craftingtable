import { decisionPreparationDocuments } from './decision-preparation-policy.js';
import { moveRecords, unrecordedMoves } from './ref-watch.js';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type AgentBackend,
  AgentLaunchError,
  type AgentLaunchRequest,
  type AgentSession,
  type AgentSessionItem,
  type NormalizedAgentEvent,
} from '@craftingtable/agents';
import {
  AGENT_BACKEND_LABELS,
  AGENT_BACKENDS,
  AGENT_PROFILE_PURPOSES,
  type AgentBackendKind,
  type AgentBillingSource,
  type AgentExitReason,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunEventPayload,
  type AgentRunId,
  type AgentRunRole,
  type AgentRunStatus,
  type AgentRunVerdict,
  asAgentRunEventId,
  asAgentRunId,
  asAuditEventId,
  asEventId,
  finalizationProfile,
  isTerminalAgentRunStatus,
  modelSpelling,
  OUTPUT_REPAIR_LIMIT,
  ownsIntegrationResolution,
  PROFILE_INHERITANCE,
  type ReviewReportAssessment,
  type SessionId,
  type SpecialistProfile,
  type UserId,
  type WorkCycle,
  type WorkItemId,
  type WorkspaceAgentProfile,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
  OUTCOME_SUMMARY_LIMIT_BYTES,
  truncateUtf8Bytes,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import { AGENTS_ROOT_LOCK_FILE } from '../instance-lock.js';
import { cycleAgentSelection } from './agent-profile-policy.js';
import { removeAgentTree } from './agent-tree.js';
import { cycleOwnership } from './cycle-ownership.js';
import { WORKTREE_CACHES_DIRECTORY } from './storage-files.js';
import { offloadToolResult, readToolResult } from './tool-result-store.js';
import type { AuthContext, CommandContext } from './auth-service.js';
import type { BaselinePreparationService } from './baseline-preparation.js';
import type { BranchService } from './branch-service.js';
import { composeBrief } from './brief.js';
import { collectDesignRecovery, readDesignRecoverySource } from './design-recovery.js';
import { DaemonDrainingError, ExecutionRequestError, NotFoundError } from './errors.js';
import {
  requireNotRetired,
  requireTreeScope,
  resolveScope,
  scopeBrief,
  scopeEvidenceLedger,
} from './execution-scope.js';
import { finalizationForCycle, finalizationInstructions } from './finalization-policy.js';
import { assessStageReport } from './finalization-stage-policy.js';
import { scopeReviewerRoles } from './map-adoption-policy.js';
import { operatorDecisions } from './operator-decisions.js';
import { reservePhase } from './phase-resources.js';
import { REPOSITORY_POLICY_GUIDANCE, worktreePlan } from './repository-policy.js';
import { outputRepairPrompt, restartResumePrompt, sessionResumeSource } from './restart-resume.js';
import { assessReviewReport, finalVerdict } from './review-report.js';
import { latestReviewReport, requiredFindingIds, writeRunHandoff } from './run-handoff.js';
import type { RuntimeEvidenceService } from './runtime-evidence-service.js';
import { scopeRepairPacket } from './scope-repair.js';
import type { StorageService } from './storage-service.js';
import { controllerReviewRunnable, workflowPrompt } from './workflow-policy.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';
import { WorktreeMutationGuard } from './worktree-mutation-guard.js';

export interface StartRunInput {
  readonly backend?: AgentBackendKind;
  readonly worktreeId: WorktreeId;
  readonly role: AgentRunRole;
  readonly permissionMode: AgentPermissionMode;
  readonly model?: string;
  readonly reasoningEffort?: AgentRun['reasoningEffort'];
  /** Operator-authored instructions (a manual run's request, or the cycle's start text). */
  readonly instructions?: string;
  /** One-shot operator guidance for this run only. */
  readonly stepGuidance?: string;
  /** Controller-authored rules for an automated step; never presented as operator text. */
  readonly controllerInstructions?: string;
  readonly parentRunId?: AgentRunId;
}

/** A question stop's investigation, as the cycle service launches it (R-C16). */
export interface InvestigationLaunch {
  readonly value: import('@craftingtable/domain').CycleInvestigation;
  /** The run's `investigation/` context: the questions, the reports and the branch. */
  readonly documents: readonly { readonly name: string; readonly content: string }[];
  /** Refuses the launch once the cycle no longer holds this investigation. */
  readonly check: () => void;
}

export interface RunCommandResult {
  readonly run: AgentRun;
  readonly accepted: boolean;
}

export interface RunLog {
  warn(message: string, detail?: Readonly<Record<string, unknown>>): void;
}

class CycleLaunchCancelledError extends Error {}

/** A run's own directory beneath the agents' temporary root: random bytes, in hex (LIVE-31). */
/** The part of an agent selection the model checks read (R-G15). */
type ModelSelection = { readonly backend: AgentBackendKind; readonly model?: string };

const RUN_TEMPORARY_NAME_BYTES = 6;
const RUN_TEMPORARY_NAME = new RegExp(`^[0-9a-f]{${RUN_TEMPORARY_NAME_BYTES * 2}}$`);
/** How many of the entries a start's sweep left it names in its one warning. */
const LEFT_ENTRIES_NAMED = 20;

/**
 * A lock socket of the agents' root (R-G5): a daemon's published `<file>.<id>`, or one still
 * being published. The start sweep leaves them unnamed.
 */
function isRootLockSocket(root: string, name: string): boolean {
  if (!name.startsWith(AGENTS_ROOT_LOCK_FILE)) return false;
  try {
    return lstatSync(join(root, name)).isSocket();
  } catch {
    return false;
  }
}

/**
 * Whether `name` beneath `root` is a directory a run made (TS-H3): its name is one
 * `processTemporaryDirectory` gives, and it is a directory itself, never through a link.
 */
function isRunTemporaryDirectory(root: string, name: string): boolean {
  if (!RUN_TEMPORARY_NAME.test(name)) return false;
  try {
    return lstatSync(join(root, name), { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

interface LiveRun {
  readonly workspaceId: WorkspaceId;
  readonly runId: AgentRunId;
  readonly session: AgentSession;
  cancelRequested: boolean;
  /** Why it was cancelled, recorded when its process exits (an investigation's End, R-C16). */
  cancelMessage?: string;
  /** Set when a restart drain terminates the session; it then ends `interrupted`. */
  drainInterrupted?: boolean;
  /** The consumer is blocked on the session's next item (see `quiesce`). */
  awaitingItem?: boolean;
  done: Promise<void>;
}

const LIVE_STATUSES: readonly AgentRunStatus[] = ['starting', 'running', 'waiting'];
/** Bytes, matching the wire contract and the storage CHECK. */
/** A parent run's findings are reproduced in the brief up to this size. */
const PARENT_MESSAGE_LIMIT_BYTES = 256 * 1024;
/** The order roles occur in the development loop, for profile listings. */
const SHUTDOWN_GRACE_MS = 10_000;
const DRAIN_INTERRUPTED_MESSAGE =
  'CraftingTable stopped for a restart while this run was live. A cycle step resumes its session automatically after a clean restart.';

/**
 * Refuses a model the backend's catalog lists under another id: a display name, or another
 * spelling of an id (R-G15, LIVE-34). An id the catalog does not list at all is sent as typed,
 * since a catalog can lag a release.
 */
function refuseMisnamedModel(backend: AgentBackend, model: string | undefined): void {
  const misnamed = misnamedModel(backend, model);
  if (misnamed !== undefined)
    throw new AgentLaunchError('model-misnamed', `${misnamed} Nothing was started.`);
}

/** How long a launch waits for a backend's first catalog look after the daemon starts. */
const FIRST_CATALOG_LOOK_MS = 30_000;

/**
 * Right after a start the backend may still offer only the release's own list, which can lack
 * the model a display name belongs to; a launch then waits, bounded, for the first look at the
 * CLI's catalog (R-G15 review), which a refresh already under way shares.
 */
async function firstCatalogLook(backend: AgentBackend): Promise<void> {
  const { catalog } = backend.describe();
  if (catalog.source !== 'fallback' || catalog.checkedAt !== undefined) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    backend.listModels().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_CATALOG_LOOK_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** What is wrong with a model the backend's catalog lists under another id, if it is. */
function misnamedModel(backend: AgentBackend, model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const { label, models } = backend.describe();
  const spelling = modelSpelling(models, model);
  if (spelling.kind !== 'misnamed') return undefined;
  const what =
    model.trim().toLowerCase() === spelling.label.toLowerCase()
      ? 'the display name of'
      : 'another spelling of';
  return `${JSON.stringify(model)} is ${what} ${JSON.stringify(spelling.id)} in ${label}'s model list. Only the id can be sent.`;
}

function summarise(text: string): string {
  return truncateUtf8Bytes(text, OUTCOME_SUMMARY_LIMIT_BYTES);
}

/**
 * Starts, supervises, and records agent runs.
 *
 * The backend owns the process; this service owns durable run state, the
 * normalized event journal, audit, and workspace events. Status transitions
 * are guarded by expected-status sets so a late process callback can never
 * regress a run the operator already cancelled.
 */
/** Which source each upstream link was supplied from, and the transition that decided it (ADR-069). */
function upstreamSourcesBrief(
  dependencies: readonly {
    alias: string;
    commitSha: string;
    purpose: string;
    transition?: { slice: string; recordId?: string };
  }[],
): string {
  if (!dependencies.length) return 'Upstream sources: none supplied for this scope.';
  const line = (d: (typeof dependencies)[number]) =>
    `- ${d.alias}: ${d.purpose === 'current-upstream' ? 'current pin' : 'historical development source'} ${d.commitSha.slice(0, 12)}${d.transition ? ` (moves to the current pin at ${d.transition.slice}${d.transition.recordId ? `, declared by operator record ${d.transition.recordId}` : ', declared in the map'})` : ''}`;
  return `Upstream sources, chosen per link by the roadmap's declared transitions:\n${dependencies.map(line).join('\n')}\nBuild against exactly these sources. A link on its current pin already moved in this tree's history; do not revert it to a historical version.`;
}

/**
 * The repository's adopted checks a run's gates are held to (R-G13), and the command that runs
 * each: the gate counts only the daemon's runs of them, so the agent must know to ask (LIVE-23).
 * The review is the run whose gate needs them; a working run is told to use them early; a design
 * or decision-preparation run changes nothing and is told nothing.
 */
function declaredChecksBrief(
  storage: CraftingTableStorage,
  workspaceId: WorkspaceId,
  role: string,
  pinned: {
    readonly checkDeclarationId?: string;
    readonly binDirectory: string;
    readonly verification: { readonly mode: string };
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
    pinned.verification.mode === 'scoped-checks'
      ? 'Other ct-check commands and Cargo builds are supplemental and never replace them.'
      : 'They are needed beside the pinned Cargo build/test; other ct-check commands are supplemental.';
  return role === 'review'
    ? `Adopted repository checks (version ${declaration.version}): this review's gate needs a successful run of EACH on the reviewed head. CraftingTable runs each from the adopted definition on a private clone of that commit before this review starts, and appends their results below these instructions; those runs count for the gate. Report a failing check as a finding. To run one again, read-only (do not commit):
${commands}
${beside}
`
    : `Adopted repository checks (version ${declaration.version}): the review of this work will need a successful run of EACH on the committed head, which CraftingTable runs from the adopted definition on a private clone of your committed head. After committing, run them to check your work early:
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
  results: readonly import('./check-request-service.js').DeclaredCheckResult[],
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
    return `- ${result.checkId}: failed (exit ${result.exitCode}).${result.diagnostic ? ` ${result.diagnostic.trim()}` : ''}${output}`;
  });
  return `

Adopted checks CraftingTable ran on the reviewed head before this review:
${lines.join('\n')}
A check counts for the gate only when it succeeded on the clean reviewed head. Read a failed check's output, and report it as a finding when the change caused it.
`;
}
/** How much of a failed check's log a reviewer is given. */
const DECLARED_LOG_TAIL_BYTES = 64 * 1024;

/**
 * Whether a review may continue its parent's review on the parent's pinned baseline: a resumed
 * session; a review whose background work did not finish, or that failed with a service error
 * safe to retry; or one the drain stopped in its adopted checks, before its agent started
 * (R-G13 increment 3 verification).
 */
export function reviewContinuable(
  resumed: boolean,
  parent: Pick<AgentRun, 'id' | 'status' | 'startedAt'> | undefined,
  /** The parent's `run-finished` payload, when it has one. */
  finished: { readonly reason?: string } | undefined,
  providerRecovery: WorkCycle['providerRecovery'] | undefined,
): boolean {
  return (
    resumed ||
    (parent?.status === 'interrupted' &&
      parent.startedAt === undefined &&
      finished?.reason === 'daemon-drain') ||
    (parent?.status === 'failed' &&
      finished !== undefined &&
      (finished.reason === 'background-work-incomplete' ||
        (providerRecovery?.sourceRunId === parent.id && providerRecovery.failure.safeToRetry)))
  );
}

export class AgentRunService {
  private readonly preparationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly live = new Map<string, LiveRun>();
  /** Each launched run's short private temporary directory, until the run ends (LIVE-31). */
  private readonly processTemporaryDirectories = new Map<string, string>();
  /** Runs whose supervision failed; their killed sessions have not reported exit yet. */
  private readonly orphaned = new Set<LiveRun>();
  private readonly pendingCycleLaunches = new Map<AgentRunId, () => void>();
  /**
   * Reviews whose adopted checks run before their agent starts (R-G13 increment 3): how to cancel
   * each, and the launch that continues after them. A drain counts and cancels them like a
   * launch; `quiesce` waits for the launches, as it waits for cleanups.
   */
  private readonly checkingLaunches = new Map<
    string,
    {
      readonly workspaceId: WorkspaceId;
      readonly runId: AgentRunId;
      readonly cancel: () => void;
      readonly done: Promise<void>;
    }
  >();
  /**
   * Launches past their last drain check that are not yet live or in their checks: Git
   * preflight, the pinned evidence, the baseline. A drain counts them and waits for them
   * (R-G13 increment 3 verification).
   */
  private readonly startingLaunches = new Set<{
    workspaceId?: WorkspaceId;
    runId?: AgentRunId;
    done?: Promise<unknown>;
  }>();
  /** A restart is ending live sessions now: a launch that completes meanwhile is ended too. */
  private interrupting = false;
  /** A restart drain is in progress: no new run may start (R-B9). */
  private draining = false;
  /**
   * The daemon itself is being stopped by a signal. The service manager's stop signal may
   * reach agent process groups too, so a run killed by a signal from now on was stopped by
   * the restart. A drain a deploy requested stops nothing else, so there a signal is a
   * failure like any other.
   */
  private serviceStopping = false;
  /** Post-run cleanup still running; the controller skips a worktree until it settles. */
  private readonly cleanups = new Set<Promise<unknown>>();
  /** Runs and records the checks agents ask for (R-G4); absent, launchers run them inline. */
  private checks: import('./check-request-service.js').CheckRequestService | undefined;
  attachChecks(checks: import('./check-request-service.js').CheckRequestService): void {
    this.checks = checks;
  }
  /** Protected-ref snapshots around each run (R-G5, SEC-02d). */
  private refWatch:
    | {
        readonly watch: import('./ref-watch.js').RefWatch;
        readonly git: import('@craftingtable/git').GitOperations;
      }
    | undefined;
  attachRefWatch(
    watch: import('./ref-watch.js').RefWatch,
    git: import('@craftingtable/git').GitOperations,
  ): void {
    this.refWatch = { watch, git };
  }

  /** Flags protected branches that moved during a run by something other than the daemon. */
  private async checkProtectedRefs(workspaceId: WorkspaceId, runId: AgentRunId): Promise<void> {
    if (!this.refWatch) return;
    const run = this.storage.execution.runs.find(workspaceId, runId);
    const tree = run && this.storage.execution.worktrees.find(workspaceId, run.worktreeId);
    const owned = this.storage.execution.worktrees
      .listActive(workspaceId)
      .filter((w) => w.repositoryId === tree?.repositoryId)
      .map((w) => w.branchName)
      .concat(tree ? [tree.branchName] : []);
    const moves = await this.refWatch.watch.unexplainedMoves(runId, this.refWatch.git, owned);
    if (!moves.length) return;
    const described = moves
      .map(
        (m) =>
          `${m.branch} ${m.before?.slice(0, 12) ?? '(absent)'} → ${m.after?.slice(0, 12) ?? '(deleted)'}`,
      )
      .join(', ');
    this.appendEvent(workspaceId, runId, {
      kind: 'notice',
      payload: {
        category: 'other',
        message: `Protected branches moved during this run, not by CraftingTable: ${described}.`,
      },
    });
    const detectedAt = this.now().toISOString();
    // The audit stands on its own, so nothing about the records below can lose it.
    this.storage.transaction((tx) =>
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: detectedAt,
        actorKind: 'system',
        workspaceId,
        action: 'agent-run.protected-ref-moved',
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'failed',
        metadata: {
          repositoryId: tree?.repositoryId ?? null,
          moves: moves.map((m) => ({ branch: m.branch, before: m.before, after: m.after })),
        },
      }),
    );
    // Kept until the operator acknowledges it; the inbox shows it until then. A move another
    // run already recorded is not recorded again, and a large set takes several records.
    if (tree)
      this.storage.transaction((tx) => {
        const fresh = unrecordedMoves(
          tx.protectedRefs.unacknowledged(workspaceId, tree.repositoryId),
          moves.map((m) => ({ branch: m.branch, before: m.before, after: m.after })),
        );
        for (const chunk of moveRecords(fresh))
          tx.protectedRefs.add({
            id: randomUUID(),
            workspaceId,
            repositoryId: tree.repositoryId,
            runId,
            worktreeId: tree.id,
            detectedAt,
            moves: chunk,
          });
      });
  }

  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    private readonly config: ExecutionConfig,
    private readonly log: RunLog = { warn: () => undefined },
    private readonly now: () => Date = () => new Date(),
    private readonly mutations: WorktreeMutationGuard = new WorktreeMutationGuard(),
    private readonly branches?: BranchService,
    private readonly storageService?: StorageService,
    private readonly runtimeEvidence?: RuntimeEvidenceService,
    private readonly baselines?: BaselinePreparationService,
  ) {}

  hasBackend(kind: AgentBackendKind): boolean {
    return this.backends.has(kind);
  }

  /**
   * Refuses agent selections an operator submits whose model is a display name, or another
   * spelling of a catalog id (R-G15, LIVE-34): caught when it is chosen, not at a later launch.
   * Each selection is named by its slot (a role, an entry's step, a purpose). Only what a command
   * submits is checked, and a slot that keeps the model the record already saved there (`saved`)
   * is let through, so a saved selection is a warning and never blocks another change; the
   * launch check still stops it.
   */
  requireModelIds(
    selections: Iterable<readonly [slot: string, selection: ModelSelection | undefined]>,
    saved: Iterable<readonly [slot: string, selection: ModelSelection | undefined]> = [],
  ): void {
    const key = (slot: string, selection: ModelSelection) =>
      `${slot}\0${selection.backend}\0${selection.model}`;
    const kept = new Set(
      [...saved].flatMap(([slot, selection]) => (selection ? [key(slot, selection)] : [])),
    );
    for (const [slot, selection] of selections) {
      if (selection === undefined || kept.has(key(slot, selection))) continue;
      const backend = this.backends.get(selection.backend);
      const misnamed = backend && misnamedModel(backend, selection.model);
      if (misnamed !== undefined) throw new ExecutionRequestError('invalid-request', misnamed);
    }
  }

  backendAvailable(): boolean {
    return this.backends.size > 0;
  }

  defaultBackend(): AgentBackendKind | undefined {
    return AGENT_BACKENDS.find((kind) => this.backends.has(kind));
  }

  liveCount(): number {
    return this.live.size;
  }

  /* ---------------------------------------------------------------------- */
  /* Run profiles                                                            */
  /* ---------------------------------------------------------------------- */

  /** Every role, in role order; unsaved roles carry the daemon's default. */
  listRunProfiles(
    context: AuthContext,
    workspaceId: WorkspaceId,
    requestId?: string,
  ): readonly (WorkspaceAgentProfile & { readonly stored: boolean })[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.resolveProfiles(workspaceId);
  }

  saveRunProfiles(
    context: AuthContext,
    workspaceId: WorkspaceId,
    profiles: readonly WorkspaceAgentProfile[],
    requestId?: string,
  ): readonly (WorkspaceAgentProfile & { readonly stored: boolean })[] {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    this.requireModelIds(
      profiles.map((profile) => [profile.role, profile] as const),
      this.storage.execution.runProfiles
        .list(workspaceId)
        .map((profile) => [profile.role, profile] as const),
    );
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.execution.runProfiles.replace({
        workspaceId,
        profiles,
        occurredAt,
        updatedByUserId: context.user.id,
      });
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'run-profiles.updated',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        metadata: {
          profiles: profiles.map((profile) => ({
            role: profile.role,
            backend: profile.backend,
            model: profile.model ?? null,
            permissionMode: profile.permissionMode,
            reasoningEffort: profile.reasoningEffort ?? null,
          })),
        },
      });
    });
    return this.resolveProfiles(workspaceId);
  }

  /** The workspace's profiles as `listRunProfiles` returns them, read in the caller's read (R-D5). */
  profilesIn(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
  ): readonly (WorkspaceAgentProfile & { readonly stored: boolean })[] {
    return this.resolveProfiles(workspaceId, tx);
  }

  private resolveProfiles(
    workspaceId: WorkspaceId,
    tx: StorageRepositories = this.storage,
  ): readonly (WorkspaceAgentProfile & { readonly stored: boolean })[] {
    const stored = new Map(
      tx.execution.runProfiles.list(workspaceId).map((profile) => [profile.role, profile]),
    );
    const fallbackBackend = this.defaultBackend() ?? AGENT_BACKENDS[0];
    return AGENT_PROFILE_PURPOSES.map((role) => {
      const parent =
        role === 'remediate' ? 'implement' : PROFILE_INHERITANCE[role as SpecialistProfile];
      const inherited = parent
        ? (stored.get(parent) ?? (parent === 'remediate' ? stored.get('implement') : undefined))
        : undefined;
      const profile = stored.get(role) ?? inherited;
      return {
        ...(profile ?? { backend: fallbackBackend, permissionMode: 'auto' as const }),
        role,
        stored: stored.has(role),
      };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                                */
  /* ---------------------------------------------------------------------- */

  async start(
    context: AuthContext,
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    input: StartRunInput,
    requestId?: string,
  ): Promise<AgentRun> {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    this.requireManualControl(workspaceId, input.worktreeId);
    return this.launchAuthorized(
      workspaceId,
      workItemId,
      input,
      { userId: context.user.id, sessionId: context.session.id },
      requestId,
    );
  }

  /** Launched by an operator's command, or by the controller under the grantor (R-C3b). */
  async startDecisionPreparation(
    context: CommandContext,
    preparation: import('@craftingtable/domain').DecisionPreparation,
    check: () => void,
  ): Promise<AgentRun> {
    this.workspaceService.requireRole(context, preparation.workspaceId, ['owner', 'editor']);
    check();
    return this.launchAuthorized(
      preparation.workspaceId,
      undefined,
      {
        ...preparation.profile,
        permissionMode: 'edit-only',
        role: 'design',
        worktreeId: preparation.worktreeId,
        instructions: `Prepare an operator decision brief for ${preparation.checkpointId}. This is read-only decision preparation, not work-item implementation or finalization. Read the exact imported sources and decision-preparation/context.json. Do not change source, commit, merge, run builds, provision environments, approve decisions or claim tests passed. Work-item start/merge gates do not prevent preparing this recommendation. Cite facts and distinguish them from proposed choices; identify information genuinely unavailable. Recommend full architecture coverage only when the choice can be settled without future implementation evidence; otherwise name narrow clauses and preserve the full checkpoint. Include one consolidated craftingtable-design block with an operator-decision item and a decision recommendation for exactly ${preparation.checkpointId}; include decisionText, why, at least one alternative with tradeoff, consequences, coverage, consumers and retainedObligations. A full recommendation has consumers: []; implementation and tests retain their gates. Your final message is the artifact; do not write report files.\n\nOperator guidance:\n${preparation.instructions}`,
      },
      { userId: context.user.id, ...(context.session ? { sessionId: context.session.id } : {}) },
      undefined,
      undefined,
      { purpose: 'investigation', preparationId: preparation.id },
      { value: preparation, check },
    );
  }

  /**
   * A question stop's read-only investigation (R-C16): beside the cycle, never its run. It
   * starts from the stop's run, whose report and handoff it reads, and carries the
   * investigation's id, which keeps it out of the worktree's lineage.
   */
  async startInvestigation(
    context: CommandContext,
    cycle: WorkCycle,
    launch: InvestigationLaunch,
    rules: string,
  ): Promise<AgentRun> {
    this.workspaceService.requireRole(context, cycle.workspaceId, ['owner', 'editor']);
    launch.check();
    const { value } = launch;
    return this.launchAuthorized(
      cycle.workspaceId,
      cycle.workItemId,
      {
        backend: value.profile.backend,
        ...(value.profile.model === undefined ? {} : { model: value.profile.model }),
        ...(value.profile.reasoningEffort
          ? { reasoningEffort: value.profile.reasoningEffort }
          : {}),
        permissionMode: 'edit-only',
        role: 'design',
        worktreeId: cycle.worktreeId,
        parentRunId: value.sourceRunId,
        controllerInstructions: rules,
        ...(value.instructions.trim() ? { stepGuidance: value.instructions } : {}),
      },
      { userId: context.user.id, ...(context.session ? { sessionId: context.session.id } : {}) },
      undefined,
      undefined,
      { purpose: 'investigation', investigationId: value.id },
      undefined,
      launch,
    );
  }

  /** Ends an investigation its cycle no longer holds; the run is read-only, so nothing is lost. */
  cancelInvestigation(workspaceId: WorkspaceId, runId: AgentRunId, message: string): void {
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (!run?.profileSelection?.investigationId || isTerminalAgentRunStatus(run.status)) return;
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun !== undefined) {
      liveRun.cancelRequested = true;
      liveRun.cancelMessage = message;
      liveRun.session.kill();
      return;
    }
    this.finalize(workspaceId, runId, 'cancelled', { message });
  }

  private requireCycleLaunchAuthority(cycle: WorkCycle): void {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    const user = this.storage.users.findById(cycle.createdByUserId);
    const authorization = this.storage.workspaces.findAuthorized(
      cycle.createdByUserId,
      cycle.workspaceId,
    );
    if (
      stored?.status !== 'running' ||
      stored.version !== cycle.version ||
      user?.status !== 'active' ||
      !authorization ||
      !['owner', 'editor'].includes(authorization.membership.role)
    ) {
      throw new ExecutionRequestError(
        'conflict',
        'Cycle no longer has authority to launch this step',
      );
    }
    if (cycle.workflow?.activeReview && !controllerReviewRunnable(this.storage, cycle))
      throw new ExecutionRequestError(
        'conflict',
        'Controller review is held by paused scheduling or an entry hold.',
      );
    if (
      cycle.providerRecovery &&
      (cycleOwnership(this.storage, cycle)?.roadmap.status ?? 'running') !== 'running'
    )
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; service retry is held.',
      );
    if (this.now().getTime() >= Date.parse(cycle.runDeadlineAt))
      throw new ExecutionRequestError('conflict', 'Step time limit reached during Git preflight');
  }

  isCleaningRun(worktreeId: WorktreeId): boolean {
    return this.storageService?.isCleaningRun(worktreeId) ?? false;
  }

  async startForCycle(cycle: WorkCycle): Promise<AgentRun> {
    this.requireCycleLaunchAuthority(cycle);
    if (cycle.workflow?.activeReview && !controllerReviewRunnable(this.storage, cycle))
      throw new ExecutionRequestError(
        'conflict',
        'Roadmap scheduling is paused; controller review launch is held.',
      );
    const existing = this.storage.execution.runs.find(cycle.workspaceId, cycle.currentRunId);
    if (existing !== undefined) return existing;
    const resolution = ownsIntegrationResolution(cycle) ? cycle.integrationResolution : undefined;
    const finalization = finalizationForCycle(this.storage, cycle);
    // Every path that launches a finalization run (cycle control, service retries,
    // continuations) ends here; a stage-less finalization is retired (R-B10) and gets no run.
    if (finalization && !finalization.stages)
      throw new ExecutionRequestError(
        'conflict',
        'This finalization uses retired improvement rounds. Stop it and start a staged finalization.',
      );
    const recovery =
      cycle.step === 'design' && cycle.designRecovery?.runId === cycle.currentRunId
        ? cycle.designRecovery
        : undefined;
    const selected = cycleAgentSelection(this.storage, cycle);
    // A resumed session keeps the agent, model and permissions it was started with.
    const resumed = sessionResumeSource(
      this.storage.execution,
      cycle,
      cycle.parentRunId && this.storage.execution.runs.find(cycle.workspaceId, cycle.parentRunId),
    )?.run;
    const profile =
      (resumed
        ? {
            backend: resumed.backend,
            permissionMode: resumed.permissionMode,
            ...(resumed.model === undefined ? {} : { model: resumed.model }),
            ...(resumed.reasoningEffort ? { reasoningEffort: resumed.reasoningEffort } : {}),
          }
        : undefined) ??
      (recovery
        ? { permissionMode: cycle.profiles.design.permissionMode, ...recovery.profile }
        : undefined) ??
      (finalization ? finalizationProfile(finalization, cycle) : undefined) ??
      resolution?.profile ??
      (selected.provenance.assignmentId ? selected.profile : cycle.providerRecovery?.profile) ??
      selected.profile;
    return this.launchAuthorized(
      cycle.workspaceId,
      cycle.workItemId,
      {
        ...profile,
        worktreeId: cycle.worktreeId,
        role: cycle.step === 'remediate' ? 'implement' : cycle.step,
        ...(cycle.parentRunId === undefined ? {} : { parentRunId: cycle.parentRunId }),
        instructions: cycle.instructions,
        stepGuidance: [cycle.stepGuidance, recovery?.instructions, resolution?.instructions]
          .filter(Boolean)
          .join('\n\n'),
        controllerInstructions: [
          ownsIntegrationResolution(cycle) ? '' : workflowPrompt(this.storage, cycle),
          cycle.providerRecovery
            ? `This is service retry ${cycle.providerRecovery.attempts} of 3 for the SAME step after a model-service failure, in a fresh session with the configured retry backend/model. Read the prior handoff and partial scratch records; preserve completed work and unresolved findings. Inspect the current worktree and evidence before continuing. Do not assume an interrupted check passed, repeat completed side effects blindly, or treat a draft report as accepted. Complete every required check and the final report. Report genuine decisions in ## Open questions; never decide them for the operator. If the previous attempt stopped with questions the service failure caused, do not repeat them; ask again any that remain. The step deadline still applies; it moved only by time spent waiting for a usage-limit reset or for the provider to accept credentials.`
            : '',
          cycle.scopeRepair
            ? 'Read craftingtable-scope-repair.json in the supplied plan documents. It contains pinned findings from independent slice and parent reviews. Address every namespaced finding ID, including findings from older parent reviews; identical original IDs from different runs are separate obligations. The history of a finding shows how earlier review rounds reported it; the examples cited in every round remain work until verified fixed. Reviewers must include every namespaced finding with a supported disposition. Current adopted policy answers superseded administrative questions; do not invent a new policy. Source changes belong only to this owning slice. When a finding identifies a broad or recurring family, audit that family systematically in bounded batches, including analogous producers, consumers, assertions and evidence. Explain coverage, actual corrections, remaining gaps and reproducible checks; do not merely patch cited examples or weaken acceptance checks. Ask for genuinely new decisions without expanding scope. Commit intended changes; do not merge.'
            : '',
          ...(recovery
            ? [
                'This is a bounded design-question recovery in the existing worktree. Read the complete prior handoff, recovery context, shared source documents and operator attachments before asking for information again.',
                'Collect verifiable facts and cite exact artifacts, commits and commands. Saved pins and imported documents are context, not proof that tests passed. Separate repository observations, missing evidence, and decisions that require the operator. Do not invent owners, measurements, protection rules or acceptance receipts.',
                'Do not implement product changes, create/publish tags, change branch protection, push, merge or amend adopted requirements. Preserve source code; keep collected reports and logs in the supplied run scratch directory. Repository administration needs a separate explicit operator action.',
                recovery.mode === 'investigate'
                  ? 'Investigate the unresolved questions and report evidence and remaining decisions. Classify each question in the design report: resolved only with a cited answer; anything the operator must decide stays an operator decision. If every question is resolved and Open questions is none, the controller continues the design with your evidence; otherwise it pauses for operator review.'
                  : 'Apply the operator answers and supporting evidence to complete the design. The controller advances only if no genuine questions remain. Keep unresolved evidence requirements explicit.',
              ]
            : []),
          cycle.executionScope && cycle.executionScope.kind !== 'slice'
            ? `Operator-designated independent reviewer responsibilities: ${scopeReviewerRoles(this.storage, cycle.workspaceId, cycle.executionScope).join(', ') || 'standard independent review'}. Supply evidence for every applicable responsibility; if you cannot perform a required review, report an open question rather than claiming it passed.`
            : '',
          finalization ? finalizationInstructions(finalization, cycle) : '',
          resolution ? '' : (cycle.housekeepingInstructions ?? ''),
          ...(resolution
            ? [
                'This is a daemon-owned integration conflict resolution. Do not start, abort, or commit a merge; do not commit source edits. Resolve files and explicitly stage all intended changes. The daemon completes the merge.',
                `Keep item HEAD at ${resolution.headSha} and MERGE_HEAD at ${resolution.targetSha}. The integration branch is ${resolution.targetBranch}; do not move it.`,
                `Conflict files: ${resolution.paths.join(', ')}`,
                resolution.diagnostics,
                'Read the supplied plan and both sides of the incoming commits. Preserve both work items’ intended behavior, including automatically merged files. Use the supplied scratch directory, run the repository checks on the combined state, and report commands, outcomes and any semantic decisions. Remove only your confirmed generated files; leave no untracked files. Preserve existing finding IDs in the handoff.',
                'If questions remain or checks fail, explain them and end with ## Resolution status followed by blocked. Only when every conflict is resolved, intended changes are staged, and checks pass, end with ## Resolution status followed by ready. A successful process exit alone is not approval.',
              ]
            : []),
          (cycle.resultContinuations ?? 0) > 0
            ? `This is completion recovery attempt ${cycle.resultContinuations} of 2 for the SAME step. The previous agent exited while awaiting background work; its result is incomplete. CraftingTable waited for its owned process group to finish before this launch. Read the previous run handoff and its scratch verification records; do not assume any check passed. Reuse recorded passing checks only when their source commit, destination commit where relevant, inputs, and complete logs still match. Inspect and address failures; finish missing verification and reporting without restarting the whole polish pass or adding unrelated improvements. Keep every unresolved finding and operator question. If a decision is needed, report it in ## Open questions and stop rather than deciding for the operator. Do not detach commands with nohup, disown, or a new session. Await background work and produce the final outcome before ending; the original step time limit still applies.`
            : '',
          'Keep verification commands owned by the agent session. Do not use nohup, disown, or setsid to detach work. Wait for background commands to finish, collect their results, and stop any monitors you started before emitting the final outcome.',
          'This run is one step of an operator-authorized automated cycle. Do not merge. Complete this step and provide a final message; the controller handles the next step.',
          cycle.step === 'design'
            ? 'End with exactly one section headed ## Open questions. Its entire body must be none when there are no unresolved questions. Otherwise list the questions for the operator.'
            : '',
          cycle.executionScope && cycle.executionScope.kind !== 'slice'
            ? 'This is an independent review of the integration snapshot. Do not implement changes or commit. Report findings for recovery in the owning slice. Include exactly one ## Open questions section containing only none if no input is needed, otherwise list questions. Put it BEFORE ## Review report and the structured report; keep the final VERDICT line last.'
            : '',
          cycle.step === 'review' && (cycle.integrationRefreshes ?? 0) > 0
            ? 'The integration branch has been refreshed during this cycle. Review the combined changes and rerun the relevant repository checks; a prior review or a clean Git merge is not verification of this state.'
            : '',
          !resolution && cycle.step === 'remediate'
            ? cycle.finalizationProgress
              ? 'Address required correctness/conformance findings and all blocking/major findings. For optional improvements, implement the selected stage batch (or the explicit focused recovery subset) only; preserve every other selected finding for later verification. Do not implement retained optional follow-ups or restart discovery. Preserve finding IDs and provide evidence of each resolution.'
              : `Address all open blocking, major, and minor findings, and reduce open nits to at most ${cycle.policy.maxNits}. Preserve finding IDs and give the reviewer evidence of each resolution.`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      { userId: cycle.createdByUserId },
      undefined,
      cycle,
      {
        purpose: selected.provenance.purpose,
        ...(selected.provenance.delegationId
          ? { delegationId: selected.provenance.delegationId }
          : {}),
        ...(profile.backend === selected.profile.backend &&
        profile.model === selected.profile.model &&
        profile.reasoningEffort === selected.profile.reasoningEffort &&
        selected.provenance.assignmentId
          ? { assignmentId: selected.provenance.assignmentId }
          : {}),
      },
    );
  }

  /**
   * Why a launch that waited (a review's adopted checks) may no longer start its agent: its
   * cycle moved on, was paused or stopped, lost its launch authority or its time; or the person
   * who started a manual run lost the permission to.
   */
  private launchRefusal(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    worktreeId: WorktreeId,
    userId: UserId,
    cycle: WorkCycle | undefined,
  ): string | undefined {
    // Its scope may have been retired or held by an amendment while the checks ran.
    const tree = this.storage.execution.worktrees.find(workspaceId, worktreeId);
    if (!tree) return 'The worktree is gone.';
    try {
      requireTreeScope(this.storage, tree, 'start');
    } catch (error) {
      return error instanceof Error ? error.message : 'The worktree may no longer start work.';
    }
    if (cycle) {
      const latest = this.storage.execution.cycles.find(workspaceId, cycle.id);
      if (latest?.currentRunId !== runId || latest.status !== 'running')
        return 'The cycle moved on before its review started.';
      try {
        // The stored cycle, not the one the launch began with: a change to its fields is not a
        // change of authority.
        this.requireCycleLaunchAuthority(latest);
      } catch (error) {
        return error instanceof Error ? error.message : 'The cycle lost its launch authority.';
      }
      return undefined;
    }
    const user = this.storage.users.findById(userId);
    const access = this.storage.workspaces.findAuthorized(userId, workspaceId);
    return user?.status !== 'active' ||
      !access ||
      !['owner', 'editor'].includes(access.membership.role)
      ? 'Run launch permission changed while the review’s checks ran.'
      : undefined;
  }

  /**
   * Stops a review's adopted checks while its agent has not started (R-G13 increment 3): its
   * cycle was paused. The launch then starts no agent; a live session is left alone.
   */
  cancelStartingChecks(runId: string): void {
    this.checkingLaunches.get(runId)?.cancel();
  }

  /** Only the controller can close/terminate its reserved session. No browser authority bypass. */
  finishCycleTurn(cycle: WorkCycle, cancel = false): boolean {
    const stored = this.storage.execution.cycles.find(cycle.workspaceId, cycle.id);
    if (stored?.currentRunId !== cycle.currentRunId) return false;
    if (cancel) {
      this.pendingCycleLaunches.get(cycle.currentRunId)?.();
      // A review still running its adopted checks: stop them; its agent never starts (R-G13).
      this.checkingLaunches.get(cycle.currentRunId)?.cancel();
    }
    const live = this.liveRun(cycle.workspaceId, cycle.currentRunId);
    if (live === undefined) return false;
    if (!cancel && live.session.backgroundWorkPending) return false;
    if (cancel) {
      live.cancelRequested = true;
      live.session.kill();
    } else live.session.end();
    return true;
  }

  private requireNoBackgroundWork(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    exceptRunId?: AgentRunId,
  ): void {
    this.mutations.requireNoTerminatingAgent(worktreeId);
    for (const live of this.live.values()) {
      if (
        live.workspaceId !== workspaceId ||
        live.runId === exceptRunId ||
        !live.session.backgroundWorkPending
      )
        continue;
      if (this.storage.execution.runs.find(workspaceId, live.runId)?.worktreeId === worktreeId)
        throw new ExecutionRequestError(
          'conflict',
          'This worktree still has background work awaiting completion. Wait for its outcome or cancel the owning run before starting another run.',
        );
    }
  }

  /**
   * One agent per worktree: two live sessions editing one checkout make the diff
   * and review attribution ambiguous (AGT-13). A handoff source that is still
   * waiting keeps its process alive, so it must be ended first.
   */
  private requireNoLiveRun(workspaceId: WorkspaceId, worktreeId: WorktreeId): void {
    const live = this.storage.execution.runs.liveForWorktree(workspaceId, worktreeId).length > 0;
    if (live)
      throw new ExecutionRequestError(
        'conflict',
        'Another agent run is still live in this worktree. End or cancel it before starting another.',
      );
  }

  private requireManualControl(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    existingRunId?: AgentRunId,
  ): void {
    this.requireNoBackgroundWork(workspaceId, worktreeId, existingRunId);
    const cycle = this.storage.execution.cycles.activeForWorktree(workspaceId, worktreeId);
    if (ownsIntegrationResolution(cycle) && existingRunId !== cycle?.currentRunId)
      throw new ExecutionRequestError(
        'conflict',
        'This worktree belongs to an integration resolution. Resume or abandon that resolution first.',
      );
    if (cycle?.status === 'running' || cycle?.status === 'awaiting-merge') {
      throw new ExecutionRequestError(
        'conflict',
        'Pause or stop automation before taking manual control of this worktree',
      );
    }
  }

  private async launchAuthorized(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId | undefined,
    input: StartRunInput,
    actor: { readonly userId: UserId; readonly sessionId?: SessionId },
    requestId?: string,
    cycle?: WorkCycle,
    profileSelection?: AgentRun['profileSelection'],
    preparation?: { value: import('@craftingtable/domain').DecisionPreparation; check: () => void },
    investigation?: InvestigationLaunch,
  ): Promise<AgentRun> {
    if (this.draining) throw new DaemonDrainingError();
    // Controller-run, read-only and deadline-bound (ADR-065, R-C16): a decision preparation or
    // a question stop's investigation. Neither is a cycle's run, and each ends after one turn.
    const controlled = preparation
      ? {
          runId: preparation.value.runId,
          deadlineAt: preparation.value.deadlineAt,
          check: preparation.check,
          limit:
            'Decision preparation reached its time limit. Review partial results and explicitly start another preparation if needed.',
        }
      : investigation
        ? {
            runId: investigation.value.runId,
            deadlineAt: investigation.value.deadlineAt,
            check: investigation.check,
            limit:
              'The investigation reached its time limit. Review its partial output and start another if needed.',
          }
        : undefined;
    await this.storageService?.waitForRunCleanup(input.worktreeId);
    const preparationTree = this.storage.roadmaps
      .list(workspaceId)
      .some((r) => r.decisionPreparations?.some((p) => p.worktreeId === input.worktreeId));
    if (preparationTree && (!preparation || input.role !== 'design' || workItemId))
      throw new ExecutionRequestError(
        'conflict',
        'Decision worktrees only permit their reserved read-only preparation run.',
      );
    controlled?.check();
    if (this.storage.execution.merges.latest(workspaceId, input.worktreeId)?.status === 'reserved')
      throw new ExecutionRequestError(
        'conflict',
        'Recover the reserved integration merge before launching another run',
      );
    const kind = input.backend ?? this.defaultBackend();
    const backend = kind === undefined ? undefined : this.backends.get(kind);
    if (backend === undefined) {
      throw new ExecutionRequestError(
        'unavailable',
        kind === undefined
          ? 'No agent executable was found; install Claude Code or Codex, or set CRAFTINGTABLE_CLAUDE_EXECUTABLE / CRAFTINGTABLE_CODEX_EXECUTABLE'
          : `${AGENT_BACKEND_LABELS[kind]} was not found on this workstation`,
      );
    }

    const prepared = this.storage.readTransaction((tx) => {
      const item = workItemId ? tx.planning.workItems.find(workspaceId, workItemId) : undefined;
      const worktree = tx.execution.worktrees.find(workspaceId, input.worktreeId);
      if (
        worktree === undefined ||
        worktree.workItemId !== workItemId ||
        (!item && !worktree.planVersionId)
      ) {
        throw new NotFoundError();
      }
      if (worktree.status !== 'active') {
        throw new ExecutionRequestError('conflict', 'Worktree has been removed');
      }
      // An investigation reads; the scope's start gates and its review-only rule do not apply.
      if (investigation) requireNotRetired(tx, worktree);
      else requireTreeScope(tx, worktree, 'start');
      if (
        !investigation &&
        worktree.executionScope &&
        worktree.executionScope.kind !== 'slice' &&
        input.role !== 'review'
      )
        throw new ExecutionRequestError(
          'conflict',
          'Parent acceptance worktrees only permit independent review runs.',
        );
      const repository = tx.execution.sourceRepositories.find(workspaceId, worktree.repositoryId);
      const planVersionId = item?.planVersionId ?? worktree.planVersionId;
      if (!planVersionId) throw new NotFoundError();
      const project = tx.planning.projects.find(workspaceId, worktree.projectId);
      const row =
        tx.planning.workItems
          .listForVersion(workspaceId, planVersionId)
          .find((candidate) => candidate.id === workItemId) ??
        (worktree.planVersionId
          ? {
              sourceId: preparation?.value.checkpointId ?? 'Finalization',
              title: preparation
                ? 'Prepare architecture decision for operator review'
                : 'Plan conformance, simplification and polish',
              risk: 'high',
              phase: undefined,
              primaryAreas: [],
              exitGate: preparation
                ? 'Return a source-backed architecture recommendation for explicit operator approval. No implementation or verification is authorized.'
                : 'The entire adopted plan conforms, required checks pass, and the final findings policy is met.',
              sourceFields: {
                planVersionId,
                scope: preparation ? 'decision-preparation' : 'whole-plan',
              },
            }
          : undefined);
      if (repository === undefined || project === undefined || row === undefined) {
        throw new NotFoundError();
      }
      const predecessors = workItemId
        ? tx.planning.dependencies.listPredecessors(workspaceId, workItemId)
        : [];
      let parentRun: AgentRun | undefined;
      let parentFinalMessage: string | undefined;
      if (input.parentRunId !== undefined) {
        parentRun = tx.execution.runs.find(workspaceId, input.parentRunId);
        if (
          parentRun === undefined ||
          parentRun.workItemId !== workItemId ||
          parentRun.worktreeId !== input.worktreeId
        ) {
          throw new NotFoundError();
        }
        if (parentRun.status === 'starting' || parentRun.status === 'running') {
          throw new ExecutionRequestError(
            'conflict',
            'Wait for the source turn to finish before handing it off',
          );
        }
        // The journal holds the full final message; the run row only a bounded summary.
        const lastTurn = tx.execution.runEvents.latestOfKind(
          workspaceId,
          parentRun.id,
          'turn-completed',
        );
        parentFinalMessage =
          lastTurn?.kind === 'turn-completed'
            ? truncateUtf8Bytes(lastTurn.payload.resultText, PARENT_MESSAGE_LIMIT_BYTES)
            : parentRun.outcomeSummary;
      }
      const artifacts = tx.planning.artifacts
        .listForVersion(workspaceId, planVersionId)
        .map((artifact) => tx.planning.artifacts.findWithContent(workspaceId, artifact.id))
        .filter((artifact) => artifact !== undefined);
      return {
        planVersionId,
        worktree,
        repository,
        project,
        row,
        predecessors,
        parentRun,
        parentFinalMessage,
        artifacts,
      };
    });

    const resume =
      cycle === undefined
        ? undefined
        : sessionResumeSource(this.storage.execution, cycle, prepared.parentRun);
    if (resume !== undefined && resume.run.backend !== backend.kind)
      throw new ExecutionRequestError(
        'conflict',
        'The interrupted session belongs to another agent backend and cannot be resumed.',
      );

    const starting: { workspaceId?: WorkspaceId; runId?: AgentRunId; done?: Promise<unknown> } = {};
    const launch = this.mutations.during(input.worktreeId, async () => {
      let cancelled = false;
      const cancelPreflight = () => {
        cancelled = true;
      };
      if (cycle !== undefined) this.pendingCycleLaunches.set(cycle.currentRunId, cancelPreflight);
      let reviewBranchContext: AgentRun['reviewBranchContext'];
      let reviewArtifacts: readonly string[] | undefined;
      try {
        if (ownsIntegrationResolution(cycle) && cycle?.integrationResolution)
          await this.branches?.validateResolutionLaunch(
            prepared.worktree,
            cycle.integrationResolution,
          );
        else if (input.role !== 'review' && !investigation)
          await this.branches?.validateLaunch(prepared.worktree);
        // A provider retry continues an interrupted review. A review that finished, and is
        // retried because the provider refused an approval review during it (R-C11), starts
        // afresh like any other review.
        const retriesFinishedReview =
          !!cycle?.providerRecovery &&
          prepared.parentRun?.id === cycle.providerRecovery.sourceRunId &&
          prepared.parentRun.status === 'finished';
        if (
          input.role === 'review' &&
          (resume !== undefined ||
            (cycle?.resultContinuations ?? 0) > 0 ||
            (!!cycle?.providerRecovery && !retriesFinishedReview))
        ) {
          const baseline = prepared.parentRun?.reviewBranchContext;
          const ended =
            prepared.parentRun &&
            this.storage.execution.runEvents.latestOfKind(
              workspaceId,
              prepared.parentRun.id,
              'run-finished',
            );
          // A resumed review continues on its pinned baseline, like a completion continuation.
          const continuable = reviewContinuable(
            resume !== undefined,
            prepared.parentRun,
            ended?.kind === 'run-finished' ? ended.payload : undefined,
            cycle?.providerRecovery,
          );
          if (!baseline || !continuable || !this.branches)
            throw new ExecutionRequestError(
              'conflict',
              'Review continuation requires the interrupted review and its pinned branch context.',
            );
          const snapshot = await this.branches.captureReviewContinuation(
            prepared.worktree,
            baseline,
          );
          reviewBranchContext = snapshot.context;
          reviewArtifacts = snapshot.artifacts;
        } else
          reviewBranchContext =
            input.role === 'review'
              ? await this.branches?.captureReview(prepared.worktree)
              : undefined;
        if (cancelled)
          throw new ExecutionRequestError(
            'conflict',
            'Cycle launch cancelled during Git preflight',
          );
        this.requireNoBackgroundWork(workspaceId, input.worktreeId);
        const launchUser = this.storage.users.findById(actor.userId);
        const launchAccess = this.storage.workspaces.findAuthorized(actor.userId, workspaceId);
        if (
          launchUser?.status !== 'active' ||
          !launchAccess ||
          !['owner', 'editor'].includes(launchAccess.membership.role)
        )
          throw new ExecutionRequestError(
            'conflict',
            'Run launch permission changed during preparation.',
          );
        if (investigation) requireNotRetired(this.storage, prepared.worktree);
        else requireTreeScope(this.storage, prepared.worktree, 'start');
        if (cycle !== undefined) this.requireCycleLaunchAuthority(cycle);
        else {
          this.requireManualControl(workspaceId, input.worktreeId);
          this.requireNoLiveRun(workspaceId, input.worktreeId);
        }
      } finally {
        if (
          cycle !== undefined &&
          this.pendingCycleLaunches.get(cycle.currentRunId) === cancelPreflight
        )
          this.pendingCycleLaunches.delete(cycle.currentRunId);
      }
      controlled?.check();
      // A drain can begin during Git preflight; no run record may start after it.
      if (this.draining) throw new DaemonDrainingError();
      const runId = cycle?.currentRunId ?? controlled?.runId ?? asAgentRunId(randomUUID());
      starting.workspaceId = workspaceId;
      starting.runId = runId;
      this.startingLaunches.add(starting);
      this.storageService?.requireSpace('runsRoot', prepared.worktree.path);
      const runDirectory = join(this.config.runsRoot, runId);
      const temporaryDirectory = join(runDirectory, 'scratch');
      mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      // Made with the scratch, before the run's record: a failure here fails the launch as a
      // scratch failure does, never leaves a run starting (LIVE-31 review).
      const processTemporaryDirectory = this.processTemporaryDirectory(runId);
      const buildCacheDirectory = this.worktreeBuildCache(prepared.worktree);
      // A read-only investigation runs no commands: no pinned build environment or checks.
      const pinned = investigation
        ? undefined
        : await this.runtimeEvidence?.prepare(
            prepared.worktree,
            runId,
            runDirectory,
            join(this.config.checkLogRoot, runId, 'replies'),
          );
      const historical =
        cycle?.baselinePreparation?.status === 'prepared'
          ? await this.baselines?.materialize(cycle, runDirectory)
          : undefined;
      const planDirectory = join(runDirectory, 'plan');
      mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
      const planDocuments = prepared.artifacts.map((artifact) => {
        const path = join(planDirectory, artifact.logicalFilename);
        writeFileSync(path, artifact.content, { mode: 0o600 });
        return { filename: artifact.logicalFilename, role: artifact.role, path };
      });
      if (preparation) {
        const directory = join(runDirectory, 'decision-preparation');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const documents = decisionPreparationDocuments(this.storage, preparation.value);
        for (const document of documents) {
          const path = join(directory, document.name);
          writeFileSync(path, document.content, { mode: 0o600 });
          planDocuments.push({
            filename: `decision-preparation/${document.name}`,
            role: 'supporting',
            path,
          });
        }
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
        for (const document of investigation.documents) {
          const path = join(directory, document.name);
          writeFileSync(path, document.content, { mode: 0o600 });
          planDocuments.push({
            filename: `investigation/${document.name}`,
            role: 'supporting',
            path,
          });
        }
      }
      if (cycle?.scopeRepair) {
        const path = join(planDirectory, 'craftingtable-scope-repair.json');
        writeFileSync(
          path,
          JSON.stringify(scopeRepairPacket(this.storage, cycle, { history: true }), null, 2),
          {
            mode: 0o600,
          },
        );
        planDocuments.push({
          filename: 'craftingtable-scope-repair.json',
          role: 'supporting',
          path,
        });
      }
      if (cycle?.designRecovery) {
        const recovery = cycle.designRecovery;
        if (cycle.step === 'design' && recovery.runId === cycle.currentRunId) {
          const current = this.storage.readTransaction((tx) =>
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
            content: readDesignRecoverySource(this.storage, cycle, source),
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
        for (const entry of entries) {
          const path = join(recoveryDirectory, entry.name);
          writeFileSync(path, entry.content, { mode: 0o600 });
          planDocuments.push({
            filename: `design-recovery/${entry.name}`,
            role: 'supporting',
            path,
          });
        }
      }
      if (prepared.worktree.planVersionId) {
        const inventoryPath = join(planDirectory, 'craftingtable-work-items.json');
        writeFileSync(
          inventoryPath,
          JSON.stringify(
            this.storage.planning.workItems.listForVersion(workspaceId, prepared.planVersionId),
            null,
            2,
          ),
          { mode: 0o600 },
        );
        planDocuments.push({
          filename: 'craftingtable-work-items.json',
          role: 'work-breakdown',
          path: inventoryPath,
        });
      }
      if (cycle?.finalizationProgress && cycle.finalizationId) {
        const staged = this.storage.execution.finalizations.find(workspaceId, cycle.finalizationId);
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
        planDocuments.push({
          filename: 'craftingtable-finalization-state.json',
          role: 'work-breakdown',
          path,
        });
      }
      const handoff =
        prepared.parentRun === undefined
          ? undefined
          : writeRunHandoff(
              this.storage.execution,
              prepared.parentRun,
              join(runDirectory, 'handoff'),
            );
      const parentAssessment =
        prepared.parentRun && latestReviewReport(this.storage.execution, prepared.parentRun);
      const parentTurn =
        prepared.parentRun &&
        this.storage.execution.runEvents.latestOfKind(
          workspaceId,
          prepared.parentRun.id,
          'turn-completed',
        );
      const parentContext = prepared.parentRun?.reviewBranchContext;
      const scope =
        prepared.worktree.executionScope && prepared.worktree.workItemId
          ? resolveScope(
              this.storage,
              workspaceId,
              prepared.worktree.workItemId,
              prepared.worktree.executionScope,
            )
          : undefined;
      if (scope) {
        const path = join(planDirectory, 'craftingtable-scope-evidence.json');
        writeFileSync(path, JSON.stringify(scopeEvidenceLedger(this.storage, scope), null, 2), {
          mode: 0o600,
        });
        planDocuments.push({
          filename: 'craftingtable-scope-evidence.json',
          role: 'work-breakdown',
          path,
        });
      }
      const policyPlan = worktreePlan(this.storage, prepared.worktree);
      if (policyPlan && this.branches) {
        const evidence = await this.branches.policyEvidence(workspaceId, policyPlan);
        if (
          evidence.policy &&
          (evidence.policy.repositoryId !== prepared.worktree.repositoryId ||
            (!prepared.worktree.planVersionId &&
              evidence.policy.integrationBranch !== prepared.worktree.integrationBranch))
        )
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
        writeFileSync(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
        planDocuments.push({
          filename: 'craftingtable-repository-policy.json',
          role: 'supporting',
          path,
        });
      }
      if (policyPlan) {
        const decisions = scope
          ? scopeEvidenceLedger(this.storage, scope).operatorDecisions
          : operatorDecisions(
              this.storage,
              workspaceId,
              prepared.worktree.workItemId
                ? [prepared.worktree.workItemId]
                : this.storage.planning.workItems
                    .listForVersion(workspaceId, policyPlan)
                    .map((w) => w.id),
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
        planDocuments.push({
          filename: 'craftingtable-operator-decisions.json',
          role: 'supporting',
          path,
        });
      }
      const composedBrief = composeBrief({
        repositoryPolicyGuidance: REPOSITORY_POLICY_GUIDANCE,
        ...(scope ? { executionScope: scopeBrief(scope) } : {}),
        ...(prepared.worktree.planVersionId &&
        input.role === 'review' &&
        !(cycle && ((cycle.resultContinuations ?? 0) > 0 || cycle.providerRecovery)) &&
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
        temporaryDirectory,
        ...(buildCacheDirectory ? { buildCacheDirectory } : {}),
        ...(pinned ? { launchers: true } : {}),
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
        recommendedDependencies: prepared.predecessors.filter(
          (entry) => entry.kind === 'recommended',
        ),
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
                ...(handoff === undefined ? {} : { handoff }),
              },
            }),
      });
      let brief =
        composedBrief +
        (pinned
          ? `

Pinned dependency environment: ${pinned.manifestPath}
${pinned.nativeVerification ? `Managed native verification is approved for this run (${pinned.nativeVerification.approvalId}). Execute applicable non-sensitive repository fixtures using ${pinned.binDirectory}/ct-native -- <executable> <arguments>. It provides a fresh HOME/TMPDIR and bounded user service (4 CPUs, 8 GiB, 512 tasks, at most 30 minutes). Retained receipts bind exact clean candidate, dependency manifest, environment approval and logs. Use supplied Cargo for dependency-bearing checks. ct-check/ct-act and inherited implementation results cannot substitute for native verification. Do not use live service credentials or claim Kata observations; report every scope requirement independently. This is cooperative native execution under the existing OS-user trust model, not a hostile-code sandbox.` : ''}
Verification policy: ${pinned.verification.mode}. ${pinned.verification.reason}
${upstreamSourcesBrief(pinned.dependencies)}
Use the controller Cargo launcher ${pinned.binDirectory}/cargo for Cargo checks (also supplied on PATH). Do not override supplied sources or use a neighboring checkout. CraftingTable runs its builds and tests, and ct-check/ct-act/ct-native, itself and relays the output; builds and checks run without network, so run cargo fetch first when dependencies must be downloaded. Builds and checks CraftingTable runs for you (the Cargo launcher's builds, ct-check, ct-act, ct-native) use a build directory CraftingTable chooses, and the launcher's other Cargo commands use the manifest's (the run’s scratch/target), whatever CARGO_TARGET_DIR says; that is expected, and receipts do not depend on it. Do not edit the manifest or override the build directory (--target-dir or CARGO_TARGET_DIR) for them.
The launcher also supports supplementary checks whose resolved graph contains no upstream packages, such as independent foundation/contract manifests within an integration run. Use the same launcher and ct-check normally; no explicit-config bypass or artificial upstream dependency is needed. Their supplementary-check receipts cannot satisfy the current-upstream build requirement. Earlier reports describing rejection of upstream-free checks refer to the previous launcher; verify with this run's supplied launcher and update stale instructions without waiving any checks.
${
  pinned.verification.mode === 'scoped-checks'
    ? `Use ${pinned.binDirectory}/ct-check -- <executable> <arguments> to retain repository-owned contract, inventory, fixture or domain test evidence. Use ${pinned.binDirectory}/ct-act -W .github/workflows/<file>.yml -j <job> for local GitHub Actions execution; CI is supplemental and does not count as the scoped check. ${pinned.checkDeclarationId ? 'The adopted checks below are required on the exact clean reviewed commit' : 'A successful ct-check or supplied Cargo check on the exact clean reviewed commit is required'}, together with independent evidence for EVERY scope obligation. Any prepared historical dependency commits are development inputs only. Do not port upstream code or align the workspace to current pins beyond the upstream links supplied as current pins above merely to satisfy this slice. Document known baseline failures separately; new scope checks must pass.`
    : `A successful Cargo build/test using current exact pins is required before merge/acceptance${pinned.checkDeclarationId ? ', with the adopted checks below' : ''}. Other ct-check and ct-act logs supplement but never replace that receipt. Align constraints only within the approved integration scope.`
}
${declaredChecksBrief(this.storage, workspaceId, input.role, pinned)}Local CI: ${pinned.localCi ? `configured with image ${pinned.localCi.image}. Workflows receive CRAFTINGTABLE_DEPENDENCY_MANIFEST, CRAFTINGTABLE_CARGO_CONFIG, CRAFTINGTABLE_VERIFICATION_MODE and CRAFTINGTABLE_CI_ARTIFACTS_DIR. Use the supplied Cargo config explicitly in CI scripts (cargo --config "$CRAFTINGTABLE_CARGO_CONFIG" ...); all supplied paths are mounted into the runner. The image includes Rust 1.89, rustfmt/clippy and native build tools. Repository workflows must select suitable checks for this scope; do not run the legacy whole-runtime workflow merely because it already exists.` : 'not configured; use ct-check and the supplied Cargo launcher for local checks.'} CI receipts do not establish external native/Kata qualification. Repository workflows and scripts remain repository-owned; selecting a narrow job never waives other scope obligations.
`
          : '');
      const historicalBrief = historical
        ? `

Controller-prepared historical baseline (characterization only):
Manifest: ${historical.manifestPath}
Historical workspace: ${historical.workspacePath}
Historical Cargo: ${historical.launcher}
Command receipts: ${historical.receiptPath}
Use this separate launcher ONLY to collect the historical baseline. It uses original lockfiles and historical sibling sources, not current upstream pins. For candidate checks, follow the scope verification policy above and use the normal controller Cargo launcher. Reuse recorded historical evidence with matching source identities; collect missing baseline build/test or recovery/benchmark evidence only when required by the plan, within this run's deadline. Record exact failures and missing prerequisites. Do not port historical code, change dependencies/lockfiles or fabricate results. Preserve summaries, measurements and non-Cargo logs under historical-evidence (outside disposable scratch). Do not ask the operator to provision ordinary worktrees or these already supplied sources. Historical results never satisfy current-runtime build gates. Genuine architectural/implementation decisions remain the operator's authority; collected facts do not authorize deviations.
`
        : '';
      brief += historicalBrief;
      writeFileSync(join(runDirectory, 'brief.md'), brief, { mode: 0o600 });

      // Nor after a drain that began while the evidence, baseline or policy was prepared.
      if (this.draining) throw new DaemonDrainingError();
      const createdAt = this.now().toISOString();
      const run = this.storage.transaction((tx) => {
        controlled?.check();
        // An investigation holds no development capacity (R-C16).
        if (investigation) requireNotRetired(tx, prepared.worktree);
        else requireTreeScope(tx, prepared.worktree, 'start');
        if (!investigation && prepared.worktree.executionScope && prepared.worktree.workItemId) {
          const scope = prepared.worktree.executionScope;
          reservePhase(
            tx,
            resolveScope(tx, workspaceId, prepared.worktree.workItemId, scope),
            prepared.worktree,
            scope.kind === 'slice'
              ? 'start'
              : scope.kind === 'slice-verification'
                ? 'verify'
                : 'accept',
            runId,
            createdAt,
          );
        }
        const inserted = tx.execution.runs.insert({
          id: runId,
          workspaceId,
          worktreeId: prepared.worktree.id,
          repositoryId: prepared.repository.id,
          projectId: prepared.worktree.projectId,
          ...(workItemId ? { workItemId } : { planVersionId: prepared.planVersionId }),
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          backend: backend.kind,
          role: input.role,
          permissionMode: input.permissionMode,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(profileSelection ? { profileSelection } : {}),
          brief,
          ...(reviewBranchContext === undefined ? {} : { reviewBranchContext }),
          createdAt,
          createdByUserId: actor.userId,
        });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt: createdAt,
          actorKind: actor.sessionId === undefined ? 'system' : 'user',
          actorUserId: actor.userId,
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          workspaceId,
          ...(requestId === undefined ? {} : { requestId }),
          action: 'agent-run.start',
          targetType: 'agent-run',
          targetId: runId,
          outcome: 'succeeded',
          metadata: {
            ...(workItemId ? { workItemId } : { planVersionId: prepared.planVersionId }),
            worktreeId: prepared.worktree.id,
            role: input.role,
            permissionMode: input.permissionMode,
            backend: backend.kind,
          },
        });
        tx.workspaceEvents.appendEvent({
          id: asEventId(randomUUID()),
          occurredAt: createdAt,
          workspaceId,
          actorUserId: actor.userId,
          projectId: prepared.worktree.projectId,
          workItemId,
          runId,
          kind: 'agent-run-started',
          payload: {
            runId,
            worktreeId: prepared.worktree.id,
            ...(workItemId ? { workItemId } : { planVersionId: prepared.planVersionId }),
            backend: backend.kind,
            role: input.role,
          },
        });
        if (
          pinned &&
          tx.runtimeEvidence.generations(
            workspaceId,
            pinned.definitionId,
            pinned.bindingRevision,
          )[0]?.id !== pinned.runtimeId
        )
          throw new ExecutionRequestError(
            'conflict',
            'Dependency generation changed during run preparation.',
          );
        if (pinned)
          this.runtimeEvidence?.assertPrepared(
            prepared.worktree,
            pinned.runtimeId,
            pinned.architectureDecisionDigest,
          );
        if (pinned)
          tx.runtimeEvidence.addRun({
            runId,
            workspaceId,
            runtimeId: pinned.runtimeId,
            nativeApprovalId: pinned.nativeApprovalId,
            architectureDecisionDigest: pinned.architectureDecisionDigest,
            manifestPath: pinned.manifestPath,
            manifestDigest: pinned.manifestDigest,
            ...(pinned.movedToCurrentPins
              ? { verificationMode: 'current-upstream-build' as const }
              : {}),
            ...(pinned.spoolDirectory && this.checks
              ? { receiptAuthority: 'daemon' as const }
              : {}),
            ...(pinned.checkDeclarationId ? { checkDeclarationId: pinned.checkDeclarationId } : {}),
          });
        return inserted;
      });
      this.notifier.notify();

      try {
        this.storageService?.registerRun(run.id, runDirectory);
      } catch (error) {
        this.finalize(workspaceId, runId, 'failed', { message: 'Could not register run storage.' });
        throw error;
      }
      // The protected branches as the run starts (R-G5).
      if (this.refWatch) {
        const repository = this.storage.execution.sourceRepositories.find(
          workspaceId,
          prepared.worktree.repositoryId,
        );
        if (repository)
          await this.refWatch.watch.snapshot(runId, this.refWatch.git, repository.rootPath);
      }
      // The daemon runs and records this run's checks from here on (R-G4).
      if (pinned?.spoolDirectory && this.checks)
        this.checks.open({
          workspaceId,
          runId,
          spoolDirectory: pinned.spoolDirectory,
          replyDirectory: pinned.replyDirectory,
          runDirectory,
          manifestPath: pinned.manifestPath,
          manifestDigest: pinned.manifestDigest,
          manifest: pinned.manifest,
        });
      /** Launches the agent, with the report of the adopted checks run for it, if any. */
      const proceed = async (declared: string): Promise<AgentRun> => {
        const previousRunDirectory = resume && join(this.config.runsRoot, resume.run.id);
        const prompt =
          (resume && cycle && previousRunDirectory
            ? resume.kind === 'output-repair' && cycle.outputRepair
              ? outputRepairPrompt({
                  issues: cycle.outputRepair.issues,
                  attempt: cycle.outputRepair.attempts,
                  limit: OUTPUT_REPAIR_LIMIT,
                  deadlineAt: cycle.runDeadlineAt,
                  previousRunDirectory,
                  runDirectory,
                })
              : restartResumePrompt({
                  deadlineAt: cycle.runDeadlineAt,
                  previousRunDirectory,
                  runDirectory,
                  ...(cycle.stepGuidance ? { stepGuidance: cycle.stepGuidance } : {}),
                })
            : brief) + declared;
        const launch: AgentLaunchRequest = {
          ...(pinned
            ? { buildEnvironment: { binDirectory: pinned.binDirectory, namespace: runId } }
            : {}),
          cwd: prepared.worktree.path,
          temporaryDirectory,
          processTemporaryDirectory,
          ...(buildCacheDirectory ? { buildCacheDirectory } : {}),
          // The run's own variables (R-G5, AGT-04): its scratch space, the worktree's build cache
          // (R-G7) and, with a pinned environment, its launchers ahead of PATH. The adapter adds
          // them to named variables only.
          environment: {
            TMPDIR: temporaryDirectory,
            TMP: temporaryDirectory,
            TEMP: temporaryDirectory,
            CARGO_TARGET_DIR: buildCacheDirectory ?? join(temporaryDirectory, 'target'),
            // The daemon's Cargo home, which the check units build from, never the operator's:
            // a sandboxed `cargo fetch` may write its registry and Git caches, and what an agent
            // plants there stays out of the operator's own builds (R-G5 review).
            CARGO_HOME: this.config.cargoHome,
            ...(pinned ? { CRAFTINGTABLE_RUN_NAMESPACE: runId } : {}),
          },
          ...(pinned ? { pathPrefix: [pinned.binDirectory] } : {}),
          ...(cycle
            ? { deadlineAt: cycle.runDeadlineAt }
            : controlled
              ? { deadlineAt: controlled.deadlineAt, readOnly: true }
              : {}),
          prompt,
          ...(resume ? { resumeSessionId: resume.sessionId } : {}),
          permissionMode: input.permissionMode,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          additionalDirectories: [
            runDirectory,
            ...(previousRunDirectory ? [previousRunDirectory] : []),
            ...(historical ? [historical.cargoHome] : []),
            ...(pinned?.localCi ? [pinned.localCi.cacheRoot] : []),
            // The shared Cargo target (R-G7) sits outside the worktree, so a sandbox must allow it.
            ...(buildCacheDirectory ? [buildCacheDirectory] : []),
          ],
          sessionName: `CraftingTable ${prepared.row.sourceId} ${input.role}`,
        };
        let session: AgentSession;
        try {
          session = cycle
            ? await this.launchCycleSession(backend, launch, cycle)
            : controlled
              ? await this.launchCycleSession(backend, launch, {
                  currentRunId: controlled.runId,
                  runDeadlineAt: controlled.deadlineAt,
                })
              : await this.checkedLaunch(backend, launch, () => false);
          try {
            controlled?.check();
          } catch (e) {
            session.kill();
            throw e;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Agent could not be started';
          if (error instanceof CycleLaunchCancelledError && this.draining)
            this.finalize(workspaceId, runId, 'interrupted', {
              reason: 'daemon-drain',
              message: DRAIN_INTERRUPTED_MESSAGE,
            });
          else
            this.finalize(
              workspaceId,
              runId,
              error instanceof CycleLaunchCancelledError ? 'cancelled' : 'failed',
              {
                message,
                // The host lacks the agent's tools; the cycle stops saying so (LIVE-31).
                ...(error instanceof AgentLaunchError && error.reason === 'environment-unavailable'
                  ? { reason: 'agent-environment-unavailable' as const }
                  : error instanceof AgentLaunchError && error.reason === 'model-misnamed'
                    ? { reason: 'agent-model-misnamed' as const }
                    : {}),
              },
            );
          return this.storage.execution.runs.find(workspaceId, runId) ?? run;
        }

        // A restart began ending sessions while this one was launching: it is the drain's too, so
        // the restart resumes it (R-G13 increment 3 verification).
        if (this.interrupting) {
          session.kill();
          this.finalize(workspaceId, runId, 'interrupted', {
            reason: 'daemon-drain',
            message: DRAIN_INTERRUPTED_MESSAGE,
          });
          return this.storage.execution.runs.find(workspaceId, runId) ?? run;
        }
        this.appendEvent(workspaceId, runId, {
          kind: 'user-message',
          payload: {
            text: prompt,
            ...(handoff === undefined ? {} : { handoffSources: handoff.sources }),
          },
        });
        const started = this.transition(workspaceId, runId, LIVE_STATUSES, 'running', {
          startedAt: this.now().toISOString(),
        });
        if (started === undefined) {
          // The run was ended while it launched (an investigation's End, R-C16 review H1): its
          // session never runs. The worktree is held until its process has exited, and the
          // launch returns only then, so nothing compares or launches beside it.
          session.kill();
          await this.mutations.untilExited(
            input.worktreeId,
            drainUntilExit(session.items[Symbol.asyncIterator]()),
          );
          return this.storage.execution.runs.find(workspaceId, runId) ?? run;
        }

        const liveRun: LiveRun = {
          workspaceId,
          runId,
          session,
          cancelRequested: false,
          done: Promise.resolve(),
        };
        this.live.set(runId, liveRun);
        if (controlled) {
          const timer = setTimeout(
            () => {
              liveRun.cancelRequested = true;
              session.kill();
              // The run ends now, but its process may still be writing: the worktree is held
              // until it exits, so an investigation is compared only then (R-C16 review M1).
              void this.mutations.untilExited(input.worktreeId, liveRun.done);
              this.finalize(workspaceId, runId, 'failed', { message: controlled.limit });
            },
            Math.max(1, Date.parse(controlled.deadlineAt) - this.now().getTime()),
          );
          this.preparationTimers.set(runId, timer);
        }
        if (cycle !== undefined) {
          const latest = this.storage.execution.cycles.find(workspaceId, cycle.id);
          if (latest?.status === 'stopped' || latest?.currentRunId !== runId) {
            liveRun.cancelRequested = true;
            session.kill();
          }
        }
        liveRun.done = this.supervise(liveRun, input.worktreeId);
        return this.storage.execution.runs.find(workspaceId, runId) ?? run;
      };
      const declaredIds =
        input.role === 'review' && pinned?.spoolDirectory && pinned.checkDeclarationId
          ? ((
              JSON.parse(pinned.manifest) as {
                declaredChecks?: { checks: readonly { id: string }[] };
              }
            ).declaredChecks?.checks.map((check) => check.id) ?? [])
          : [];
      const checks = this.checks;
      if (!declaredIds.length || !checks) return proceed('');
      // A review's adopted checks run before the reviewer starts, so its gate never waits on the
      // reviewer running them, and the reviewer reads their results (R-G13 increment 3, LIVE-23).
      // They run in the background: the controller's pass and the request that started the run
      // do not wait for them. A drain waits for them or cancels them, as for any launch.
      const cancel = () => void checks.close(runId);
      const continuation = (async () => {
        const results = await checks.runDeclared(runId, declaredIds);
        const current = this.storage.execution.runs.find(workspaceId, runId);
        if (!current || isTerminalAgentRunStatus(current.status)) return;
        // Drained, stopped or replaced while the checks ran: start no agent.
        if (this.draining)
          return this.finalize(workspaceId, runId, 'interrupted', {
            reason: 'daemon-drain',
            message: DRAIN_INTERRUPTED_MESSAGE,
          });
        // The checks can take long: the launch's authority is checked again before the agent
        // starts, as the preflight checked it (R-G13 increment 3 review).
        const refused = this.launchRefusal(
          workspaceId,
          runId,
          input.worktreeId,
          actor.userId,
          cycle,
        );
        if (refused) return this.finalize(workspaceId, runId, 'cancelled', { message: refused });
        await proceed(declaredCheckReport(results, runDirectory));
      })()
        .catch((error) => {
          try {
            const current = this.storage.execution.runs.find(workspaceId, runId);
            if (current && !isTerminalAgentRunStatus(current.status))
              this.finalize(workspaceId, runId, 'failed', {
                message: error instanceof Error ? error.message : 'The review could not start.',
              });
          } catch {
            /* storage closed with the daemon: the restart recovers the run */
          }
        })
        .finally(() => this.checkingLaunches.delete(runId));
      this.checkingLaunches.set(runId, { workspaceId, runId, cancel, done: continuation });
      this.mutations.hold(input.worktreeId, continuation);
      return this.storage.execution.runs.find(workspaceId, runId) ?? run;
    });
    starting.done = launch;
    return launch.finally(() => this.startingLaunches.delete(starting));
  }

  private async launchCycleSession(
    backend: AgentBackend,
    request: AgentLaunchRequest,
    cycle: Pick<WorkCycle, 'currentRunId' | 'runDeadlineAt'>,
  ): Promise<AgentSession> {
    let cancelled = false;
    let cancel: () => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        cancelled = true;
        reject(new CycleLaunchCancelledError('Cycle launch cancelled or step time limit reached'));
      };
    });
    this.pendingCycleLaunches.set(cycle.currentRunId, cancel);
    const timeout = setTimeout(
      cancel,
      Math.max(1, Date.parse(cycle.runDeadlineAt) - this.now().getTime()),
    );
    // A late backend result must be terminated without touching storage after shutdown.
    const launching = Promise.resolve().then(async () => {
      if (cancelled) throw new CycleLaunchCancelledError('Cycle launch cancelled');
      const session = await this.checkedLaunch(backend, request, () => cancelled);
      if (cancelled) {
        session.kill();
        throw new CycleLaunchCancelledError('Cycle launch cancelled');
      }
      return session;
    });
    try {
      return await Promise.race([launching, cancellation]);
    } finally {
      clearTimeout(timeout);
      this.pendingCycleLaunches.delete(cycle.currentRunId);
    }
  }

  /**
   * A display name, or another spelling of a catalog id, never reaches the CLI (R-G15, LIVE-34):
   * the launch fails before anything starts, and a cycle stops saying which id. Right after a
   * start it first waits for the backend's first catalog look; a launch cancelled meanwhile, or
   * one a drain or restart overtook, starts nothing (R-G15 re-check).
   */
  private async checkedLaunch(
    backend: AgentBackend,
    request: AgentLaunchRequest,
    cancelled: () => boolean,
  ): Promise<AgentSession> {
    if (request.model !== undefined) await firstCatalogLook(backend);
    if (cancelled() || this.draining || this.interrupting)
      throw new CycleLaunchCancelledError('Launch cancelled while the model catalog was read');
    refuseMisnamedModel(backend, request.model);
    return backend.launch(request);
  }

  sendMessage(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    text: string,
    requestId?: string,
  ): RunCommandResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const run = this.requireRun(workspaceId, runId);
    // An investigation answers in its one turn; a message would change the report the daemon
    // reads back (R-C16 review).
    if (run.profileSelection?.investigationId)
      throw new ExecutionRequestError(
        'conflict',
        'An investigation takes no messages. End it, or start another with a new prompt.',
      );
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const tree = this.storage.execution.worktrees.find(workspaceId, run.worktreeId);
    if (!tree) throw new NotFoundError();
    requireTreeScope(this.storage, tree, 'start');
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun === undefined || !liveRun.session.send(text)) {
      return { run, accepted: false };
    }
    this.appendEvent(workspaceId, runId, { kind: 'user-message', payload: { text } });
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action: 'agent-run.message',
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'succeeded',
        metadata: { byteLength: Buffer.byteLength(text, 'utf8') },
      });
    });
    const updated = this.transition(workspaceId, runId, ['waiting', 'running'], 'running', {});
    return { run: updated ?? this.requireRun(workspaceId, runId), accepted: true };
  }

  end(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    requestId?: string,
  ): RunCommandResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const run = this.requireRun(workspaceId, runId);
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun === undefined) {
      return { run, accepted: false };
    }
    liveRun.session.end();
    this.recordCommand(context, workspaceId, runId, 'agent-run.end', requestId);
    return { run, accepted: true };
  }

  cancel(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    requestId?: string,
  ): RunCommandResult {
    this.workspaceService.requireRole(context, workspaceId, ['owner', 'editor'], {
      ...(requestId === undefined ? {} : { requestId }),
    });
    const run = this.requireRun(workspaceId, runId);
    this.requireManualControl(workspaceId, run.worktreeId, runId);
    const liveRun = this.liveRun(workspaceId, runId);
    if (liveRun !== undefined) {
      liveRun.cancelRequested = true;
      liveRun.session.kill();
      this.recordCommand(context, workspaceId, runId, 'agent-run.cancel', requestId);
      return { run, accepted: true };
    }
    if (isTerminalAgentRunStatus(run.status)) {
      return { run, accepted: false };
    }
    // Non-terminal but not live: the process is gone, so close the record.
    this.recordCommand(context, workspaceId, runId, 'agent-run.cancel', requestId);
    this.finalize(workspaceId, runId, 'cancelled', { message: 'Cancelled by operator' });
    return { run: this.requireRun(workspaceId, runId), accepted: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                 */
  /* ---------------------------------------------------------------------- */

  detail(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    requestId?: string,
  ): {
    readonly run: AgentRun;
    readonly worktree: Worktree;
    readonly eventCount: number;
    readonly completionIssue?: { reason: AgentExitReason; message: string };
    readonly latestOutcome?: {
      providerFailure?: import('@craftingtable/domain').ProviderFailure;
      sequence: number;
      occurredAt: string;
      text: string;
      outcome: 'success' | 'error';
      truncated: boolean;
    };
    readonly reviewReport?: ReviewReportAssessment;
  } {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    return this.storage.readTransaction((tx) => {
      const run = tx.execution.runs.find(workspaceId, runId);
      if (run === undefined) {
        throw new NotFoundError();
      }
      const worktree = tx.execution.worktrees.find(workspaceId, run.worktreeId);
      if (worktree === undefined) {
        throw new NotFoundError();
      }
      const reviewReport = latestReviewReport(tx.execution, run);
      const lastTurn = tx.execution.runEvents.latestOfKind(workspaceId, runId, 'turn-completed');
      const ended = tx.execution.runEvents.latestOfKind(workspaceId, runId, 'run-finished');
      return {
        ...(ended?.kind === 'run-finished' && ended.payload.reason
          ? {
              completionIssue: {
                reason: ended.payload.reason,
                message: ended.payload.message ?? 'Run ended before reporting completion.',
              },
            }
          : {}),
        ...(lastTurn?.kind === 'turn-completed'
          ? {
              latestOutcome: {
                ...(lastTurn.payload.providerFailure
                  ? { providerFailure: lastTurn.payload.providerFailure }
                  : {}),
                sequence: lastTurn.sequence,
                occurredAt: lastTurn.occurredAt,
                text: lastTurn.payload.resultText,
                outcome: lastTurn.payload.outcome,
                truncated: lastTurn.payload.truncated ?? false,
              },
            }
          : {}),
        run,
        worktree,
        eventCount: tx.execution.runEvents.countForRun(workspaceId, runId),
        ...(reviewReport === undefined ? {} : { reviewReport }),
      };
    });
  }

  listEvents(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    after: number,
    limit: number,
    requestId?: string,
  ): readonly AgentRunEvent[] {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    this.requireRun(workspaceId, runId);
    return this.storage.execution.runEvents.listAfter({ workspaceId, runId, after, limit });
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * A short private directory for the agent process itself, its TMPDIR (LIVE-31): Claude Code's
   * command sandbox makes Unix sockets there, and a socket path holds at most 107 bytes, which
   * the run's scratch path leaves no room for. The run's scratch stays the commands' and
   * builds' place. Removed when the run ends.
   */
  private processTemporaryDirectory(runId: AgentRunId): string {
    // A launch of the same run that failed before its record left one: it goes now.
    this.removeProcessTemporaryDirectory(runId);
    const root = this.config.agentTemporaryRoot;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (;;) {
      const directory = join(root, randomBytes(RUN_TEMPORARY_NAME_BYTES).toString('hex'));
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      this.processTemporaryDirectories.set(runId, directory);
      return directory;
    }
  }

  private removeProcessTemporaryDirectory(runId: string): void {
    const directory = this.processTemporaryDirectories.get(runId);
    if (directory === undefined) return;
    this.processTemporaryDirectories.delete(runId);
    this.removeAgentDirectory(directory, { runId });
  }

  /**
   * Removes an agent's directory in the background, as a run's scratch is, never following
   * what the agent left (LIVE-31 verification). `quiesce` waits for it; a failure is logged.
   */
  private removeAgentDirectory(directory: string, context: Record<string, string> = {}): void {
    const removing: Promise<void> = removeAgentTree(directory)
      .then((failure) => {
        if (failure)
          this.log.warn("An agent's temporary directory could not be removed", {
            ...context,
            directory,
            error: failure,
          });
      })
      // Nothing here may become an unhandled rejection, not even a failing log.
      .catch(() => undefined)
      .finally(() => this.cleanups.delete(removing));
    this.cleanups.add(removing);
  }

  /** Marks runs that were live when the daemon last stopped; their processes are gone. */
  recoverInterrupted(): number {
    // Their agents' temporary directories went with them (LIVE-31). One that cannot be removed
    // is logged; it never keeps the daemon from starting (LIVE-31 review).
    const root = this.config.agentTemporaryRoot;
    let leftovers: string[] = [];
    try {
      leftovers = readdirSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.log.warn("Agents' temporary directories could not be listed", {
          error: String(error),
        });
    }
    // Only what a run made goes: a directory, not a link, named as `processTemporaryDirectory`
    // names one. Anything else stays, so a root set where other files live loses none of them
    // (TS-H3); it is named once.
    const left: string[] = [];
    for (const name of leftovers) {
      if (isRunTemporaryDirectory(root, name)) this.removeAgentDirectory(join(root, name));
      // The root's lock sockets (R-G5), a daemon's own; never a file or directory so named.
      else if (!isRootLockSocket(root, name)) left.push(name);
    }
    if (left.length > 0)
      this.log.warn(
        "Entries in the agents' temporary root that are not run directories were left in place",
        { root, count: left.length, entries: left.sort().slice(0, LEFT_ENTRIES_NAMED) },
      );
    this.storage.transaction((tx) =>
      tx.phaseScheduling.releaseOperations(this.now().toISOString()),
    );
    const stale = this.storage.execution.runs.listLive();
    for (const run of stale) {
      this.finalize(run.workspaceId, run.id, 'interrupted', {
        message: 'The daemon restarted while this run was live',
      });
    }
    return stale.length;
  }

  /** Stops admitting new runs for a restart drain (R-B9); live runs continue. */
  beginDrain(): void {
    this.draining = true;
  }

  /** The daemon is stopping on a signal; see `serviceStopping`. */
  noteServiceStop(): void {
    this.serviceStopping = true;
  }

  /** Lifts a drain that was cancelled before anything was interrupted. */
  cancelDrain(): void {
    this.draining = false;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Resolves once every item a session has already produced is journaled: no launch (a review's
   * adopted checks included) or post-run cleanup is in flight and each live consumer waits on its session. It counts event-loop turns, not
   * wall-clock time, so tests stepping the controller stay deterministic (R-B2).
   */
  async quiesce(maxTurns = 1000): Promise<void> {
    for (let turn = 0; turn < maxTurns; turn++) {
      await Promise.allSettled([...this.cleanups]);
      await Promise.allSettled([...this.checkingLaunches.values()].map((c) => c.done));
      await new Promise((resolve) => setImmediate(resolve));
      if (
        this.pendingCycleLaunches.size === 0 &&
        this.cleanups.size === 0 &&
        [...this.live.values()].every((liveRun) => liveRun.awaitingItem === true)
      )
        return;
    }
    throw new Error('Agent runs did not become quiet');
  }

  /**
   * Live work a drain waits for: launches in preflight or preparing, reviews still running their
   * adopted checks, turns in progress, and sessions still holding background work. A session waiting between turns is at a boundary.
   */
  busyRunCount(): number {
    let busy =
      this.pendingCycleLaunches.size + this.checkingLaunches.size + this.startingLaunches.size;
    for (const liveRun of this.live.values()) {
      const run = this.storage.execution.runs.find(liveRun.workspaceId, liveRun.runId);
      if (run?.status !== 'waiting' || liveRun.session.backgroundWorkPending) busy++;
    }
    return busy;
  }

  /**
   * Ends every live session for a restart and returns how many were interrupted. A
   * controller step waiting between turns has finished its work and ends normally, so
   * the controller classifies its result after the restart; everything else is
   * terminated and recorded as `interrupted` with reason `daemon-drain`.
   */
  async interruptForRestart(): Promise<number> {
    this.draining = true;
    this.interrupting = true;
    for (const cancel of this.pendingCycleLaunches.values()) cancel();
    const checking = [...this.checkingLaunches.values()];
    for (const launch of checking) launch.cancel();
    const starting = [...this.startingLaunches];
    const liveAtStart = new Set(this.live.keys());
    const pending = [...this.live.values(), ...this.orphaned];
    let interrupted = 0;
    for (const liveRun of this.live.values()) {
      const run = this.storage.execution.runs.find(liveRun.workspaceId, liveRun.runId);
      const cycleTurnDone =
        run?.status === 'waiting' &&
        !liveRun.session.backgroundWorkPending &&
        this.storage.execution.cycles.activeForWorktree(run.workspaceId, run.worktreeId)
          ?.currentRunId === run.id;
      if (cycleTurnDone) {
        liveRun.session.end();
        continue;
      }
      liveRun.drainInterrupted = true;
      liveRun.session.kill();
      interrupted++;
    }
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      timer.unref();
    });
    await Promise.race([
      Promise.allSettled([
        ...pending.map((liveRun) => liveRun.done),
        // A review stopped in its checks records its interruption before storage closes.
        ...checking.map((launch) => launch.done),
        // A launch past its drain check reaches its checks (stopped at once) or its session
        // (ended at once).
        ...starting.map((launch) => launch.done),
      ]),
      timeout,
    ]);
    // Every launch the drain found (none can begin a run after it). A review whose checks
    // outlast the grace (a slow clone ignores the abort), or a launch whose session has not
    // come, is recorded as the drain's now, before storage closes; it then starts nothing.
    const launches = new Map<string, { workspaceId: WorkspaceId; runId: AgentRunId }>();
    for (const launch of checking) launches.set(launch.runId, launch);
    for (const { workspaceId, runId } of starting)
      if (workspaceId && runId) launches.set(runId, { workspaceId, runId });
    const status = (launch: { workspaceId: WorkspaceId; runId: AgentRunId }) =>
      this.storage.execution.runs.find(launch.workspaceId, launch.runId)?.status;
    for (const launch of launches.values()) {
      const current = status(launch);
      if (current && !isTerminalAgentRunStatus(current) && !this.live.has(launch.runId))
        this.finalize(launch.workspaceId, launch.runId, 'interrupted', {
          reason: 'daemon-drain',
          message: DRAIN_INTERRUPTED_MESSAGE,
        });
    }
    // Only the launches the drain itself stopped, each once: a session already counted above,
    // or a review whose checks failed or that something else ended, is not.
    return (
      interrupted +
      [...launches.values()].filter(
        (launch) => !liveAtStart.has(launch.runId) && status(launch) === 'interrupted',
      ).length
    );
  }

  async shutdown(): Promise<void> {
    await this.interruptForRestart();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private liveRun(workspaceId: WorkspaceId, runId: AgentRunId): LiveRun | undefined {
    const liveRun = this.live.get(runId);
    return liveRun !== undefined && liveRun.workspaceId === workspaceId ? liveRun : undefined;
  }

  private requireRun(workspaceId: WorkspaceId, runId: AgentRunId): AgentRun {
    const run = this.storage.execution.runs.find(workspaceId, runId);
    if (run === undefined) {
      throw new NotFoundError();
    }
    return run;
  }

  /**
   * Consumes the session. If supervision itself fails (a storage write, a
   * report assessment), the agent must not keep working unobserved: its process
   * group is killed, the run is closed as failed, and the worktree stays
   * reserved until the session reports its exit (AGT-01).
   */
  private async supervise(liveRun: LiveRun, worktreeId: WorktreeId): Promise<void> {
    const items = liveRun.session.items[Symbol.asyncIterator]();
    try {
      await this.consume(liveRun, items);
    } catch (error) {
      const { workspaceId, runId } = liveRun;
      this.log.warn('agent run consumer failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      liveRun.cancelRequested = true;
      liveRun.session.kill();
      this.orphaned.add(liveRun);
      const reserved = this.mutations.untilExited(worktreeId, drainUntilExit(items));
      try {
        this.finalize(workspaceId, runId, 'failed', { message: 'Run supervision failed' });
      } catch (finalizeError) {
        this.log.warn('agent run finalization failed', {
          runId,
          error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
        });
      }
      await reserved;
      this.orphaned.delete(liveRun);
      this.notifier.notify();
    }
  }

  /**
   * Iterates by hand rather than with `for await`: an exception in the loop body
   * must not close the backend's stream, because `supervise` keeps reading it to
   * learn when the killed process has exited.
   */
  private async consume(liveRun: LiveRun, items: AsyncIterator<AgentSessionItem>): Promise<void> {
    const { workspaceId, runId } = liveRun;
    const read = async () => {
      liveRun.awaitingItem = true;
      try {
        return await items.next();
      } finally {
        liveRun.awaitingItem = false;
      }
    };
    for (let next = await read(); next.done !== true; next = await read()) {
      const item = next.value;
      if (item.type === 'exited') {
        const lastTurn = this.storage.execution.runEvents.latestOfKind(
          workspaceId,
          runId,
          'turn-completed',
        );
        const serviceFailed =
          lastTurn?.kind === 'turn-completed' &&
          lastTurn.payload.outcome === 'error' &&
          !!lastTurn.payload.providerFailure;
        // While the daemon is stopping on a signal, a signal the daemon did not send is the
        // service manager stopping the unit's whole process group: that is a restart, not a
        // failure. During a deploy's drain nothing else is stopping, so a signal-killed
        // agent (OOM, crash) is a failure and keeps the explicit resume.
        const drained =
          liveRun.drainInterrupted === true ||
          (this.serviceStopping && !liveRun.cancelRequested && item.signal !== null);
        const status: AgentRunStatus = drained
          ? 'interrupted'
          : liveRun.cancelRequested
            ? 'cancelled'
            : item.exitCode === 0 && !item.reason && !serviceFailed
              ? 'finished'
              : 'failed';
        this.finalize(workspaceId, runId, status, {
          ...(item.exitCode === null ? {} : { exitCode: item.exitCode }),
          ...(item.signal === null ? {} : { signal: item.signal }),
          ...(drained
            ? { reason: 'daemon-drain' as const, message: DRAIN_INTERRUPTED_MESSAGE }
            : item.reason
              ? {
                  reason: item.reason,
                  message:
                    item.reason === 'background-work-incomplete'
                      ? 'The agent exited before collecting background work and reporting completion. Its process group has finished; the last message is an incomplete outcome.'
                      : 'Background work exceeded the step time limit and was terminated. Inspect partial verification results before resuming.',
                }
              : status === 'cancelled' && liveRun.cancelMessage
                ? { message: liveRun.cancelMessage }
                : {}),
        });
        return;
      }
      let event = item.event;
      if (event.kind === 'turn-completed') {
        const run = this.storage.execution.runs.find(workspaceId, runId);
        if (run?.role === 'review') {
          const repairCycle = this.storage.execution.cycles.activeForWorktree(
            run.workspaceId,
            run.worktreeId,
          );
          const repairIds = repairCycle?.scopeRepair
            ? scopeRepairPacket(this.storage, repairCycle).sources.flatMap((s) =>
                s.findings.map((f) => f.id),
              )
            : [];
          let reviewReport =
            event.payload.outcome === 'error'
              ? {
                  status: 'invalid' as const,
                  fault: 'content' as const,
                  issues: ['The review turn failed; request a successful consolidated report.'],
                }
              : assessReviewReport(
                  event.payload.resultText,
                  event.payload.truncated,
                  new Set([...requiredFindingIds(this.storage.execution, run), ...repairIds]),
                );
          const stagedCycle = this.storage.execution.cycles.activeForWorktree(
            run.workspaceId,
            run.worktreeId,
          );
          const staged = stagedCycle?.finalizationId
            ? this.storage.execution.finalizations.find(run.workspaceId, stagedCycle.finalizationId)
            : undefined;
          if (staged?.stages && stagedCycle?.currentRunId === run.id)
            reviewReport = assessStageReport(
              staged,
              stagedCycle,
              reviewReport,
              run.reviewBranchContext,
            );
          event = { ...event, payload: { ...event.payload, reviewReport } };
        }
      }
      this.appendEvent(workspaceId, runId, event);
      switch (event.kind) {
        case 'session-started':
          this.transition(workspaceId, runId, ['starting', 'running', 'waiting'], 'running', {
            backendSessionId: event.payload.backendSessionId,
            resolvedModel: event.payload.model,
            billing: event.payload.billing,
          });
          break;
        case 'assistant-message':
        case 'tool-call':
          // A message queued during the preceding turn can start after its result
          // moved the run to waiting. Activity belongs to the new turn.
          this.transition(workspaceId, runId, ['waiting'], 'running', {});
          break;
        case 'turn-completed': {
          const run = this.storage.execution.runs.find(workspaceId, runId);
          const verdict =
            run?.role === 'review' &&
            event.payload.outcome === 'success' &&
            event.payload.reviewReport?.status !== 'invalid'
              ? finalVerdict(event.payload.resultText)
              : undefined;
          this.transition(workspaceId, runId, ['starting', 'running', 'waiting'], 'waiting', {
            turnCountIncrement: 1,
            ...(event.payload.model === undefined ? {} : { resolvedModel: event.payload.model }),
            outcomeSummary: summarise(event.payload.resultText),
            ...(event.payload.costUsd === undefined ? {} : { costUsd: event.payload.costUsd }),
            ...(run?.role === 'review' ? { verdict: verdict ?? null } : {}),
          });
          if (this.preparationTimers.has(runId)) liveRun.session.end();
          break;
        }
        default:
          break;
      }
    }
  }

  private appendEvent(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    event: NormalizedAgentEvent,
  ): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId,
        runId,
        occurredAt,
        kind: event.kind,
        payload:
          event.kind === 'tool-result'
            ? this.journalToolResult(tx, runId, event.payload)
            : event.payload,
        ...(event.raw === undefined ? {} : { raw: event.raw }),
      } as Parameters<typeof tx.execution.runEvents.append>[0]);
    });
    this.notifier.notify(
      ['session-started', 'turn-completed', 'run-finished'].includes(event.kind)
        ? 'workflow'
        : 'activity',
    );
  }

  /**
   * A large tool result keeps only a preview in the journal; its body goes to the run's
   * directory (R-H2). Without a registered directory, or when the write fails, the whole
   * output is journaled as before.
   */
  private journalToolResult(
    tx: StorageRepositories,
    runId: AgentRunId,
    payload: AgentRunEventPayload<'tool-result'>,
  ): AgentRunEventPayload<'tool-result'> {
    const directory = tx.maintenance.directory(runId)?.path;
    if (directory === undefined) return payload;
    try {
      return offloadToolResult(payload, directory);
    } catch {
      return payload;
    }
  }

  /**
   * The worktree's shared Cargo target directory (R-G7), registered at the worktree's first
   * launch and reused by every later step, so each step builds incrementally instead of from
   * cold. Cargo creates the directory on its first build, so a worktree that never builds
   * Rust leaves nothing behind. Storage cleanup removes it once the worktree is merged or
   * removed and nothing runs in it (ADR-039). Without a usable location the run builds in
   * its own scratch, as before.
   */
  private worktreeBuildCache(worktree: Worktree): string | undefined {
    try {
      const recorded = this.storage.maintenance.worktreeCache(worktree.id);
      if (recorded) {
        const usable =
          !existsSync(recorded.path) ||
          (lstatSync(recorded.path).isDirectory() &&
            statSync(recorded.path).dev === recorded.device);
        return usable ? recorded.path : undefined;
      }
      const parent = join(this.config.runsRoot, WORKTREE_CACHES_DIRECTORY);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const root = realpathSync(parent);
      const path = join(root, worktree.id);
      this.storage.maintenance.registerWorktreeCache({
        worktreeId: worktree.id,
        workspaceId: worktree.workspaceId,
        path,
        device: statSync(root).dev,
        createdAt: this.now().toISOString(),
      });
      return path;
    } catch {
      return undefined;
    }
  }

  /** The full output of a tool result whose body left the journal (R-H2). */
  toolResult(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    digest: string,
    requestId?: string,
  ): string {
    this.workspaceService.requireAuthorized(context, workspaceId, requestId);
    const run = this.storage.execution.runs.find(workspaceId, runId);
    const directory = run && this.storage.maintenance.directory(run.id)?.path;
    const body = directory === undefined ? undefined : readToolResult(directory, digest);
    if (body === undefined) throw new NotFoundError();
    return body;
  }

  /**
   * Guarded status transition. Emits a workspace event only when the status
   * actually changed, so per-event bookkeeping (session id, cost) stays out of
   * the workspace journal.
   */
  private transition(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    expectedStatuses: readonly AgentRunStatus[],
    toStatus: AgentRunStatus,
    fields: {
      readonly backendSessionId?: string;
      readonly resolvedModel?: string;
      readonly billing?: AgentBillingSource;
      readonly verdict?: AgentRunVerdict | null;
      readonly startedAt?: string;
      readonly exitCode?: number;
      readonly outcomeSummary?: string;
      readonly costUsd?: number;
      readonly turnCountIncrement?: number;
    },
  ): AgentRun | undefined {
    const occurredAt = this.now().toISOString();
    const result = this.storage.transaction((tx) => {
      const before = tx.execution.runs.find(workspaceId, runId);
      if (before === undefined || !expectedStatuses.includes(before.status)) {
        return undefined;
      }
      const after = tx.execution.runs.transition({
        workspaceId,
        runId,
        expectedStatuses,
        toStatus,
        occurredAt,
        ...fields,
      });
      if (after === undefined) {
        return undefined;
      }
      if (before.status !== after.status) {
        appendStatusChanged(tx, after, before.status, occurredAt);
      }
      return { before, after };
    });
    if (result !== undefined && result.before.status !== result.after.status) {
      this.notifier.notify();
    }
    return result?.after;
  }

  private finalize(
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    status: Extract<AgentRunStatus, 'finished' | 'failed' | 'cancelled' | 'interrupted'>,
    detail: {
      readonly exitCode?: number;
      readonly signal?: string;
      readonly message?: string;
      readonly reason?: AgentExitReason;
    },
  ): void {
    clearTimeout(this.preparationTimers.get(runId));
    this.preparationTimers.delete(runId);
    this.live.delete(runId);
    const occurredAt = this.now().toISOString();
    let changed: boolean;
    try {
      changed = this.storage.transaction((tx) => {
        tx.phaseScheduling.release(runId, occurredAt, status);
        const before = tx.execution.runs.find(workspaceId, runId);
        if (before === undefined || isTerminalAgentRunStatus(before.status)) {
          return false;
        }
        this.runtimeEvidence?.freezeRun(tx, workspaceId, runId, this.checks?.inFlight(runId));
        const after = tx.execution.runs.transition({
          workspaceId,
          runId,
          expectedStatuses: LIVE_STATUSES,
          toStatus: status,
          occurredAt,
          finishedAt: occurredAt,
          ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
          ...(detail.reason ? { verdict: null } : {}),
          ...(detail.message === undefined || before.outcomeSummary !== undefined
            ? {}
            : { outcomeSummary: summarise(detail.message) }),
        });
        if (after === undefined) {
          return false;
        }
        tx.execution.runEvents.append({
          id: asAgentRunEventId(randomUUID()),
          workspaceId,
          runId,
          occurredAt,
          kind: 'run-finished',
          payload: {
            status,
            ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
            ...(detail.signal === undefined ? {} : { signal: detail.signal }),
            ...(detail.reason === undefined ? {} : { reason: detail.reason }),
            ...(detail.message === undefined ? {} : { message: detail.message }),
          },
        });
        tx.audit.append({
          id: asAuditEventId(randomUUID()),
          occurredAt,
          actorKind: 'system',
          workspaceId,
          action: 'agent-run.finished',
          targetType: 'agent-run',
          targetId: runId,
          outcome: status === 'finished' ? 'succeeded' : 'failed',
          priorVersion: before.version,
          resultingVersion: after.version,
          metadata: {
            status,
            ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
            turnCount: after.turnCount,
            ...(after.costUsd === undefined ? {} : { costUsd: after.costUsd }),
            ...(after.verdict === undefined ? {} : { verdict: after.verdict }),
          },
        });
        appendStatusChanged(tx, after, before.status, occurredAt);
        return true;
      });
    } finally {
      // After the run's record, and even if it failed, so nothing an agent left can keep a run
      // from ending, and its directory never waits for a restart (LIVE-31 review).
      this.removeProcessTemporaryDirectory(runId);
    }
    // Checks still running record nothing: the build record was frozen above.
    const checks = this.checks?.close(runId);
    if (checks) {
      const stopping = checks
        .catch((error) => this.log.warn('Check cleanup failed', { runId, error: String(error) }))
        .finally(() => this.cleanups.delete(stopping));
      this.cleanups.add(stopping);
    }
    if (changed) {
      const run = this.storage.execution.runs.find(workspaceId, runId);
      const cleanup = Promise.resolve(this.checkProtectedRefs(workspaceId, runId))
        // A failed comparison must not skip the run's other cleanup (R-G5 review).
        .catch((error) =>
          this.log.warn('Protected-ref check failed', { runId, error: String(error) }),
        )
        .then(() => this.runtimeEvidence?.cleanupRun(workspaceId, runId))
        .then(() =>
          run && status !== 'interrupted'
            ? this.storageService?.cleanupAfterRun(run.worktreeId)
            : undefined,
        )
        .catch((error) => this.log.warn('Run cleanup failed', { runId, error: String(error) }))
        .finally(() => {
          this.cleanups.delete(cleanup);
          this.notifier.notify();
        });
      this.cleanups.add(cleanup);
      this.notifier.notify();
    }
  }

  private recordCommand(
    context: AuthContext,
    workspaceId: WorkspaceId,
    runId: AgentRunId,
    action: 'agent-run.end' | 'agent-run.cancel',
    requestId?: string,
  ): void {
    const occurredAt = this.now().toISOString();
    this.storage.transaction((tx) => {
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt,
        actorKind: 'user',
        actorUserId: context.user.id,
        sessionId: context.session.id,
        workspaceId,
        ...(requestId === undefined ? {} : { requestId }),
        action,
        targetType: 'agent-run',
        targetId: runId,
        outcome: 'succeeded',
        metadata: {},
      });
    });
  }
}

/**
 * Reads a killed session until it reports its exit. If the stream ends or fails
 * without one, the backend's SIGTERM-then-SIGKILL escalation is given time to
 * finish before the worktree is released.
 */
async function drainUntilExit(items: AsyncIterator<AgentSessionItem>): Promise<void> {
  try {
    for (let next = await items.next(); next.done !== true; next = await items.next())
      if (next.value.type === 'exited') return;
  } catch {
    // The backend stream failed; fall through to the grace period.
  }
  await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
}

function appendStatusChanged(
  tx: StorageRepositories,
  run: AgentRun,
  fromStatus: AgentRunStatus,
  occurredAt: string,
): void {
  tx.workspaceEvents.appendEvent({
    id: asEventId(randomUUID()),
    occurredAt,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    workItemId: run.workItemId,
    runId: run.id,
    kind: 'agent-run-status-changed',
    payload: {
      runId: run.id,
      ...(run.workItemId ? { workItemId: run.workItemId } : { planVersionId: run.planVersionId }),
      fromStatus,
      toStatus: run.status,
    },
  });
}
