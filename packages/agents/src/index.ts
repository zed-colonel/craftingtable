import type {
  AgentBackendKind,
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
  /** Absolute worktree path used as the agent's working directory. */
  readonly cwd: string;
  /** The first user message. */
  readonly prompt: string;
  readonly permissionMode: AgentPermissionMode;
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
    /** The raw vendor line, bounded, for diagnostics. */
    readonly raw?: string;
  };
}[AgentRunEventKind];

export type AgentSessionItem =
  | { readonly type: 'event'; readonly event: NormalizedAgentEvent }
  | {
      readonly type: 'exited';
      readonly exitCode: number | null;
      readonly signal: string | null;
    };

export interface AgentSession {
  /** Process identifier, for diagnostics only. */
  readonly pid: number | undefined;
  /** Items until the process exits; the final item is always `exited`. */
  readonly items: AsyncIterable<AgentSessionItem>;
  /** Queue another user message into the live session. */
  send(text: string): boolean;
  /** Close the input stream so the agent finishes after its current turn. */
  end(): void;
  /** Terminate the process group: SIGTERM, then SIGKILL after the grace period. */
  kill(): void;
}

export interface AgentBackendDescriptor {
  readonly kind: AgentBackendKind;
  readonly label: string;
  readonly executable: string;
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

export { ClaudeCodeBackend, resolveClaudeExecutable } from './claude-code/backend.js';
export { claudeCodeArguments, claudeUserMessageLine } from './claude-code/arguments.js';
export { ClaudeStreamNormalizer } from './claude-code/normalize.js';
