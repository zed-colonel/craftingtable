import type { AttentionFeed, AttentionItemView } from '@craftingtable/contracts';
import {
  type AttentionItem,
  INSTALLATION_ATTENTION_CODES,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
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
  ) {}

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
      const seen = new Set<string>();
      const queue = [workItemId as WorkItemId];
      while (queue.length) {
        for (const next of tx.planning.dependencies.listSuccessors(
          item.workspaceId,
          queue.pop()!,
        )) {
          if (seen.has(next.workItemId) || next.status === 'completed') continue;
          seen.add(next.workItemId);
          queue.push(next.workItemId);
        }
      }
      return seen.size;
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
