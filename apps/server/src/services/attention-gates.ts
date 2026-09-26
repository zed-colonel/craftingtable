import type { UserId, WorkspaceId } from '@craftingtable/domain';

/**
 * Controller quiescence (NOTIF-01, R-A4). Each controller worker brackets its passes; an
 * attention item may be pushed only once every running worker has completed a pass that
 * began after the item opened. By then any automation that takes the stop over has had its
 * chance to do so, so the operator is not paged for a state the daemon leaves by itself.
 */
export class ControllerPasses {
  private sequence = 0;
  /** Per running worker: the start of its latest completed pass. */
  private readonly workers = new Map<string, number>();

  /** The latest pass start; an item records it when it opens. */
  get current(): number {
    return this.sequence;
  }
  /** A worker's loop started; its passes gate pushes until it stops. */
  register(worker: string): void {
    if (!this.workers.has(worker)) this.workers.set(worker, -1);
  }
  unregister(worker: string): void {
    this.workers.delete(worker);
  }
  /** Returns the pass's start, which `completed` takes back. */
  started(): number {
    this.sequence += 1;
    return this.sequence;
  }
  completed(worker: string, start: number): void {
    const previous = this.workers.get(worker);
    if (previous !== undefined && start > previous) this.workers.set(worker, start);
  }
  /** Whether every running worker has completed a pass that began after `opened`. */
  quietSince(opened: number): boolean {
    for (const completed of this.workers.values()) if (completed <= opened) return false;
    return true;
  }
}

/**
 * Whether the operator is watching (NOTIF-04): a browser holding the workspace's event
 * stream open. Recent commands come from the audit log, which records every one.
 */
export class OperatorPresence {
  private readonly streams = new Map<string, number>();
  opened(workspaceId: WorkspaceId, userId: UserId): void {
    const key = `${workspaceId}|${userId}`;
    this.streams.set(key, (this.streams.get(key) ?? 0) + 1);
  }
  closed(workspaceId: WorkspaceId, userId: UserId): void {
    const key = `${workspaceId}|${userId}`;
    const left = (this.streams.get(key) ?? 0) - 1;
    if (left > 0) this.streams.set(key, left);
    else this.streams.delete(key);
  }
  watching(workspaceId: WorkspaceId, userId: UserId): boolean {
    return this.streams.has(`${workspaceId}|${userId}`);
  }
}
