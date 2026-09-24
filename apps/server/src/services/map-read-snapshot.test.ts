import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asWorkItemId, asWorkspaceId } from '@craftingtable/domain';
import { expect, it, vi } from 'vitest';
import { openDaemonStorage } from '../persisted-records.js';
import { mapReadSnapshot } from './map-read-snapshot.js';

it('shares repeated projection reads but sees changed authority in the next snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-projection-'));
  const storage = openDaemonStorage(join(directory, 'state.sqlite'));
  try {
    const ws = asWorkspaceId('missing-workspace'),
      item = asWorkItemId('missing-item');
    const items = vi.spyOn(storage.planning.workItems, 'find');
    const trees = vi.spyOn(storage.execution.worktrees, 'listForWorkItem');
    const receipts = vi.spyOn(storage.scopeReceipts, 'list');
    const snapshot = mapReadSnapshot(storage);
    expect(mapReadSnapshot(snapshot)).toBe(snapshot);
    for (let i = 0; i < 100; i++) {
      expect(snapshot.planning.workItems.find(ws, item)).toBeUndefined();
      expect(snapshot.execution.worktrees.listForWorkItem(ws, item)).toEqual([]);
      expect(snapshot.scopeReceipts.list(ws, item)).toEqual([]);
    }
    expect(items).toHaveBeenCalledOnce();
    expect(trees).toHaveBeenCalledOnce();
    expect(receipts).toHaveBeenCalledOnce();
    expect(snapshot.phaseScheduling.capacity('local-development')).toBe(2);
    storage.phaseScheduling.setCapacity('local-development', 4);
    expect(snapshot.phaseScheduling.capacity('local-development')).toBe(2);
    expect(mapReadSnapshot(storage).phaseScheduling.capacity('local-development')).toBe(4);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
