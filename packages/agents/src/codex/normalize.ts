import { codexProviderFailure } from './provider-failure.js';
import type { ProviderFailure, AgentRunEventPayloads } from '@craftingtable/domain';
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
import type { NormalizedAgentEvent } from '../index.js';

/**
 * App-server items that neither run a tool nor delegate work (generated `ThreadItem` schema):
 * a timed wait, a proposed plan, an image the model viewed and review-mode markers. They carry
 * no side effect whose completion the adapter must prove, so they never make a failed turn
 * unsafe to retry, and they are not journaled.
 */
const INFORMATIONAL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'sleep',
  'plan',
  'imageView',
  'enteredReviewMode',
  'exitedReviewMode',
]);

const UNKNOWN_REPORT_LIMIT = 64;

/** Only the selected thread's notifications reach this adapter-local normalizer. */
export class CodexStreamNormalizer {
  private turns = 0;
  private failure: ProviderFailure | undefined;
  private unsafeContinuation = false;
  private readonly pendingTools = new Set<string>();
  requireOperator(): void {
    this.unsafeContinuation = true;
  }
  private startedAt = Date.now();
  private lastMessage = '';
  private lastMessageTruncated = false;
  private usage: AgentRunEventPayloads['turn-completed']['tokenUsage'];
  private totalUsage: AgentRunEventPayloads['turn-completed']['tokenUsage'];
  private baselineUsage: AgentRunEventPayloads['turn-completed']['tokenUsage'];
  private readonly calls = new Set<string>();
  private readonly completedItems = new Set<string>();
  /** Unrecognized item types already reported once in this run. */
  private readonly reportedUnknownItems = new Set<string>();
  constructor(resumed = false) {
    if (!resumed)
      this.totalUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };
  }
  beginTurn(): void {
    this.failure = undefined;
    this.unsafeContinuation = false;
    this.pendingTools.clear();
    this.lastMessage = '';
    this.lastMessageTruncated = false;
    this.usage = undefined;
    this.baselineUsage = this.totalUsage;
    this.startedAt = Date.now();
    this.calls.clear();
    this.completedItems.clear();
  }
  normalize(method: string, params: Record<string, unknown>): readonly NormalizedAgentEvent[] {
    // The notification travels with an event only when this adapter cannot represent it (R-H2).
    const raw = () => boundedRaw(JSON.stringify({ method, params }));
    if (method === 'thread/tokenUsage/updated') {
      const last = isRecord(params.tokenUsage) ? params.tokenUsage.last : undefined;
      const total = isRecord(params.tokenUsage) ? params.tokenUsage.total : undefined;
      const keys = [
        'inputTokens',
        'cachedInputTokens',
        'outputTokens',
        'reasoningOutputTokens',
        'totalTokens',
      ] as const;
      if (
        isRecord(last) &&
        isRecord(total) &&
        keys.every(
          (key) =>
            Number.isSafeInteger(last[key]) &&
            (last[key] as number) >= 0 &&
            Number.isSafeInteger(total[key]) &&
            (total[key] as number) >= (last[key] as number),
        )
      ) {
        // `last` is one model response, not an operator turn. Cumulative differences
        // include every tool iteration and are insensitive to repeated snapshots.
        const baseline =
          this.baselineUsage ??
          (Object.fromEntries(
            keys.map((key) => [key, (total[key] as number) - (last[key] as number)]),
          ) as NonNullable<typeof this.usage>);
        if (keys.every((key) => (total[key] as number) >= baseline[key])) {
          this.baselineUsage = baseline;
          this.totalUsage = Object.fromEntries(keys.map((key) => [key, total[key]])) as NonNullable<
            typeof this.usage
          >;
          this.usage = Object.fromEntries(
            keys.map((key) => [key, (total[key] as number) - baseline[key]]),
          ) as NonNullable<typeof this.usage>;
        }
      }
      return [];
    }
    if ((method === 'item/started' || method === 'item/completed') && isRecord(params.item)) {
      const completed = method === 'item/completed';
      const id = stringOf(params.item.id);
      if (!id || this.completedItems.has(id)) return [];
      if (completed) this.completedItems.add(id);
      if (params.item.type === 'contextCompaction') {
        return completed
          ? [
              {
                kind: 'notice',
                payload: { category: 'compaction', message: 'Codex compacted the conversation' },
              },
            ]
          : [];
      }
      return this.item(params.item, completed, raw);
    }
    if (method === 'error') {
      const failure = codexProviderFailure(
        isRecord(params.error) ? params.error.codexErrorInfo : undefined,
      );
      this.failure = { ...failure, safeToRetry: failure.safeToRetry && params.willRetry === false };
      return [this.notice(isRecord(params.error) ? stringOf(params.error.message) : 'Codex error')];
    }
    if (method === 'turn/plan/updated') {
      return [this.notice(`Plan: ${JSON.stringify(boundedJson(params.plan, 3500))}`)];
    }
    // Deltas are transient; completed items provide bounded, replayable messages/results.
    return [];
  }
  complete(turn: Record<string, unknown>, model: string, costUsd?: number): NormalizedAgentEvent {
    this.turns += 1;
    const failed = turn.status !== 'completed';
    const result = failed
      ? truncateUtf8(
          (isRecord(turn.error) ? stringOf(turn.error.message) : '') ||
            `Codex turn ${stringOf(turn.status)}`,
          MESSAGE_TEXT_LIMIT_BYTES,
        )
      : { text: this.lastMessage, truncated: this.lastMessageTruncated };
    return {
      kind: 'turn-completed',
      payload: {
        outcome: failed ? 'error' : 'success',
        ...(failed
          ? {
              providerFailure: {
                ...(this.failure ??
                  codexProviderFailure(
                    isRecord(turn.error) ? turn.error.codexErrorInfo : undefined,
                  )),
                safeToRetry:
                  turn.status === 'failed' &&
                  (
                    this.failure ??
                    codexProviderFailure(
                      isRecord(turn.error) ? turn.error.codexErrorInfo : undefined,
                    )
                  ).safeToRetry &&
                  !this.unsafeContinuation &&
                  this.pendingTools.size === 0,
              },
            }
          : {}),
        resultText: result.text,
        ...(result.truncated ? { truncated: true } : {}),
        turns: this.turns,
        durationMs: Math.max(0, Date.now() - this.startedAt),
        model,
        ...(this.usage === undefined ? {} : { tokenUsage: this.usage }),
        ...(costUsd === undefined ? {} : { costUsd }),
      },
    };
  }
  private notice(message: string, raw?: string): NormalizedAgentEvent {
    return {
      kind: 'notice',
      payload: {
        category: /rate.?limit|usage limit|too many requests/i.test(message)
          ? 'rate-limit'
          : 'other',
        message: truncateUtf8(message, 4000).text,
      },
      ...(raw === undefined ? {} : { raw }),
    };
  }

  private item(
    item: Record<string, unknown>,
    completed: boolean,
    raw: () => string,
  ): readonly NormalizedAgentEvent[] {
    const type = stringOf(item.type);
    if (type === 'reasoning' || type === 'userMessage' || INFORMATIONAL_ITEM_TYPES.has(type))
      return [];
    if (type === 'agentMessage') {
      if (!completed) return [];
      const bounded = truncateUtf8(stringOf(item.text), MESSAGE_TEXT_LIMIT_BYTES);
      this.lastMessage = bounded.text;
      this.lastMessageTruncated = bounded.truncated;
      return [
        {
          kind: 'assistant-message',
          payload: { text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) },
        },
      ];
    }
    if (type === 'error') return completed ? [this.notice(stringOf(item.message))] : [];
    // Scope vendor ids to a turn, including tools from resumed sessions.
    const toolUseId = `${this.turns + 1}:${stringOf(item.id) || 'unknown'}`.slice(0, 200);
    let name: string;
    let input: unknown;
    let summary: string;
    let output = '';
    let isError = item.status === 'failed' || item.status === 'declined';
    switch (type) {
      case 'commandExecution':
        name = 'command';
        input = { command: stringOf(item.command) };
        summary = `Run: ${firstLine(stringOf(item.command))}`;
        output = stringOf(item.aggregatedOutput);
        isError ||= completed && typeof item.exitCode === 'number' && item.exitCode !== 0;
        break;
      case 'fileChange': {
        name = 'file-change';
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
        input = { changes };
        summary = firstLine(
          `Edited ${changes.length} files: ${changes.map((change) => stringOf(change.path)).join(', ')}`,
          1900,
        );
        break;
      }
      case 'mcpToolCall':
        name = `${stringOf(item.server)}/${stringOf(item.tool)}`.slice(0, 200);
        input = item.arguments ?? null;
        summary = name;
        {
          const result = boundedJson(
            item.result ?? item.error ?? null,
            TOOL_RESULT_LIMIT_BYTES * 2,
          );
          output = typeof result === 'string' ? result : JSON.stringify(result);
        }

        isError ||= item.error != null || (isRecord(item.result) && item.result.isError === true);
        break;
      case 'dynamicToolCall':
      case 'collabAgentToolCall':
        // Delegated work can outlive a completed spawn/wait call. Require an operator
        // until this adapter can prove every delegated agent has reached a terminal state.
        if (type === 'collabAgentToolCall') this.unsafeContinuation = true;
        name = stringOf(item.tool) || type;
        input = item.arguments ?? item.prompt ?? null;
        summary = name;
        output = JSON.stringify(
          boundedJson(item.contentItems ?? item.agentsStates ?? null, TOOL_RESULT_LIMIT_BYTES * 2),
        );
        isError ||= item.success === false;
        break;
      case 'webSearch':
        name = 'web-search';
        input = { query: stringOf(item.query) };
        summary = firstLine(stringOf(item.query));
        break;
      default: {
        // An unrecognized item may be a new kind of tool or delegated work whose terminal state
        // this adapter cannot prove, so the turn stays ineligible for automatic retry. Report
        // each unknown type once per run rather than once per item.
        this.unsafeContinuation = true;
        const label = firstLine(type || 'unknown', 100);
        if (
          !completed ||
          this.reportedUnknownItems.has(label) ||
          this.reportedUnknownItems.size >= UNKNOWN_REPORT_LIMIT
        )
          return [];
        this.reportedUnknownItems.add(label);
        return [this.notice(`Backend item: ${label}`, raw())];
      }
    }
    const events: NormalizedAgentEvent[] = [];
    if (!this.calls.has(toolUseId)) {
      this.calls.add(toolUseId);
      this.pendingTools.add(toolUseId);
      events.push({
        kind: 'tool-call',
        payload: { toolUseId, name, input: boundedJson(input, TOOL_INPUT_LIMIT_BYTES), summary },
      });
    }
    if (completed) {
      this.pendingTools.delete(toolUseId);
      const bounded = truncateUtf8(output, TOOL_RESULT_LIMIT_BYTES);
      events.push({
        kind: 'tool-result',
        payload: { toolUseId, content: bounded.text, isError, truncated: bounded.truncated },
      });
    }
    return events;
  }
}
