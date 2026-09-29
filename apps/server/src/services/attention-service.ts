import { randomUUID } from 'node:crypto';
import type { AttentionFeed, AttentionItemView } from '@craftingtable/contracts';
import {
  type AttentionItem,
  asAuditEventId,
  INSTALLATION_ATTENTION_CODES,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext, CommandContext } from './auth-service.js';
import { ExecutionRequestError } from './errors.js';
import type { WorkspaceService } from './workspace-service.js';

/** The inbox path of one item; notification links open it (R-A5). */
export function inboxPath(workspaceId: WorkspaceId, itemId?: string): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/inbox`;
  return itemId === undefined ? base : `${base}/${encodeURIComponent(itemId)}`;
}

/**
 * The "Needs you" feed (R-A5): the workspace's open attention items, most blocking first,
 * then oldest. Every surface that says what needs the operator reads this, so the inbox,
 * the rail count, the dashboard and the roadmap page cannot disagree with the pushes.
 */
export class AttentionService {
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly projection: { flush(): void },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Acknowledges the protected ref moves the operator saw (R-G5 follow-up), all or none: a move
   * that is unknown or already acknowledged refuses the whole request, so one the operator has
   * not seen is never acknowledged with the others. The inbox item resolves in the same commit.
   */
  acknowledgeProtectedRefMoves(
    context: CommandContext,
    workspaceId: WorkspaceId,
    moveIds: readonly string[],
  ): { readonly acknowledged: number } {
    this.workspaces.requireRole(context, workspaceId, ['owner', 'editor']);
    const ids = [...new Set(moveIds)];
    const at = this.now().toISOString();
    this.storage.transaction((tx) => {
      const moves = ids.map((id) => tx.protectedRefs.find(workspaceId, id));
      if (moves.some((move) => move === undefined || move.acknowledgedAt !== undefined))
        throw new ExecutionRequestError(
          'conflict',
          'These moves changed since they were shown. Reload the item and acknowledge again.',
        );
      for (const id of ids)
        if (!tx.protectedRefs.acknowledge(workspaceId, id, at, context.user.id))
          throw new ExecutionRequestError('conflict', 'A move was acknowledged meanwhile.');
      tx.audit.append({
        id: asAuditEventId(randomUUID()),
        occurredAt: at,
        actorKind: 'user',
        actorUserId: context.user.id,
        ...(context.session ? { sessionId: context.session.id } : {}),
        workspaceId,
        action: 'protected-refs.acknowledged',
        targetType: 'workspace',
        targetId: workspaceId,
        outcome: 'succeeded',
        metadata: {
          moveIds: ids,
          repositoryIds: [...new Set(moves.map((move) => move!.repositoryId))],
        },
      });
    });
    return { acknowledged: ids.length };
  }

  feed(context: AuthContext, workspaceId: WorkspaceId): AttentionFeed {
    this.workspaces.requireAuthorized(context, workspaceId);
    this.projection.flush();
    return this.storage.readTransaction((tx) => {
      const installation = tx.maintenance.ownsInstallation(context.user.id);
      const items = tx.attention
        .open(workspaceId)
        .filter((item) => installation || !INSTALLATION_ATTENTION_CODES.has(item.code))
        .map((item) => view(item, this.blocks(tx, item)));
      return {
        items: items.sort((a, b) => b.blocks - a.blocks || a.openedAt.localeCompare(b.openedAt)),
      };
    });
  }

  /** How much work waits on an item: dependent plan items, roadmap entries or milestones. */
  private blocks(tx: StorageRepositories, item: AttentionItem): number {
    if (item.blocks !== undefined) return item.blocks;
    const { workItemId, roadmapId } = item.refs;
    if (workItemId) {
      // Work that cannot start until this item is done: required successors, transitively.
      const seen = new Set<string>([workItemId]);
      const queue = [workItemId as WorkItemId];
      while (queue.length) {
        for (const next of tx.planning.dependencies.listSuccessors(
          item.workspaceId,
          queue.pop()!,
        )) {
          if (next.kind !== 'required' || seen.has(next.workItemId) || next.status === 'completed')
            continue;
          seen.add(next.workItemId);
          queue.push(next.workItemId);
        }
      }
      return seen.size - 1;
    }
    if (roadmapId) {
      const roadmap = tx.roadmaps.find(item.workspaceId, roadmapId);
      if (!roadmap) return 0;
      return roadmap.definition.entries.filter(
        (entry) =>
          !roadmap.attempts.some((a) => a.entryId === entry.id && a.status === 'completed'),
      ).length;
    }
    return 0;
  }
}

function view(item: AttentionItem, blocks: number): AttentionItemView {
  return {
    id: item.id,
    subjectKey: item.subjectKey,
    code: item.code,
    kind: item.kind,
    title: item.title,
    message: item.message,
    path: item.path,
    inboxPath: inboxPath(item.workspaceId, item.id),
    refs: item.refs,
    ...(item.members ? { members: [...item.members] } : {}),
    ...(item.actions ? { actions: [...item.actions] } : {}),
    blocks,
    openedAt: item.openedAt,
    pushedAt: item.delivery.firstSentAt,
  };
}
