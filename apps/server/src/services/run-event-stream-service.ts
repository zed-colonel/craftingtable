import type { AgentRunEvent, AgentRunId, WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { AuthContext, AuthService } from './auth-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import {
  STREAM_REQUERY_INTERVAL_MS,
  type WorkspaceEventStreamHooks,
} from './workspace-event-stream-service.js';
import type { WorkspaceService } from './workspace-service.js';

export type RunStreamItem =
  | { readonly type: 'run-event'; readonly event: AgentRunEvent }
  | { readonly type: 'authentication-expired' };

/**
 * Cursor-driven live stream of one run's normalized events.
 *
 * Same discipline as the workspace stream: re-authenticate every iteration
 * without touching the session, re-check membership, and wake on the shared
 * notifier rather than polling tightly.
 */
export class RunEventStreamService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly authService: AuthService,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly hooks: WorkspaceEventStreamHooks = {},
  ) {}

  async *stream(input: {
    readonly rawSessionToken: string;
    readonly workspaceId: WorkspaceId;
    readonly runId: AgentRunId;
    readonly after: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<RunStreamItem> {
    let cursor = input.after;
    while (!input.signal.aborted) {
      let context: AuthContext;
      try {
        context = this.authService.authenticate(input.rawSessionToken, false);
      } catch {
        yield { type: 'authentication-expired' };
        return;
      }
      if (!this.workspaceService.isAuthorized(context, input.workspaceId)) {
        return;
      }
      const generation = this.notifier.generation;
      const events = this.storage.execution.runEvents.listAfter({
        workspaceId: input.workspaceId,
        runId: input.runId,
        after: cursor,
        limit: 200,
      });
      if (events.length > 0) {
        for (const event of events) {
          if (input.signal.aborted) {
            return;
          }
          yield { type: 'run-event', event };
          cursor = event.sequence;
        }
        continue;
      }
      await this.hooks.afterEmptyQuery?.();
      await this.notifier.waitForChangeOrTimeout({
        generation,
        timeoutMs: this.hooks.waitTimeoutMs ?? STREAM_REQUERY_INTERVAL_MS,
        signal: input.signal,
      });
    }
  }
}
