import { MESSAGE_TEXT_LIMIT_BYTES, truncateUtf8 } from '../bounded.js';
import type {
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
  NormalizedAgentEvent,
} from '../index.js';
import { AsyncQueue, spawnSupervisedProcess, type SupervisedProcess } from '../process.js';
import { codexExecArguments, codexResumeArguments } from './arguments.js';
import type { CodexBackendOptions } from './backend.js';
import { CodexStreamNormalizer } from './normalize.js';

type SessionState =
  | { readonly phase: 'turn-running'; readonly child: SupervisedProcess }
  | { readonly phase: 'awaiting-input' }
  | { readonly phase: 'closed' };

/** An exec process ends a turn, not the operator's session. */
export class CodexSession implements AgentSession {
  private state: SessionState = { phase: 'awaiting-input' };
  private readonly queuedMessages: string[] = [];
  private endRequested = false;
  private killed = false;
  private readonly output = new AsyncQueue<AgentSessionItem>();
  private readonly normalizer: CodexStreamNormalizer;
  private readonly env: NodeJS.ProcessEnv;
  readonly items = this.output;
  get pid(): number | undefined {
    return this.state.phase === 'turn-running' ? this.state.child.pid : undefined;
  }

  constructor(
    private readonly options: CodexBackendOptions,
    private readonly request: AgentLaunchRequest,
  ) {
    this.env = options.env ?? process.env;
    this.normalizer = new CodexStreamNormalizer({
      cwd: request.cwd,
      permissionMode: request.permissionMode,
      ...(request.model === undefined ? {} : { requestedModel: request.model }),
      billing: this.env.OPENAI_API_KEY || this.env.CODEX_API_KEY ? 'api-key' : 'unknown',
    });
    if (request.appendSystemPrompt !== undefined)
      this.notice('Codex does not support an appended system prompt; it was ignored');
    if (request.maxBudgetUsd !== undefined)
      this.notice(
        `Codex does not support a budget cap; the request's $${request.maxBudgetUsd} limit was ignored`,
      );
    this.startTurn(request.prompt, request.resumeSessionId);
  }

  send(text: string): boolean {
    if (this.state.phase === 'closed' || this.endRequested || this.killed) return false;
    this.queuedMessages.push(text);
    if (this.state.phase === 'awaiting-input') this.startNextTurn();
    return true;
  }
  end(): void {
    this.endRequested = true;
    if (this.state.phase === 'awaiting-input') this.close(0, null);
  }
  kill(): void {
    if (this.state.phase === 'closed' || this.killed) return;
    this.killed = true;
    this.queuedMessages.length = 0;
    if (this.state.phase === 'turn-running') this.state.child.terminate();
    else this.close(null, 'SIGTERM');
  }
  private emit(event: NormalizedAgentEvent): void {
    this.output.push({ type: 'event', event });
  }
  private notice(message: string): void {
    this.emit({
      kind: 'notice',
      payload: { category: 'other', message: truncateUtf8(message, 4000).text },
    });
  }
  private close(exitCode: number | null, signal: string | null): void {
    if (this.state.phase === 'closed') return;
    this.state = { phase: 'closed' };
    this.queuedMessages.length = 0;
    this.output.push({ type: 'exited', exitCode, signal });
    this.output.close();
  }
  private startNextTurn(): void {
    const text = this.queuedMessages.shift();
    if (text !== undefined) this.startTurn(text, this.normalizer.threadId());
    else if (this.endRequested) this.close(0, null);
  }
  private startTurn(prompt: string, threadId?: string): void {
    this.normalizer.beginTurn();
    try {
      const child = spawnSupervisedProcess({
        executable: this.options.executable,
        args:
          threadId === undefined
            ? codexExecArguments(this.request)
            : codexResumeArguments(threadId, this.request),
        cwd: this.request.cwd,
        env: this.env,
        terminationGraceMs: this.options.terminationGraceMs ?? 5000,
        maxLineBytes: 4 * 1024 * 1024,
      });
      this.state = { phase: 'turn-running', child };
      child.write(prompt);
      child.endInput();
      void this.consume(child);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : 'Codex could not be started');
      this.close(1, null);
    }
  }
  private async consume(child: SupervisedProcess): Promise<void> {
    let stderrTail = '';
    for await (const item of child.items) {
      switch (item.type) {
        case 'stdout-line':
          for (const event of this.normalizer.normalizeLine(item.line)) this.emit(event);
          break;
        case 'stdout-overflow':
          this.notice(`Dropped a ${item.bytes}-byte backend line that exceeded the limit`);
          break;
        case 'stderr':
          stderrTail = truncateUtf8((stderrTail + item.text).slice(-8192), 8192).text;
          this.emit({ kind: 'stderr', payload: { text: truncateUtf8(item.text, 8192).text } });
          break;
        case 'exited':
          if (this.killed) {
            this.close(item.exitCode, item.signal ?? 'SIGTERM');
            return;
          }
          if (
            item.exitCode !== 0 ||
            !this.normalizer.turnEnded() ||
            this.normalizer.turnFailed() ||
            this.normalizer.threadId() === undefined
          ) {
            const message = stderrTail.trim() || 'Codex exited without completing the turn';
            if (!this.normalizer.turnEnded())
              this.notice('Codex process ended before completing its turn');
            if (!this.normalizer.turnEnded())
              this.emit({
                kind: 'turn-completed',
                payload: {
                  outcome: 'error',
                  resultText: truncateUtf8(message, MESSAGE_TEXT_LIMIT_BYTES).text,
                  turns: 0,
                  durationMs: 0,
                },
              });
            else if (!this.normalizer.turnFailed()) this.notice(message);
            this.close(
              item.exitCode === 0 || item.exitCode === null ? 1 : item.exitCode,
              item.signal,
            );
            return;
          }
          this.state = { phase: 'awaiting-input' };
          this.startNextTurn();
          return;
      }
    }
  }
}
