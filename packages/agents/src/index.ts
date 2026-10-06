export { auditNativeEnvironment, nativeHostDigest } from './native-environment.js';
export {
  prepareLocalCheckLaunchers,
  loadLocalCiConfig,
  cleanupLocalCi,
  cleanupLocalCiManifest,
  cleanupDaemonRunChecks,
  executeCheck,
  resolveGitDirectories,
  stopCheckUnits,
  syncDaemonCargoHome,
  confinedCheckArguments,
  type CheckConfinement,
  type CheckOutcome,
  type LocalCiConfig,
} from './local-check.js';
export { agentEnvironment, allowlistedEnvironment } from './child-environment.js';
export {
  CheckReply,
  claimCheckRequest,
  pendingCheckRequests,
  submitCheck,
  type CheckRequest,
  type CheckTool,
} from './check-spool.js';
export {
  prepareCargoLauncher,
  type PinnedCargoManifest,
  cargoManifestDigest,
} from './pinned-cargo.js';
import type { ModelCatalogSnapshot } from './model-catalog.js';
import type {
  AgentBackendKind,
  AgentExitReason,
  AgentModel,
  ModelCatalogStatus,
  AgentPermissionMode,
  AgentRunEventKind,
  AgentRunEventPayload,
} from '@craftingtable/domain';

/**
 * The agent backend seam.
 *
 * A backend launches a coding agent as a supervised child process inside a
 * worktree and translates the vendor's native output into normalized events.
 * The daemon persists those events and owns run state; the backend owns only
 * the process and the translation. Adding Codex or another agent means adding
 * another implementation of `AgentBackend`, not new daemon vocabulary.
 */

export interface AgentLaunchRequest {
  /** Controller-only preparation: disable write and escalation tools. */
  readonly readOnly?: boolean;
  /**
   * The daemon's own files no sandboxed command may read (R-G9): its database and the copies of
   * it, and the credentials file. An agent outside a sandbox runs as the operator and can.
   */
  readonly deniedReads?: readonly string[];
  /** Where the run's launchers are; the daemon puts them on `pathPrefix`. */
  readonly buildEnvironment?: { readonly binDirectory: string; readonly namespace?: string };
  /**
   * The run's own variables (scratch space, build cache, run namespace), computed by the daemon
   * (R-G5, AGT-04). Adapters start the agent from named variables only, add these, and put
   * `pathPrefix` ahead of PATH; they decide nothing else about the environment.
   */
  readonly environment?: Readonly<Record<string, string>>;
  readonly pathPrefix?: readonly string[];
  /** Absolute worktree path used as the agent's working directory. */
  readonly cwd: string;
  /** Controller-owned scratch directory, outside the Git worktree. */
  readonly temporaryDirectory?: string;
  /**
   * A short private directory for the agent process's own temporary files, its TMPDIR (LIVE-31).
   * Claude Code's command sandbox makes Unix sockets there, and a socket path holds at most 107
   * bytes, which a run's scratch path leaves no room for. Adapters whose agent does not need it
   * leave the run's variables as they are.
   */
  readonly processTemporaryDirectory?: string;
  /**
   * The Cargo target directory for this run: the worktree's shared build cache (R-G7).
   * Without it, builds go to `<temporaryDirectory>/target`.
   */
  readonly buildCacheDirectory?: string;
  /** Original automated step deadline, including background drain and continuations. */
  readonly deadlineAt?: string;
  /** The first user message. */
  readonly prompt: string;
  readonly permissionMode: AgentPermissionMode;
  readonly reasoningEffort?: import('@craftingtable/domain').AgentReasoningEffort;
  readonly model?: string;
  readonly appendSystemPrompt?: string;
  /** Additional directories the agent may read, such as a run's brief directory. */
  readonly additionalDirectories?: readonly string[];
  /** Resume a previous vendor session instead of starting fresh. */
  readonly resumeSessionId?: string;
  readonly maxBudgetUsd?: number;
  /** Display name for the vendor session list. */
  readonly sessionName?: string;
}

/** Discriminated on `kind`; the payload type follows the domain vocabulary. */
export type NormalizedAgentEvent = {
  [K in AgentRunEventKind]: {
    readonly kind: K;
    readonly payload: AgentRunEventPayload<K>;
    /**
     * The raw vendor line, bounded, only when the adapter could not represent it: an
     * unparseable line or an unknown message kind. Normalized events carry everything in
     * their payload, so their lines are not kept (R-H2).
     */
    readonly raw?: string;
  };
}[AgentRunEventKind];

export type AgentSessionItem =
  | { readonly type: 'event'; readonly event: NormalizedAgentEvent }
  | {
      readonly type: 'exited';
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly reason?: AgentExitReason;
    };

export interface AgentSession {
  /** Live work reservation, including tasks whose results have not been collected. */
  readonly backgroundWorkPending?: boolean;
  /** Process identifier, for diagnostics only. */
  readonly pid: number | undefined;
  /** Items until the session ends; the final item is always `exited`. */
  readonly items: AsyncIterable<AgentSessionItem>;
  /** Queue another user message into the live session. */
  send(text: string): boolean;
  /** Finish the session after accepted messages have completed. */
  end(): void;
  /** Terminate the process group: SIGTERM, then SIGKILL after the grace period. */
  kill(): void;
}

/** A model the operator can pick: its id is what the backend is sent (R-G15). */
export type AgentModelOption = AgentModel;

export interface AgentBackendDescriptor {
  readonly kind: AgentBackendKind;
  readonly label: string;
  readonly executable: string;
  /** Models the operator can pick from; the backend's own default is always allowed too. */
  readonly models: readonly AgentModelOption[];
  /** Where `models` came from and how the last look at the CLI's catalog went (R-G15). */
  readonly catalog: ModelCatalogStatus;
}

export interface AgentBackend {
  readonly kind: AgentBackendKind;
  describe(): AgentBackendDescriptor;
  /**
   * Reads the CLI's own model catalog again (R-G15); `describe()` offers what it found. A
   * failed read keeps the list in use and says why; an operator's fixed list is not re-read.
   */
  listModels(): Promise<ModelCatalogSnapshot>;
  launch(request: AgentLaunchRequest): Promise<AgentSession>;
}

export class AgentLaunchError extends Error {
  constructor(
    /**
     * `environment-unavailable`: the host cannot give the agent the tools its posture requires,
     * such as Claude Code's command sandbox (LIVE-31); found before anything starts.
     */
    readonly reason:
      | 'executable-missing'
      | 'spawn-failed'
      | 'invalid-request'
      | 'environment-unavailable'
      /**
       * `model-misnamed`: the model is a display name, or another spelling of an id, in the
       * backend's catalog (R-G15, LIVE-34); found before anything starts.
       */
      | 'model-misnamed',
    message: string,
  ) {
    super(message);
    this.name = 'AgentLaunchError';
  }
}

export { claudeCodeArguments, claudeUserMessageLine } from './claude-code/arguments.js';
export { ClaudeCodeBackend, resolveClaudeExecutable } from './claude-code/backend.js';
export { parseModelList } from './models.js';
export {
  MODEL_CATALOG_LIMIT,
  ModelCatalog,
  ModelCatalogError,
  type ModelCatalogSnapshot,
  type ModelDiscovery,
} from './model-catalog.js';
export { CLAUDE_CODE_ALIASES, CLAUDE_CODE_MODELS } from './claude-code/models.js';
export {
  CLAUDE_CATALOG_VERSION,
  claudeConfigDirectory,
  readClaudeModelCatalog,
} from './claude-code/catalog.js';
export { ClaudeStreamNormalizer } from './claude-code/normalize.js';

export { CodexBackend } from './codex/backend.js';
export { CODEX_MODELS } from './codex/models.js';
export { listCodexModels } from './codex/catalog.js';
export { CodexStreamNormalizer } from './codex/normalize.js';

export { observeRustToolchain } from './local-toolchain.js';

export { prepareHistoricalCargoLauncher } from './pinned-cargo.js';
