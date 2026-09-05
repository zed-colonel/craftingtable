import type { AgentBillingSource, AgentPermissionMode, JsonValue } from '@craftingtable/domain';
import type { NormalizedAgentEvent } from '../index.js';

/**
 * Translates Claude Code stream-json lines into normalized run events.
 *
 * The vendor format is treated as untrusted input: unknown shapes become
 * bounded `notice` events rather than exceptions, and every string that could
 * be large (tool inputs, tool results, raw lines) is truncated to a fixed
 * ceiling before it can reach storage.
 */

export const RAW_LINE_LIMIT_BYTES = 64 * 1024;
export const TOOL_INPUT_LIMIT_BYTES = 16 * 1024;
export const TOOL_RESULT_LIMIT_BYTES = 32 * 1024;
export const MESSAGE_TEXT_LIMIT_BYTES = 256 * 1024;

const TRUNCATION_MARKER = '\n…[truncated by CraftingTable]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= limit) {
    return { text: value, truncated: false };
  }
  return {
    text: `${bytes.subarray(0, limit).toString('utf8')}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function boundedRaw(line: string): string {
  return truncateUtf8(line, RAW_LINE_LIMIT_BYTES).text;
}

function boundedJson(value: unknown, limit: number): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserialisable tool input]';
  }
  if (Buffer.byteLength(serialized, 'utf8') <= limit) {
    return JSON.parse(serialized) as JsonValue;
  }
  return truncateUtf8(serialized, limit).text;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Flattens tool_result content, which may be a string or an array of blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (isRecord(block)) {
          if (block.type === 'text') return stringOf(block.text);
          if (block.type === 'image') return '[image]';
          return `[${stringOf(block.type) || 'block'}]`;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/**
 * Claude Code reports where its credentials came from. `none` means the CLI's
 * own login (a subscription); anything else names an API key source.
 */
function billingOf(apiKeySource: unknown): AgentBillingSource {
  if (typeof apiKeySource !== 'string') {
    return 'unknown';
  }
  return apiKeySource === 'none' ? 'subscription' : 'api-key';
}

function firstLine(value: string, limit = 200): string {
  const line = value.split('\n')[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export function summarizeToolCall(name: string, input: unknown): string {
  if (!isRecord(input)) {
    return name;
  }
  switch (name) {
    case 'Bash':
      return firstLine(stringOf(input.description) || stringOf(input.command));
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return firstLine(stringOf(input.file_path) || stringOf(input.notebook_path));
    case 'Glob':
    case 'Grep':
      return firstLine(stringOf(input.pattern));
    case 'Agent':
    case 'Task':
      return firstLine(stringOf(input.description));
    case 'WebFetch':
      return firstLine(stringOf(input.url));
    case 'WebSearch':
      return firstLine(stringOf(input.query));
    case 'Skill':
      return firstLine(stringOf(input.skill));
    default: {
      const keys = Object.keys(input);
      const preview = keys
        .slice(0, 3)
        .map(
          (key) =>
            `${key}=${firstLine(stringOf(input[key]) || JSON.stringify(input[key]) || '', 60)}`,
        )
        .join(' ');
      return firstLine(preview);
    }
  }
}

export interface ClaudeNormalizerOptions {
  readonly permissionMode: AgentPermissionMode;
  readonly cwd: string;
}

/**
 * Stateful per-session normalizer. Claude Code emits a fresh `system/init`
 * for every turn of a multi-turn session; only the first becomes
 * `session-started`.
 */
export class ClaudeStreamNormalizer {
  private sessionStarted = false;
  private sessionId: string | undefined;

  constructor(private readonly options: ClaudeNormalizerOptions) {}

  get backendSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Normalizes one stdout line; returns zero or more events. */
  normalizeLine(line: string): readonly NormalizedAgentEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [
        {
          kind: 'notice',
          payload: {
            category: 'other',
            message: `Unparseable backend output: ${firstLine(trimmed, 500)}`,
          },
          raw: boundedRaw(trimmed),
        },
      ];
    }
    if (!isRecord(parsed)) {
      return [];
    }
    const raw = boundedRaw(trimmed);
    switch (parsed.type) {
      case 'system':
        return this.normalizeSystem(parsed, raw);
      case 'assistant':
        return this.normalizeAssistant(parsed, raw);
      case 'user':
        return this.normalizeUser(parsed, raw);
      case 'result':
        return this.normalizeResult(parsed, raw);
      case 'rate_limit_event':
        return this.normalizeRateLimit(parsed, raw);
      case 'stream_event':
        return [];
      default:
        return [
          {
            kind: 'notice',
            payload: {
              category: 'other',
              message: `Backend message: ${stringOf(parsed.type) || 'unknown'}`,
            },
            raw,
          },
        ];
    }
  }

  private normalizeSystem(
    message: Record<string, unknown>,
    raw: string,
  ): readonly NormalizedAgentEvent[] {
    switch (message.subtype) {
      case 'init': {
        const sessionId = stringOf(message.session_id);
        if (sessionId.length > 0) {
          this.sessionId = sessionId;
        }
        if (this.sessionStarted) {
          return [];
        }
        this.sessionStarted = true;
        return [
          {
            kind: 'session-started',
            payload: {
              backend: 'claude-code',
              backendSessionId: sessionId || 'unknown',
              model: stringOf(message.model) || 'unknown',
              permissionMode: this.options.permissionMode,
              cwd: stringOf(message.cwd) || this.options.cwd,
              billing: billingOf(message.apiKeySource),
            },
            raw,
          },
        ];
      }
      // Per-token thinking progress carries no text; it is pure noise here.
      case 'thinking_tokens':
      // The task list itself is derivable from task_started/task_notification.
      case 'task_updated':
      case 'background_tasks_changed':
        return [];
      case 'task_started':
        return [
          {
            kind: 'notice',
            payload: {
              category: 'task',
              message: `Background task started: ${firstLine(stringOf(message.description) || stringOf(message.task_type) || 'task')}`,
            },
            raw,
          },
        ];
      case 'task_notification':
        return [
          {
            kind: 'notice',
            payload: {
              category: 'task',
              message: `Background task ${stringOf(message.status) || 'updated'}: ${firstLine(stringOf(message.summary) || stringOf(message.task_id) || 'task', 300)}`,
            },
            raw,
          },
        ];
      case 'hook_started':
        return [
          {
            kind: 'notice',
            payload: {
              category: 'hook',
              message: `Hook ${stringOf(message.hook_name) || stringOf(message.hook_event)}`,
            },
          },
        ];
      case 'hook_response':
        return [];
      case 'compact_boundary':
        return [
          {
            kind: 'notice',
            payload: { category: 'compaction', message: 'Context compacted' },
            raw,
          },
        ];
      default:
        return [
          {
            kind: 'notice',
            payload: {
              category: 'other',
              message: `Backend system message: ${stringOf(message.subtype) || 'unknown'}`,
            },
            raw,
          },
        ];
    }
  }

  private normalizeAssistant(
    message: Record<string, unknown>,
    raw: string,
  ): readonly NormalizedAgentEvent[] {
    const inner = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(inner.content) ? inner.content : [];
    const events: NormalizedAgentEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const text = stringOf(block.text);
        if (text.length === 0) continue;
        events.push({
          kind: 'assistant-message',
          payload: { text: truncateUtf8(text, MESSAGE_TEXT_LIMIT_BYTES).text },
          raw,
        });
      } else if (block.type === 'tool_use') {
        const name = stringOf(block.name) || 'unknown';
        events.push({
          kind: 'tool-call',
          payload: {
            toolUseId: stringOf(block.id) || 'unknown',
            name,
            input: boundedJson(block.input ?? null, TOOL_INPUT_LIMIT_BYTES),
            summary: summarizeToolCall(name, block.input),
          },
          raw,
        });
      }
    }
    return events;
  }

  private normalizeUser(
    message: Record<string, unknown>,
    raw: string,
  ): readonly NormalizedAgentEvent[] {
    const inner = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(inner.content) ? inner.content : [];
    const events: NormalizedAgentEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        const bounded = truncateUtf8(toolResultText(block.content), TOOL_RESULT_LIMIT_BYTES);
        events.push({
          kind: 'tool-result',
          payload: {
            toolUseId: stringOf(block.tool_use_id) || 'unknown',
            content: bounded.text,
            isError: block.is_error === true,
            truncated: bounded.truncated,
          },
          raw,
        });
      }
      // Echoed user text is ignored: the daemon records what it sent.
    }
    return events;
  }

  private normalizeResult(
    message: Record<string, unknown>,
    raw: string,
  ): readonly NormalizedAgentEvent[] {
    const isError = message.is_error === true || message.subtype !== 'success';
    const cost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined;
    const turns =
      typeof message.num_turns === 'number' ? Math.max(0, Math.trunc(message.num_turns)) : 0;
    const duration =
      typeof message.duration_ms === 'number' ? Math.max(0, Math.trunc(message.duration_ms)) : 0;
    const resultText =
      stringOf(message.result) ||
      (isError ? `Turn ended: ${stringOf(message.subtype) || 'error'}` : '');
    return [
      {
        kind: 'turn-completed',
        payload: {
          outcome: isError ? 'error' : 'success',
          resultText: truncateUtf8(resultText, MESSAGE_TEXT_LIMIT_BYTES).text,
          ...(cost === undefined ? {} : { costUsd: cost }),
          turns,
          durationMs: duration,
        },
        raw,
      },
    ];
  }

  private normalizeRateLimit(
    message: Record<string, unknown>,
    raw: string,
  ): readonly NormalizedAgentEvent[] {
    const info = isRecord(message.rate_limit_info) ? message.rate_limit_info : {};
    if (info.status === 'allowed') {
      return [];
    }
    return [
      {
        kind: 'notice',
        payload: {
          category: 'rate-limit',
          message: `Rate limit ${stringOf(info.status) || 'event'} (${stringOf(info.rateLimitType) || 'unknown window'})`,
        },
        raw,
      },
    ];
  }
}
