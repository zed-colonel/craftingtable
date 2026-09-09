import { isRecord, stringOf } from '../bounded.js';
import type { SupervisedProcess } from '../process.js';

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Correlation and deadlines only; responses (including account data) are never journaled. */
export class CodexRpc {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private readonly child: SupervisedProcess,
    private readonly timeoutMs: number,
  ) {}

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.write({ id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Codex app-server could not receive: ${method}`));
      }
    });
  }
  write(value: unknown): boolean {
    return !this.closed && this.child.write(`${JSON.stringify(value)}\n`);
  }
  accept(value: Record<string, unknown>): boolean {
    if ('method' in value) return false;
    if (typeof value.id !== 'number') throw new Error('Invalid Codex RPC response');
    const pending = this.pending.get(value.id);
    if (!pending) return true; // A timed-out optional request can still receive a late reply.
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (isRecord(value.error)) {
      pending.reject(
        new CodexRpcError(
          typeof value.error.code === 'number' ? value.error.code : -32603,
          stringOf(value.error.message) || 'Codex RPC request failed',
        ),
      );
    } else if ('result' in value) pending.resolve(value.result);
    else pending.reject(new Error('Invalid Codex RPC response'));
    return true;
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server exited'));
    }
    this.pending.clear();
  }
}
