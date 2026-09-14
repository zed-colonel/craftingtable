import type { AgentBillingSource } from '@craftingtable/domain';
import { isRecord, stringOf, truncateUtf8 } from '../bounded.js';
import type {
  AgentLaunchRequest,
  AgentSession,
  AgentSessionItem,
  NormalizedAgentEvent,
} from '../index.js';
import { AsyncQueue, type SupervisedProcess, spawnSupervisedProcess } from '../process.js';
import { codexThreadParams, codexTurnParams } from './arguments.js';
import type { CodexBackendOptions } from './backend.js';
import { CodexStreamNormalizer } from './normalize.js';
import { CodexRpc, CodexRpcError } from './rpc.js';

/** A single local app-server owns the thread for the entire operator session. */
export class CodexSession implements AgentSession {
  private readonly child: SupervisedProcess;
  private readonly rpc: CodexRpc;
  private readonly output = new AsyncQueue<AgentSessionItem>();
  private readonly normalizer: CodexStreamNormalizer;
  private readonly queued: string[] = [];
  private readonly completedTurns = new Set<string>();
  private threadId: string | undefined;
  private activeTurn: string | undefined;
  private model = 'default';
  private configuredModel = 'default';
  private ready = false;
  private pumping = false;
  private pumpAgain = false;
  private completing = false;
  private endRequested = false;
  private killed = false;
  private failed = false;
  private closed = false;
  private closing = false;
  private shutdownTimer: NodeJS.Timeout | undefined;
  readonly items = this.output;
  get pid(): number | undefined {
    return this.closed ? undefined : this.child.pid;
  }

  constructor(
    private readonly options: CodexBackendOptions,
    private readonly request: AgentLaunchRequest,
  ) {
    this.normalizer = new CodexStreamNormalizer(request.resumeSessionId !== undefined);
    this.child = spawnSupervisedProcess({
      executable: options.executable,
      args: ['app-server', '--stdio'],
      cwd: request.cwd,
      env: {
        ...(options.env ?? process.env),
        ...(request.temporaryDirectory
          ? {
              TMPDIR: request.temporaryDirectory,
              TMP: request.temporaryDirectory,
              TEMP: request.temporaryDirectory,
            }
          : {}),
      },
      terminationGraceMs: options.terminationGraceMs ?? 5000,
      maxLineBytes: 4 * 1024 * 1024,
    });
    this.rpc = new CodexRpc(this.child, options.requestTimeoutMs ?? 30000);
    void this.consume().catch((error) => this.fail(error));
    void this.initialize().catch((error) => this.fail(error));
  }
  send(text: string): boolean {
    if (this.closed || this.endRequested || this.killed || this.failed) return false;
    this.queued.push(text);
    void this.pump();
    return true;
  }
  end(): void {
    this.endRequested = true;
    void this.pump();
  }
  kill(): void {
    if (this.closed || this.killed) return;
    this.killed = true;
    this.queued.length = 0;
    if (this.activeTurn && this.threadId) {
      void this.rpc
        .request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurn }, 1000)
        .catch(() => {})
        .finally(() => {
          if (!this.closed) this.terminate();
        });
    } else this.terminate();
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
  private fail(error: unknown): void {
    if (this.closed || this.killed || this.failed) return;
    this.failed = true;
    this.notice(error instanceof Error ? error.message : 'Codex app-server failed');
    this.queued.length = 0;
    this.terminate();
  }
  private terminating = false;
  private terminate(): void {
    if (this.terminating || this.closed) return;
    this.terminating = true;
    this.child.terminate();
  }
  private async initialize(): Promise<void> {
    await this.rpc.request('initialize', {
      clientInfo: { name: 'craftingtable', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (this.killed || this.closed) return;
    if (!this.rpc.write({ method: 'initialized' })) throw new Error('Codex initialization failed');
    let billing: AgentBillingSource = 'unknown';
    // Read only the authentication mode. Never retain account identities or credentials.
    const account = await this.rpc.request('account/read', { refreshToken: false });
    if (isRecord(account) && isRecord(account.account)) {
      if (account.account.type === 'chatgpt') billing = 'subscription';
      if (account.account.type === 'apiKey') billing = 'api-key';
    }
    if (this.killed || this.closed) return;
    const resume = this.request.resumeSessionId;
    const result = await this.rpc.request(resume ? 'thread/resume' : 'thread/start', {
      ...codexThreadParams(this.request),
      ...(resume ? { threadId: resume, excludeTurns: true } : {}),
    });
    if (this.killed || this.closed) return;
    if (!isRecord(result) || !isRecord(result.thread)) throw new Error('Codex returned no thread');
    const id = stringOf(result.thread.id);
    const model = stringOf(result.model);
    if (!id || id.length > 200 || !model || model.length > 100 || (resume && id !== resume)) {
      throw new Error('Codex returned invalid thread metadata');
    }
    this.threadId = id;
    this.model = model;
    this.configuredModel = model;
    this.emit({
      kind: 'session-started',
      payload: {
        backend: 'codex',
        backendSessionId: id,
        model,
        billing,
        cwd: this.request.cwd,
        permissionMode: this.request.permissionMode,
      },
    });
    if (this.request.sessionName) {
      await this.rpc.request('thread/name/set', { threadId: id, name: this.request.sessionName });
    }
    if (this.request.maxBudgetUsd !== undefined)
      this.notice(
        'Codex does not enforce a dollar budget cap; the requested cap cannot be applied',
      );
    await this.startTurn(this.request.prompt);
    this.ready = true;
    void this.pump();
  }
  private async startTurn(text: string): Promise<void> {
    if (this.killed || this.closed || this.failed) return;
    const result = await this.rpc.request('turn/start', {
      ...codexTurnParams(this.request),
      threadId: this.threadId,
      input: [{ type: 'text', text }],
    });
    if (!isRecord(result) || !isRecord(result.turn) || !stringOf(result.turn.id)) {
      throw new Error('Codex returned no turn');
    }
    this.beginTurn(stringOf(result.turn.id));
  }
  private beginTurn(id: string): void {
    if (this.completedTurns.has(id) || this.activeTurn === id) return;
    if (this.activeTurn !== undefined) throw new Error('Codex started overlapping turns');
    this.activeTurn = id;
    this.model = this.configuredModel;
    this.normalizer.beginTurn();
  }
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    if (!this.ready || this.completing || this.closed || this.killed || this.failed) return;
    this.pumping = true;
    try {
      while (this.queued.length && !this.killed && !this.closed && !this.completing) {
        const text = this.queued.shift();
        if (text === undefined) break;
        const turnId = this.activeTurn;
        if (!turnId) await this.startTurn(text);
        else {
          try {
            await this.rpc.request('turn/steer', {
              threadId: this.threadId,
              expectedTurnId: turnId,
              input: [{ type: 'text', text }],
            });
          } catch (error) {
            // Only an explicit stale-turn rejection is safe to retry. A timeout may have delivered input.
            if (
              error instanceof CodexRpcError &&
              /no active turn|turn.*(?:mismatch|does not match|not active|not found)|expected.*turn/i.test(
                error.message,
              )
            ) {
              this.queued.unshift(text);
              if (this.activeTurn === turnId) break;
            } else throw error;
          }
        }
      }
      if (this.endRequested && !this.activeTurn && !this.queued.length && !this.completing)
        this.shutdown();
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        void this.pump();
      }
    }
  }
  private shutdown(): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.child.endInput();
    this.shutdownTimer = setTimeout(
      () => this.terminate(),
      this.options.terminationGraceMs ?? 5000,
    );
  }
  private async complete(turn: Record<string, unknown>): Promise<void> {
    this.completing = true;
    let costUsd: number | undefined;
    if (!this.killed && turn.status === 'completed') {
      // This optional capability is account/version dependent. Absence is not zero dollars.
      try {
        const usage = await this.rpc.request(
          'account/usage/read',
          { threadId: this.threadId },
          Math.min(this.options.requestTimeoutMs ?? 2000, 2000),
        );
        if (
          isRecord(usage) &&
          isRecord(usage.threadUsage) &&
          usage.threadUsage.threadId === this.threadId
        ) {
          const micros = usage.threadUsage.estimatedUsageUsdMicros;
          if (typeof micros === 'number' && Number.isSafeInteger(micros) && micros >= 0)
            costUsd = micros / 1_000_000;
        }
      } catch {
        /* Optional telemetry must not turn successful work into a failure. */
      }
    }
    this.emit(this.normalizer.complete(turn, this.model, costUsd));
    this.completing = false;
    if (turn.status !== 'completed' && !this.killed)
      this.fail(new Error(`Codex turn ${stringOf(turn.status)}`));
    else void this.pump();
  }
  private notification(method: string, params: Record<string, unknown>): void {
    if (!this.threadId || params.threadId !== this.threadId) return;
    if (method === 'turn/started' && isRecord(params.turn)) {
      const id = stringOf(params.turn.id);
      if (!id || id.length > 200) throw new Error('Invalid Codex turn id');
      this.beginTurn(id);
      return;
    }
    if (method === 'turn/completed' && isRecord(params.turn)) {
      const id = stringOf(params.turn.id);
      if (this.completedTurns.has(id)) return;
      if (
        id !== this.activeTurn ||
        !['completed', 'failed', 'interrupted'].includes(stringOf(params.turn.status))
      )
        throw new Error('Invalid Codex turn completion');
      this.completedTurns.add(id);
      this.activeTurn = undefined;
      void this.complete(params.turn).catch((error) => this.fail(error));
      return;
    }
    if (params.turnId !== undefined && params.turnId !== this.activeTurn) return;
    if (method === 'model/rerouted') {
      const model = stringOf(params.toModel);
      if (model && model.length <= 100) {
        this.notice(`Codex changed model from ${this.model} to ${model}`);
        this.model = model;
      }
    }
    for (const event of this.normalizer.normalize(method, params)) this.emit(event);
  }
  private serverRequest(value: Record<string, unknown>): void {
    const method = stringOf(value.method);
    let result: unknown;
    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    )
      result = { decision: 'decline' };
    else if (method === 'item/permissions/requestApproval')
      result = { permissions: {}, scope: 'turn' };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'mcpServer/elicitation/request')
      result = { action: 'decline', content: null, _meta: null };
    this.rpc.write(
      result === undefined
        ? {
            id: value.id,
            error: { code: -32601, message: 'Client request is not supported by CraftingTable' },
          }
        : { id: value.id, result },
    );
    this.notice(`Codex requested ${method}; no interactive approval or answer was supplied`);
  }
  private async consume(): Promise<void> {
    for await (const item of this.child.items) {
      if (item.type === 'exited') {
        this.closed = true;
        if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
        this.rpc.close();
        const unexpected = !this.closing && !this.killed;
        if (unexpected && !this.failed)
          this.notice('Codex app-server exited before the session was ended');
        this.output.push({
          type: 'exited',
          exitCode:
            this.failed || unexpected
              ? item.exitCode || 1
              : this.closing &&
                  !this.killed &&
                  this.terminating &&
                  (item.signal === 'SIGTERM' || item.signal === 'SIGKILL')
                ? 0
                : item.exitCode,
          signal: this.killed
            ? (item.signal ?? 'SIGTERM')
            : this.closing && !this.failed
              ? null
              : item.signal,
        });
        this.output.close();
        return;
      }
      if (item.type === 'background-work-waiting') continue;
      if (item.type === 'stderr') {
        this.emit({ kind: 'stderr', payload: { text: truncateUtf8(item.text, 8192).text } });
        continue;
      }
      if (this.failed || this.killed) {
        // Responses still release interrupt requests during cancellation.
        if (item.type === 'stdout-line') {
          try {
            const value: unknown = JSON.parse(item.line);
            if (isRecord(value) && !('method' in value)) this.rpc.accept(value);
          } catch {
            /* Already terminating. */
          }
        }
        continue;
      }
      try {
        if (item.type === 'stdout-overflow')
          throw new Error(`Codex protocol message exceeded the limit (${item.bytes} bytes)`);
        const value: unknown = JSON.parse(item.line);
        if (!isRecord(value)) throw new Error('Invalid Codex protocol message');
        if (this.rpc.accept(value)) continue;
        if ('id' in value) this.serverRequest(value);
        else if (typeof value.method === 'string' && isRecord(value.params))
          this.notification(value.method, value.params);
        else throw new Error('Invalid Codex notification');
      } catch (error) {
        this.fail(error);
      }
    }
  }
}
