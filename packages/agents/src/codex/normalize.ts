import type { AgentBillingSource, AgentPermissionMode } from '@craftingtable/domain';
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

export interface CodexNormalizerOptions {
  readonly permissionMode: AgentPermissionMode;
  readonly cwd: string;
  readonly requestedModel?: string;
  readonly billing: AgentBillingSource;
}

/** One thread across multiple exec processes; vendor item ids restart each turn. */
export class CodexStreamNormalizer {
  private id: string | undefined;
  private ended = false;
  private failed = false;
  private turns = 0;
  private startedAt = Date.now();
  private lastMessage = '';
  private readonly calls = new Set<string>();
  constructor(private readonly options: CodexNormalizerOptions) {}
  threadId(): string | undefined {
    return this.id;
  }
  turnEnded(): boolean {
    return this.ended;
  }
  turnFailed(): boolean {
    return this.failed;
  }
  beginTurn(): void {
    this.ended = false;
    this.failed = false;
    this.lastMessage = '';
    this.startedAt = Date.now();
    this.calls.clear();
  }

  normalizeLine(line: string): readonly NormalizedAgentEvent[] {
    if (line.trim() === '') return [];
    const raw = boundedRaw(line);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [this.notice(`Unparseable backend output: ${firstLine(line, 500)}`, raw)];
    }
    if (!isRecord(value)) return [this.notice('Unknown backend output', raw)];
    switch (value.type) {
      case 'thread.started': {
        const id = stringOf(value.thread_id);
        if (!id || id.length > 200) return [this.notice('Invalid Codex thread id', raw)];
        if (this.id !== undefined)
          return id === this.id ? [] : [this.notice('Codex returned a different thread id', raw)];
        this.id = id;
        return [
          {
            kind: 'session-started',
            payload: {
              backend: 'codex',
              backendSessionId: id,
              model: (this.options.requestedModel || 'default').slice(0, 100),
              permissionMode: this.options.permissionMode,
              cwd: this.options.cwd,
              billing: this.options.billing,
            },
            raw,
          },
        ];
      }
      case 'turn.started':
        this.beginTurn();
        return [];
      case 'turn.completed':
      case 'turn.failed': {
        if (this.ended) return [];
        this.ended = true;
        this.failed = value.type === 'turn.failed';
        this.turns += 1;
        return [
          {
            kind: 'turn-completed',
            payload: {
              outcome: this.failed ? 'error' : 'success',
              resultText: this.failed
                ? truncateUtf8(
                    isRecord(value.error) ? stringOf(value.error.message) : 'Codex turn failed',
                    MESSAGE_TEXT_LIMIT_BYTES,
                  ).text
                : this.lastMessage,
              turns: this.turns,
              durationMs: Math.max(0, Date.now() - this.startedAt),
            },
            raw,
          },
        ];
      }
      case 'error':
        return [this.notice(stringOf(value.message) || 'Codex error', raw)];
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (isRecord(value.item))
          return this.item(value.item, value.type === 'item.completed', raw);
        return [this.notice('Missing backend item', raw)];
      default:
        return [
          this.notice(`Backend message: ${firstLine(stringOf(value.type) || 'unknown')}`, raw),
        ];
    }
  }

  private notice(message: string, raw: string): NormalizedAgentEvent {
    return {
      kind: 'notice',
      payload: {
        category: /rate.?limit|usage limit|too many requests/i.test(message)
          ? 'rate-limit'
          : 'other',
        message: truncateUtf8(message, 4000).text,
      },
      raw,
    };
  }

  private item(
    item: Record<string, unknown>,
    completed: boolean,
    raw: string,
  ): readonly NormalizedAgentEvent[] {
    const type = stringOf(item.type);
    if (type === 'reasoning' || type === 'todo_list') return [];
    if (type === 'agent_message') {
      if (!completed) return [];
      this.lastMessage = truncateUtf8(stringOf(item.text), MESSAGE_TEXT_LIMIT_BYTES).text;
      return [{ kind: 'assistant-message', payload: { text: this.lastMessage }, raw }];
    }
    if (type === 'error') return completed ? [this.notice(stringOf(item.message), raw)] : [];
    // Prefix with the turn because exec resume restarts item ids at item_0.
    const toolUseId = `${this.turns + 1}:${stringOf(item.id) || 'unknown'}`.slice(0, 200);
    let name: string;
    let input: unknown;
    let summary: string;
    let output = '';
    let isError = item.status === 'failed';
    switch (type) {
      case 'command_execution':
        name = 'command';
        input = { command: stringOf(item.command) };
        summary = `Run: ${firstLine(stringOf(item.command))}`;
        output = stringOf(item.aggregated_output);
        isError ||= completed && item.exit_code !== 0;
        break;
      case 'file_change': {
        name = 'file-change';
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
        input = { changes };
        summary = firstLine(
          `Edited ${changes.length} files: ${changes.map((change) => stringOf(change.path)).join(', ')}`,
          1900,
        );
        break;
      }
      case 'mcp_tool_call':
        name = `${stringOf(item.server)}/${stringOf(item.tool)}`.slice(0, 200);
        input = item.arguments ?? null;
        summary = name;
        output = JSON.stringify(item.result ?? item.error ?? null);
        isError ||= item.error != null || (isRecord(item.result) && item.result.isError === true);
        break;
      case 'web_search':
        name = 'web-search';
        input = { query: stringOf(item.query) };
        summary = firstLine(stringOf(item.query));
        break;
      default:
        return [this.notice(`Backend item: ${firstLine(type || 'unknown')}`, raw)];
    }
    const events: NormalizedAgentEvent[] = [];
    if (!this.calls.has(toolUseId)) {
      this.calls.add(toolUseId);
      events.push({
        kind: 'tool-call',
        payload: { toolUseId, name, input: boundedJson(input, TOOL_INPUT_LIMIT_BYTES), summary },
        raw,
      });
    }
    if (completed) {
      const bounded = truncateUtf8(output, TOOL_RESULT_LIMIT_BYTES);
      events.push({
        kind: 'tool-result',
        payload: { toolUseId, content: bounded.text, isError, truncated: bounded.truncated },
        raw,
      });
    }
    return events;
  }
}
