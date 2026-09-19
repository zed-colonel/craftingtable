export interface WorkspaceEventWaitOptions {
  readonly generation: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly channel?: 'workflow';
}

interface Waiter {
  readonly channel?: 'workflow';
  readonly generation: number;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export class WorkspaceEventNotifier {
  private currentGeneration = 0;
  private currentWorkflowGeneration = 0;
  private readonly waiters = new Set<Waiter>();

  get generation(): number {
    return this.currentGeneration;
  }

  get workflowGeneration(): number {
    return this.currentWorkflowGeneration;
  }

  notify(kind: 'workflow' | 'activity' = 'workflow'): void {
    this.currentGeneration += 1;
    if (kind === 'workflow') this.currentWorkflowGeneration += 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.generation !== this.generationFor(waiter.channel)) {
        this.finish(waiter);
      }
    }
  }

  waitForChangeOrTimeout(options: WorkspaceEventWaitOptions): Promise<void> {
    if (options.signal.aborted || options.generation !== this.generationFor(options.channel)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        ...(options.channel ? { channel: options.channel } : {}),
        generation: options.generation,
        resolve,
        signal: options.signal,
        timer: setTimeout(() => this.finish(waiter), options.timeoutMs),
        abort: () => this.finish(waiter),
      } satisfies Waiter;
      this.waiters.add(waiter);
      options.signal.addEventListener('abort', waiter.abort, { once: true });
      if (options.generation !== this.generationFor(options.channel)) {
        this.finish(waiter);
      }
    });
  }

  private generationFor(channel?: 'workflow'): number {
    return channel === 'workflow' ? this.currentWorkflowGeneration : this.currentGeneration;
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
