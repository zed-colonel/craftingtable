import {
  boundedJson,
  boundedRaw,
  firstLine,
  isRecord,
  MESSAGE_TEXT_LIMIT_BYTES,
  stringOf,
  TOOL_INPUT_LIMIT_BYTES,
  TOOL_RESULT_LIMIT_BYTES,
  truncateUtf8,
} from '../bounded.js';

export { RAW_LINE_LIMIT_BYTES, TOOL_RESULT_LIMIT_BYTES } from '../bounded.js';

import type {
  ProviderFailure,
  AgentBillingSource,
  AgentPermissionMode,
} from '@craftingtable/domain';
import type { NormalizedAgentEvent } from '../index.js';

/**
 * Translates Claude Code stream-json lines into normalized run events.
 *
 * The vendor format is treated as untrusted input: unknown shapes become
 * bounded `notice` events rather than exceptions, and every string that could
 * be large (tool inputs, tool results, raw lines) is truncated to a fixed
 * ceiling before it can reach storage. The raw line travels only with an event
 * the normalizer could not represent: an unparseable line or an unknown message
 * kind (R-H2). Everything else is fully described by its normalized payload.
 */

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

const failures = {
  capacity: {
    kind: 'capacity',
    message: 'The model service is overloaded.',
    safeToRetry: true,
  },
  unavailable: {
    kind: 'unavailable',
    message: 'The model service reported a server failure.',
    safeToRetry: true,
  },
  authentication: {
    kind: 'authentication',
    message: 'The model service requires authentication.',
    safeToRetry: false,
  },
  quota: {
    kind: 'quota',
    message: 'The model service reported an allowance or rate limit.',
    safeToRetry: false,
  },
  unknown: {
    kind: 'unknown',
    message: 'The backend reported an unclassified error.',
    safeToRetry: false,
  },
} as const satisfies Record<string, ProviderFailure>;

/** The assistant message's structured `error` discriminant (SDK `AssistantMessageError`). */
function assistantErrorFailure(error: string): ProviderFailure {
  if (error === 'server_error') return failures.unavailable;
  if (error === 'authentication_failed') return failures.authentication;
  if (error === 'billing_error' || error === 'rate_limit') return failures.quota;
  return failures.unknown;
}

/**
 * The result's `api_error_status`. Overload (529) and other 5xx responses are temporary service
 * failures (ADR-062). 429/402 are allowance or rate limits, including subscription session
 * windows, and 401/403 need new credentials; both require the operator.
 */
function apiStatusFailure(status: unknown): ProviderFailure | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  if (status === 529) return failures.capacity;
  if (status >= 500 && status <= 599) return failures.unavailable;
  if (status === 429 || status === 402) return failures.quota;
  if (status === 401 || status === 403) return failures.authentication;
  return failures.unknown;
}

/** An operator-owned classification from either record wins; otherwise the HTTP status does. */
function combineFailures(
  assistant: ProviderFailure | undefined,
  api: ProviderFailure | undefined,
): ProviderFailure | undefined {
  if (assistant?.kind === 'authentication' || assistant?.kind === 'quota') return assistant;
  return api ?? assistant;
}

/** Unrecognized message kinds reported once each per run; later repeats are dropped. */
const UNKNOWN_REPORT_LIMIT = 64;

export interface ClaudeNormalizerOptions {
  readonly permissionMode: AgentPermissionMode;
  readonly cwd: string;
}

/** Names from an init list whose entries are names or `{ name }` objects, bounded. */
function loadedNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) =>
      typeof entry === 'string' ? entry : isRecord(entry) ? stringOf(entry.name) : '',
    )
    .filter((name) => name !== '')
    .slice(0, 500)
    .map((name) => name.slice(0, 200));
}

/**
 * Stateful per-session normalizer. Claude Code emits a fresh `system/init`
 * for every turn of a multi-turn session; only the first becomes
 * `session-started`.
 */
export class ClaudeStreamNormalizer {
  private sessionStarted = false;
  private providerFailure: ProviderFailure | undefined;
  /** When the allowance a `rejected` rate-limit report named resets (R-C8). */
  private quotaResetsAt: string | undefined;
  /** The window (`five_hour`, …) the rejected report named. */
  private quotaWindow: unknown;
  /** A quota failure with a known reset ended a result: the session should end now (R-C9). */
  private terminalQuota: ProviderFailure | undefined;
  /** The last assistant message's structured error discriminant, e.g. `billing_error`. */
  private providerError: string | undefined;
  private interactiveRequest = false;
  private readonly pendingTools = new Set<string>();
  private readonly backgroundTasks = new Set<string>();
  private backgroundAfterResult = false;
  private untrackedBackgroundTasks = false;
  private readonly reportedUnknown = new Set<string>();

  /**
   * The allowance is used up until a known reset (R-C9). Sub-agents and background work would
   * only keep failing against it, so the session should be ended now; `endedForQuota` then
   * reports the step's final failure.
   */
  get quotaExhausted(): boolean {
    return this.terminalQuota !== undefined;
  }

  /**
   * The step's final result once the session was ended for a used-up allowance. The session
   * and its process group are gone, so no tool or background work outlives it, and the step
   * can be retried after the reset unless the session ever made an interactive request or
   * the quota result reported denied permissions.
   */
  endedForQuota(): NormalizedAgentEvent {
    const failure = this.terminalQuota!;
    return {
      kind: 'turn-completed',
      payload: {
        outcome: 'error',
        providerFailure: {
          ...failure,
          message: `${failure.message} CraftingTable ended the session and its background work until the reset.`,
          safeToRetry: failure.safeToRetry && !this.interactiveRequest,
        },
        resultText: `The allowance is used up until ${failure.resetsAt}.`,
        turns: 0,
        durationMs: 0,
      },
    };
  }

  /** A result emitted before pending task notifications is not the collected outcome. */
  get hasUncollectedBackgroundWork(): boolean {
    return (
      this.backgroundTasks.size > 0 || this.backgroundAfterResult || this.untrackedBackgroundTasks
    );
  }

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
    switch (parsed.type) {
      case 'system':
        return this.normalizeSystem(parsed, trimmed);
      case 'assistant':
        return this.normalizeAssistant(parsed);
      case 'user':
        return this.normalizeUser(parsed);
      case 'result':
        return this.normalizeResult(parsed);
      case 'rate_limit_event':
        return this.normalizeRateLimit(parsed);
      case 'stream_event':
        return [];
      default:
        return this.unknownOnce(
          `Backend message: ${firstLine(stringOf(parsed.type) || 'unknown', 100)}`,
          trimmed,
        );
    }
  }

  /**
   * New CLI releases add progress-style messages. Report each unrecognized kind once per run,
   * with one bounded raw sample for diagnosis, instead of journaling every occurrence.
   */
  private unknownOnce(message: string, line: string): readonly NormalizedAgentEvent[] {
    if (this.reportedUnknown.has(message) || this.reportedUnknown.size >= UNKNOWN_REPORT_LIMIT)
      return [];
    this.reportedUnknown.add(message);
    return [{ kind: 'notice', payload: { category: 'other', message }, raw: boundedRaw(line) }];
  }

  private normalizeSystem(
    message: Record<string, unknown>,
    line: string,
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
              ...(Array.isArray(message.skills) ||
              Array.isArray(message.plugins) ||
              Array.isArray(message.mcp_servers)
                ? {
                    loaded: {
                      skills: loadedNames(message.skills),
                      plugins: loadedNames(message.plugins),
                      mcpServers: loadedNames(message.mcp_servers),
                    },
                  }
                : {}),
            },
          },
        ];
      }
      // Per-token thinking progress carries no text; it is pure noise here.
      case 'thinking_tokens':
      // The task list itself is derivable from task_started/task_notification.
      case 'task_updated':
      case 'background_tasks_changed':
        return [];
      case 'task_started': {
        const id = stringOf(message.task_id);
        if (!id || id.length > 256 || this.backgroundTasks.size >= 1024)
          this.untrackedBackgroundTasks = true;
        else this.backgroundTasks.add(id);
        this.backgroundAfterResult = true;
        return [
          {
            kind: 'notice',
            payload: {
              category: 'task',
              message: `Background task started: ${firstLine(stringOf(message.description) || stringOf(message.task_type) || 'task')}`,
            },
          },
        ];
      }
      case 'task_notification':
        if (['completed', 'failed', 'stopped'].includes(stringOf(message.status)))
          this.backgroundTasks.delete(stringOf(message.task_id));
        this.backgroundAfterResult = true;
        return [
          {
            kind: 'notice',
            payload: {
              category: 'task',
              message: `Background task ${stringOf(message.status) || 'updated'}: ${firstLine(stringOf(message.summary) || stringOf(message.task_id) || 'task', 300)}`,
            },
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
          },
        ];
      default:
        return this.unknownOnce(
          `Backend system message: ${firstLine(stringOf(message.subtype) || 'unknown', 100)}`,
          line,
        );
    }
  }

  private normalizeAssistant(message: Record<string, unknown>): readonly NormalizedAgentEvent[] {
    // Only the main thread's messages describe the turn's service state. A sub-agent message
    // (parent_tool_use_id set) neither records nor clears a main-thread failure.
    if (!message.parent_tool_use_id) {
      this.providerFailure =
        typeof message.error === 'string' ? assistantErrorFailure(message.error) : undefined;
      this.providerError = typeof message.error === 'string' ? message.error : undefined;
    }

    const inner = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(inner.content) ? inner.content : [];
    const events: NormalizedAgentEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const text = stringOf(block.text);
        if (text.length === 0) continue;
        const bounded = truncateUtf8(text, MESSAGE_TEXT_LIMIT_BYTES);
        events.push({
          kind: 'assistant-message',
          payload: { text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) },
        });
      } else if (block.type === 'tool_use') {
        this.pendingTools.add(stringOf(block.id) || 'unknown');
        const name = stringOf(block.name) || 'unknown';
        if (['AskUserQuestion', 'ExitPlanMode'].includes(name)) this.interactiveRequest = true;
        events.push({
          kind: 'tool-call',
          payload: {
            toolUseId: stringOf(block.id) || 'unknown',
            name,
            input: boundedJson(block.input ?? null, TOOL_INPUT_LIMIT_BYTES),
            summary: summarizeToolCall(name, block.input),
          },
        });
      }
    }
    return events;
  }

  private normalizeUser(message: Record<string, unknown>): readonly NormalizedAgentEvent[] {
    const inner = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(inner.content) ? inner.content : [];
    const events: NormalizedAgentEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        this.pendingTools.delete(stringOf(block.tool_use_id));
        const bounded = truncateUtf8(toolResultText(block.content), TOOL_RESULT_LIMIT_BYTES);
        events.push({
          kind: 'tool-result',
          payload: {
            toolUseId: stringOf(block.tool_use_id) || 'unknown',
            content: bounded.text,
            isError: block.is_error === true,
            truncated: bounded.truncated,
          },
        });
      }
      // Echoed user text is ignored: the daemon records what it sent.
    }
    return events;
  }

  private normalizeResult(message: Record<string, unknown>): readonly NormalizedAgentEvent[] {
    // Claude Code reports an API failure as `terminal_reason: 'api_error'` with the HTTP status,
    // even when the result subtype is `success` (with `is_error: true`).
    const apiError = message.terminal_reason === 'api_error';
    const combined = combineFailures(
      this.providerFailure,
      apiError ? apiStatusFailure(message.api_error_status) : undefined,
    );
    // A used-up allowance with a reported reset is safe to retry once it resets; every
    // other condition below (outstanding tools, interaction, background work) still applies.
    // A billing failure (402, `billing_error`) does not end at a reset: it stays with the
    // operator even when a rate-limit reset was reported before it.
    const billing =
      this.providerError === 'billing_error' || (apiError && message.api_error_status === 402);
    const failure =
      combined?.kind === 'quota' && this.quotaResetsAt && !billing
        ? { ...combined, safeToRetry: true, resetsAt: this.quotaResetsAt }
        : combined;
    const isError = message.is_error === true || message.subtype !== 'success';
    const denied =
      Array.isArray(message.permission_denials) && message.permission_denials.length > 0;
    // R-C9: only a failed result with its own rejected report ends the session.
    if (
      failure?.resetsAt &&
      isError &&
      (message.subtype === 'error_during_execution' || apiError) &&
      !this.terminalQuota
    )
      this.terminalQuota = { ...failure, safeToRetry: !denied };
    this.providerFailure = undefined;
    this.providerError = undefined;
    this.quotaResetsAt = undefined;
    const pendingBackground = this.hasUncollectedBackgroundWork;
    this.backgroundAfterResult = false;
    const cost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined;
    const turns =
      typeof message.num_turns === 'number' ? Math.max(0, Math.trunc(message.num_turns)) : 0;
    const duration =
      typeof message.duration_ms === 'number' ? Math.max(0, Math.trunc(message.duration_ms)) : 0;
    const resultText =
      stringOf(message.result) ||
      (isError ? `Turn ended: ${stringOf(message.subtype) || 'error'}` : '');
    const bounded = truncateUtf8(resultText, MESSAGE_TEXT_LIMIT_BYTES);
    return [
      {
        kind: 'turn-completed',
        payload: {
          outcome: isError ? 'error' : 'success',
          ...(isError && failure
            ? {
                providerFailure: {
                  ...failure,
                  safeToRetry:
                    failure.safeToRetry &&
                    (message.subtype === 'error_during_execution' || apiError) &&
                    !this.interactiveRequest &&
                    !denied &&
                    this.pendingTools.size === 0 &&
                    !pendingBackground,
                },
              }
            : {}),
          resultText: bounded.text,
          ...(bounded.truncated ? { truncated: true } : {}),
          ...(cost === undefined ? {} : { costUsd: cost }),
          turns,
          durationMs: duration,
        },
      },
    ];
  }

  private normalizeRateLimit(message: Record<string, unknown>): readonly NormalizedAgentEvent[] {
    const info = isRecord(message.rate_limit_info) ? message.rate_limit_info : {};
    if (info.status === 'allowed') {
      this.quotaResetsAt = undefined;
      return [];
    }
    // A warning for the rejected window means that allowance is usable again (R-C9 review).
    if (
      info.status === 'allowed_warning' &&
      (info.rateLimitType === undefined || info.rateLimitType === this.quotaWindow)
    )
      this.quotaResetsAt = undefined;
    if (info.status === 'rejected') {
      this.quotaWindow = info.rateLimitType;
      const seconds = info.resetsAt;
      // Epoch seconds; anything past year 5000 (e.g. milliseconds) is not a usable reset.
      this.quotaResetsAt =
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds < 1e11
          ? new Date(seconds * 1000).toISOString()
          : undefined;
    }
    return [
      {
        kind: 'notice',
        payload: {
          category: 'rate-limit',
          message: `Rate limit ${stringOf(info.status) || 'event'} (${stringOf(info.rateLimitType) || 'unknown window'})`,
        },
      },
    ];
  }
}
