import type { AgentBackend } from '@craftingtable/agents';
import type { AgentBackendKind } from '@craftingtable/domain';
import type { RunLog } from './agent-run-service.js';

/** How often the daemon reads each CLI's model catalog again (R-G15): about hourly. */
export const MODEL_CATALOG_REFRESH_MS = 60 * 60 * 1000;

/**
 * Keeps each backend's model list current (R-G15): read at daemon start, about hourly after,
 * and when the operator asks. The lists reach the browser through the execution status, so a
 * model added to a CLI's catalog is offered by the next refresh with no code or configuration
 * change. A refresh never blocks the start, and a failed one keeps the list in use.
 */
export class ModelCatalogService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly backends: ReadonlyMap<AgentBackendKind, AgentBackend>,
    private readonly log: RunLog = { warn: () => undefined },
    private readonly intervalMs = MODEL_CATALOG_REFRESH_MS,
  ) {}

  /** Reads every catalog now, then on the interval, until `stop`. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads every backend's catalog; settles once each look has, whatever it found. */
  async refresh(): Promise<void> {
    await Promise.all(
      [...this.backends.values()].map(async (backend) => {
        try {
          const { status, detail } = await backend.listModels();
          if (status.issue !== undefined)
            this.log.warn('A model catalog was not fully read', {
              backend: backend.kind,
              issue: status.issue,
              source: status.source,
              ...(detail === undefined ? {} : { detail }),
            });
        } catch (error) {
          this.log.warn('A model catalog could not be read', {
            backend: backend.kind,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }
}
