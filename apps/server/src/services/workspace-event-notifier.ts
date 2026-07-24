export interface WorkspaceEventWaitOptions {
  readonly generation: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

interface Waiter {
  readonly generation: number;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export class WorkspaceEventNotifier {
  private currentGeneration = 0;
  private readonly waiters = new Set<Waiter>();

  get generation(): number {
    return this.currentGeneration;
  }

  notify(): void {
    this.currentGeneration += 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.generation !== this.currentGeneration) {
        this.finish(waiter);
      }
    }
  }

  waitForChangeOrTimeout(options: WorkspaceEventWaitOptions): Promise<void> {
    if (options.signal.aborted || options.generation !== this.currentGeneration) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        generation: options.generation,
        resolve,
        signal: options.signal,
        timer: setTimeout(() => this.finish(waiter), options.timeoutMs),
        abort: () => this.finish(waiter),
      } satisfies Waiter;
      this.waiters.add(waiter);
      options.signal.addEventListener('abort', waiter.abort, { once: true });
      if (options.generation !== this.currentGeneration) {
        this.finish(waiter);
      }
    });
  }

  private finish(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  }
}
