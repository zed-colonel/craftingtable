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
  confinedCheckArguments,
  type CheckConfinement,
  type CheckOutcome,
  type LocalCiConfig,
} from './local-check.js';
export { allowlistedEnvironment } from './child-environment.js';
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
import type {
  AgentBackendKind,
  AgentExitReason,
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
  readonly buildEnvironment?: { readonly binDirectory: string; readonly namespace?: string };
  /** Absolute worktree path used as the agent's working directory. */
  readonly cwd: string;
  /** Controller-owned scratch directory, outside the Git worktree. */
  readonly temporaryDirectory?: string;
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

export interface AgentModelOption {
  /** The identifier handed to the backend, an alias or a full model id. */
  readonly id: string;
  readonly label: string;
}

export interface AgentBackendDescriptor {
  readonly kind: AgentBackendKind;
  readonly label: string;
  readonly executable: string;
  /** Models the operator can pick from; the backend's own default is always allowed too. */
  readonly models: readonly AgentModelOption[];
}

export interface AgentBackend {
  readonly kind: AgentBackendKind;
  describe(): AgentBackendDescriptor;
  launch(request: AgentLaunchRequest): Promise<AgentSession>;
}

export class AgentLaunchError extends Error {
  constructor(
    readonly reason: 'executable-missing' | 'spawn-failed' | 'invalid-request',
    message: string,
  ) {
    super(message);
    this.name = 'AgentLaunchError';
  }
}

export { claudeCodeArguments, claudeUserMessageLine } from './claude-code/arguments.js';
export { ClaudeCodeBackend, resolveClaudeExecutable } from './claude-code/backend.js';
export { parseModelList } from './models.js';
export { CLAUDE_CODE_MODELS } from './claude-code/models.js';
export { ClaudeStreamNormalizer } from './claude-code/normalize.js';

export { CodexBackend } from './codex/backend.js';
export { CODEX_MODELS } from './codex/models.js';
export { CodexStreamNormalizer } from './codex/normalize.js';

export { observeRustToolchain } from './local-toolchain.js';

export { prepareHistoricalCargoLauncher } from './pinned-cargo.js';
