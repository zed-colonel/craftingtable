import type { WorkspaceEvent, WorkspaceId } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { OperatorPresence } from './attention-gates.js';
import type { AuthContext, AuthService } from './auth-service.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

export type WorkspaceStreamItem =
  | { readonly type: 'workspace-event'; readonly event: WorkspaceEvent }
  | { readonly type: 'authentication-expired' };

export interface WorkspaceEventStreamHooks {
  readonly afterEmptyQuery?: () => void | Promise<void>;
  readonly waitTimeoutMs?: number;
}

/**
 * How long a stream waits on its channels before it re-queries and re-authenticates by itself
 * (R-B5 decision 12): a membership lost out of band is found then. A notification of its
 * workspace's or run's events, or its session's revocation, wakes it at once.
 */
export const STREAM_FALLBACK_MS = 30_000;

export class WorkspaceEventStreamService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly authService: AuthService,
    private readonly workspaceService: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly hooks: WorkspaceEventStreamHooks = {},
    private readonly presence?: OperatorPresence,
  ) {}

  async *stream(input: {
    readonly rawSessionToken: string;
    readonly workspaceId: WorkspaceId;
    readonly after: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<WorkspaceStreamItem> {
    let cursor = input.after;
    // An open stream means the operator is watching this workspace (NOTIF-04).
    let watching: AuthContext['user']['id'] | undefined;
    try {
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
        if (watching === undefined) {
          watching = context.user.id;
          this.presence?.opened(input.workspaceId, watching);
        }

        // Taken before the query: a commit between it and the wait wakes the wait at once.
        const after = this.notifier.keySequence;
        const events = this.storage.workspaceEvents.listAfter({
          workspaceId: input.workspaceId,
          after: cursor,
          limit: 100,
        });
        if (events.length > 0) {
          for (const event of events) {
            if (input.signal.aborted) {
              return;
            }
            yield { type: 'workspace-event', event };
            cursor = event.sequence;
          }
          continue;
        }

        await this.hooks.afterEmptyQuery?.();
        await this.notifier.waitForKeys({
          keys: [`workspace:${input.workspaceId}`, `session:${context.session.id}`],
          after,
          timeoutMs: this.authService.streamWaitMs(
            context.session,
            this.hooks.waitTimeoutMs ?? STREAM_FALLBACK_MS,
          ),
          signal: input.signal,
        });
      }
    } finally {
      if (watching !== undefined) this.presence?.closed(input.workspaceId, watching);
    }
  }
}

export function parseEventCursor(value: unknown, label: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return cursor;
}

export function selectEventCursor(after: unknown, lastEventId: unknown): number {
  return Math.max(
    parseEventCursor(after, 'after') ?? 0,
    parseEventCursor(lastEventId, 'Last-Event-ID') ?? 0,
  );
}
