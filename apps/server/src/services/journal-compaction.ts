import { randomUUID } from 'node:crypto';
import type { AgentRun, AgentRunEvent } from '@craftingtable/domain';
import type { CraftingTableStorage, RunEventCompaction } from '@craftingtable/storage';
import { offloadToolResult } from './tool-result-store.js';

/**
 * Journal compaction (R-H2): applies the retention that new runs already follow to events
 * journaled before it.
 *
 * - A raw vendor line is kept only on a notice the adapter could not normalize (category
 *   `other`). Every other event's raw line is dropped; its payload already says everything.
 * - A tool result larger than the preview moves its body to the run directory, leaving the
 *   preview and digest. When the run directory is gone, the output stays in the journal.
 *
 * Only ended runs are touched. Each run is rewritten in one transaction with its audit
 * record, through the journal's single rewrite path, which lifts the append-only trigger and
 * restores it unchanged. Bodies are written before the rows that point at them.
 */

export interface JournalCompactionOptions {
  /** False reports what would change and writes nothing. */
  readonly apply: boolean;
  /** Where a run's bodies go; undefined keeps its tool output in the journal. */
  readonly bodyDirectory: (run: AgentRun) => string | undefined;
  readonly now: () => Date;
  /** Told about each run as it is compacted, for progress on a large journal. */
  readonly progress?: (run: RunCompaction) => void;
}

export interface RunCompaction {
  readonly runId: string;
  readonly events: number;
  readonly rawCleared: number;
  readonly bodiesMoved: number;
  readonly bodiesKept: number;
  /** Journal bytes (payload plus raw) of the run's events before and after. */
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export interface JournalCompaction {
  readonly applied: boolean;
  readonly runs: readonly RunCompaction[];
}

const PAGE = 500;

function journalBytes(event: AgentRunEvent): number {
  return Buffer.byteLength(JSON.stringify(event.payload)) + Buffer.byteLength(event.raw ?? '');
}

/** An adapter keeps a raw line only on a notice it could not represent (R-H2). */
function keepsRaw(event: AgentRunEvent): boolean {
  return event.kind === 'notice' && event.payload.category === 'other';
}

export function compactJournal(
  storage: CraftingTableStorage,
  options: JournalCompactionOptions,
): JournalCompaction {
  const runs: RunCompaction[] = [];
  for (const run of storage.execution.runs.listEnded()) {
    const directory = options.bodyDirectory(run);
    const changes: RunEventCompaction[] = [];
    let events = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;
    let bodiesMoved = 0;
    let bodiesKept = 0;
    for (let after = 0; ; ) {
      const page = storage.execution.runEvents.listAfter({
        workspaceId: run.workspaceId,
        runId: run.id,
        after,
        limit: PAGE,
      });
      for (const event of page) {
        events++;
        const before = journalBytes(event);
        bytesBefore += before;
        const clearRaw = event.raw !== undefined && !keepsRaw(event);
        let payload: AgentRunEvent['payload'] | undefined;
        if (event.kind === 'tool-result' && event.payload.body === undefined) {
          const offloaded = offloadToolResult(event.payload, directory ?? '', {
            write: options.apply && directory !== undefined,
          });
          if (offloaded.body !== undefined && directory === undefined) bodiesKept++;
          else if (offloaded.body !== undefined) {
            payload = offloaded;
            bodiesMoved++;
          }
        }
        if (!clearRaw && payload === undefined) {
          bytesAfter += before;
          continue;
        }
        changes.push({ sequence: event.sequence, clearRaw, ...(payload ? { payload } : {}) });
        bytesAfter +=
          Buffer.byteLength(JSON.stringify(payload ?? event.payload)) +
          (clearRaw ? 0 : Buffer.byteLength(event.raw ?? ''));
      }
      if (page.length < PAGE) break;
      after = page.at(-1)?.sequence ?? after;
    }
    if (changes.length === 0) continue;
    const result: RunCompaction = {
      runId: run.id,
      events,
      rawCleared: changes.filter((change) => change.clearRaw).length,
      bodiesMoved,
      bodiesKept,
      bytesBefore,
      bytesAfter,
    };
    if (options.apply)
      storage.transaction((tx) => {
        tx.execution.runEvents.compact(run.id, changes);
        tx.audit.append({
          id: randomUUID(),
          occurredAt: options.now().toISOString(),
          actorKind: 'system',
          workspaceId: run.workspaceId,
          action: 'storage.journal-compacted',
          targetType: 'agent-run',
          targetId: run.id,
          outcome: 'succeeded',
          metadata: { ...result },
        });
      });
    runs.push(result);
    options.progress?.(result);
  }
  return { applied: options.apply, runs };
}
