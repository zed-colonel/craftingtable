import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  type AgentBackend,
  type AgentBackendDescriptor,
  AgentLaunchError,
  type AgentLaunchRequest,
  type AgentModelOption,
  type AgentSession,
  type AgentSessionItem,
} from '../index.js';
import { agentEnvironment } from '../child-environment.js';
import { spawnSupervisedProcess } from '../process.js';
import { claudeCodeArguments, claudeUserMessageLine } from './arguments.js';
import { CLAUDE_CODE_MODELS } from './models.js';
import { ClaudeStreamNormalizer, RAW_LINE_LIMIT_BYTES } from './normalize.js';

export interface ClaudeCodeBackendOptions {
  /** Absolute path to the `claude` executable. */
  readonly executable: string;
  readonly terminationGraceMs?: number;
  /**
   * Where the child's named variables come from; defaults to the daemon's own environment.
   * Only allowlisted names are passed on (R-G5).
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Further variable names the operator lets through (`CRAFTINGTABLE_AGENT_ENV_ALLOW`). */
  readonly allowEnvironment?: readonly string[];
  /** Models offered to the operator; defaults to the built-in list. */
  readonly models?: readonly AgentModelOption[];
}

/** How Claude Code signs in without the operator's keychain. */
const CLAUDE_LOGIN_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
];

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const STDERR_EVENT_LIMIT_BYTES = 8 * 1024;

/**
 * Finds the Claude Code executable: an explicit absolute path, else the first
 * executable `claude` on PATH, else `~/.local/bin/claude`.
 */
export function resolveClaudeExecutable(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates: string[] = [];
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      return undefined;
    }
    candidates.push(explicit);
  } else {
    for (const entry of env.PATH?.split(delimiter) ?? []) {
      if (entry.length > 0) {
        candidates.push(join(entry, 'claude'));
      }
    }
    candidates.push(join(homedir(), '.local', 'bin', 'claude'));
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly kind = 'claude-code' as const;

  constructor(private readonly options: ClaudeCodeBackendOptions) {}

  describe(): AgentBackendDescriptor {
    return {
      kind: this.kind,
      label: 'Claude Code',
      executable: this.options.executable,
      models: this.options.models ?? CLAUDE_CODE_MODELS,
    };
  }

  launch(request: AgentLaunchRequest): Promise<AgentSession> {
    if (!isAbsolute(request.cwd) || request.prompt.length === 0) {
      return Promise.reject(
        new AgentLaunchError('invalid-request', 'Launch requires an absolute cwd and a prompt'),
      );
    }
    const normalizer = new ClaudeStreamNormalizer({
      permissionMode: request.permissionMode,
      cwd: request.cwd,
    });
    let child: ReturnType<typeof spawnSupervisedProcess>;
    try {
      child = spawnSupervisedProcess({
        executable: this.options.executable,
        args: claudeCodeArguments(request),
        cwd: request.cwd,
        env: agentEnvironment(
          this.options.env ?? process.env,
          CLAUDE_LOGIN_VARIABLES,
          this.options.allowEnvironment ?? [],
          request.environment,
          request.pathPrefix,
        ),
        terminationGraceMs: this.options.terminationGraceMs ?? 5000,
        maxLineBytes: MAX_LINE_BYTES,
        ...(request.deadlineAt
          ? { backgroundWorkDeadlineMs: Date.parse(request.deadlineAt) }
          : { backgroundWorkTimeoutMs: 30 * 60_000 }),
      });
    } catch (error) {
      return Promise.reject(
        new AgentLaunchError(
          'spawn-failed',
          error instanceof Error ? error.message : 'Claude Code could not be started',
        ),
      );
    }
    child.write(claudeUserMessageLine(request.prompt));

    let drainingBackgroundWork = false;
    /** The session was ended because the allowance is used up until a known reset (R-C9). */
    let endingForQuota = false;
    const items = (async function* (): AsyncGenerator<AgentSessionItem> {
      let stderrBuffer = '';
      let diagnosticTail = '';
      let backgroundWaitExpired = false;
      for await (const item of child.items) {
        switch (item.type) {
          case 'stdout-line':
            if (endingForQuota) break;
            for (const event of normalizer.normalizeLine(item.line)) {
              yield { type: 'event', event };
            }
            if (normalizer.quotaExhausted && !endingForQuota) {
              // Sub-agents and background work would keep failing against the used-up
              // allowance for as long as they run (736446e8: 31 minutes); end them now.
              endingForQuota = true;
              yield {
                type: 'event',
                event: {
                  kind: 'notice',
                  payload: {
                    category: 'rate-limit',
                    message:
                      'The allowance is used up until its reported reset. CraftingTable is ending the session and its background work.',
                  },
                },
              };
              child.terminate();
            }
            break;
          case 'stdout-overflow':
            yield {
              type: 'event',
              event: {
                kind: 'notice',
                payload: {
                  category: 'other',
                  message: `Dropped a ${item.bytes}-byte backend line that exceeded the limit`,
                },
              },
            };
            break;
          case 'background-work-waiting':
            drainingBackgroundWork = true;
            yield {
              type: 'event',
              event: {
                kind: 'notice',
                payload: {
                  category: 'task',
                  message:
                    'The agent exited while background processes were still running. CraftingTable is waiting for its process group before releasing this worktree.',
                },
              },
            };
            break;
          case 'stderr': {
            diagnosticTail = (diagnosticTail + item.text).slice(-4096);
            if (/Background tasks still running after \d+s; terminating\./i.test(diagnosticTail))
              backgroundWaitExpired = true;
            stderrBuffer += item.text;
            if (Buffer.byteLength(stderrBuffer, 'utf8') >= STDERR_EVENT_LIMIT_BYTES) {
              yield { type: 'event', event: { kind: 'stderr', payload: { text: stderrBuffer } } };
              stderrBuffer = '';
            }
            break;
          }
          case 'exited':
            if (stderrBuffer.trim().length > 0) {
              yield { type: 'event', event: { kind: 'stderr', payload: { text: stderrBuffer } } };
              stderrBuffer = '';
            }
            if (endingForQuota) {
              // The work was ended on purpose; nothing of it outlives the process group.
              yield { type: 'event', event: normalizer.endedForQuota() };
              yield { type: 'exited', exitCode: item.exitCode ?? 1, signal: item.signal };
              break;
            }
            yield {
              type: 'exited',
              exitCode: item.exitCode,
              signal: item.signal,
              ...(item.backgroundWorkTimedOut
                ? { reason: 'background-work-timeout' as const }
                : backgroundWaitExpired ||
                    item.backgroundWorkIncomplete ||
                    normalizer.hasUncollectedBackgroundWork
                  ? { reason: 'background-work-incomplete' as const }
                  : {}),
            };
            break;
        }
      }
    })();

    return Promise.resolve({
      get backgroundWorkPending() {
        return drainingBackgroundWork || normalizer.hasUncollectedBackgroundWork;
      },
      pid: child.pid,
      items,
      send: (text: string) => child.write(claudeUserMessageLine(text)),
      end: () => child.endInput(),
      kill: () => child.terminate(),
    });
  }
}

export { RAW_LINE_LIMIT_BYTES };
