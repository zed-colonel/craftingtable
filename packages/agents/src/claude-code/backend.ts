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
import { claudeCodeArguments, claudeUserMessageLine } from './arguments.js';
import { CLAUDE_CODE_MODELS } from './models.js';
import { ClaudeStreamNormalizer, RAW_LINE_LIMIT_BYTES } from './normalize.js';
import { spawnSupervisedProcess } from './process.js';

export interface ClaudeCodeBackendOptions {
  /** Absolute path to the `claude` executable. */
  readonly executable: string;
  readonly terminationGraceMs?: number;
  /** Environment for the child; defaults to the daemon's own environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Models offered to the operator; defaults to the built-in list. */
  readonly models?: readonly AgentModelOption[];
}

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
        env: this.options.env ?? process.env,
        terminationGraceMs: this.options.terminationGraceMs ?? 5000,
        maxLineBytes: MAX_LINE_BYTES,
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

    const items = (async function* (): AsyncGenerator<AgentSessionItem> {
      let stderrBuffer = '';
      for await (const item of child.items) {
        switch (item.type) {
          case 'stdout-line':
            for (const event of normalizer.normalizeLine(item.line)) {
              yield { type: 'event', event };
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
          case 'stderr': {
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
            yield { type: 'exited', exitCode: item.exitCode, signal: item.signal };
            break;
        }
      }
    })();

    return Promise.resolve({
      pid: child.pid,
      items,
      send: (text: string) => child.write(claudeUserMessageLine(text)),
      end: () => child.endInput(),
      kill: () => child.terminate(),
    });
  }
}

export { RAW_LINE_LIMIT_BYTES };
