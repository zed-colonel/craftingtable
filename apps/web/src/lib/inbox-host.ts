import type { AttentionItemView } from '@craftingtable/contracts';

/** Stops resolved from the worktree's merge controls. */
const MERGE_CODES: ReadonlySet<string> = new Set([
  'merge-requirements',
  'merge-recovery-required',
  'merge-cleanup-failed',
]);
/** Cycle stops the roadmap's own controls resolve: its decisions and upstream transitions. */
const ROADMAP_DECISION_CODES: ReadonlySet<string> = new Set([
  'shared-decision-required',
  'upstream-transition-undeclared',
]);
/** Cycle stops recorded from the work item's execution-slice controls. */
const SCOPE_CODES: ReadonlySet<string> = new Set(['record-scope-evidence']);
const STORAGE_CODES: ReadonlySet<string> = new Set([
  'storage-pressure',
  'storage-maintenance-failed',
]);

/** Which existing controls an inbox item hosts (R-A5), decided from its code, subject and refs. */
export interface InboxHost {
  /** The work item's automated cycle panel, showing the item's own worktree. */
  readonly cycle: boolean;
  /** The work item's worktrees, runs and merge form. */
  readonly delegation: boolean;
  /** The work item's execution slices, where scope evidence is recorded. */
  readonly scopes: boolean;
  /** The plan version's finalization panel. */
  readonly finalization: boolean;
  readonly storage: boolean;
  readonly run: boolean;
  /** The roadmap's own controls, open or collapsed, and what to bring into view. */
  readonly roadmap?: { readonly open: boolean; readonly focus?: string };
}

/** The kind of subject an item is about, from the daemon's subject key (an identifier). */
function family(item: AttentionItemView): string {
  return item.subjectKey.slice(0, item.subjectKey.indexOf(':'));
}

export function inboxHost(item: AttentionItemView): InboxHost {
  const { workItemId, roadmapId, planVersionId, runId, entryId } = item.refs;
  const subject = family(item);
  // A roadmap's own stop or held entry is resolved on the roadmap, even when it names the
  // cycle of its attempt; a cycle's stop on the cycle.
  const cycle = subject === 'cycle' && workItemId !== undefined;
  return {
    cycle,
    delegation:
      workItemId !== undefined &&
      (subject === 'run' ||
        subject === 'merge' ||
        (cycle && (item.kind === 'merge' || MERGE_CODES.has(item.code)))),
    scopes: cycle && SCOPE_CODES.has(item.code),
    finalization:
      workItemId === undefined &&
      roadmapId === undefined &&
      planVersionId !== undefined &&
      ['cycle', 'merge', 'run', 'finalization'].includes(subject),
    storage: STORAGE_CODES.has(item.code),
    run: runId !== undefined,
    ...(roadmapId === undefined
      ? {}
      : {
          roadmap: {
            open: subject === 'roadmap' || ROADMAP_DECISION_CODES.has(item.code),
            ...(subject === 'roadmap' && entryId !== undefined
              ? { focus: `roadmap-entry-${roadmapId}-${entryId}` }
              : item.code === 'verification-setup'
                ? { focus: `runtime-evidence-roadmap-${roadmapId}-native` }
                : // A checkpoint the operator settles opens at its form (LIVE-11).
                  item.code === 'checkpoint-evidence'
                  ? { focus: `runtime-evidence-roadmap-${roadmapId}-evidence` }
                  : item.code === 'plan-acceptance'
                    ? { focus: `runtime-evidence-roadmap-${roadmapId}-plan-acceptance` }
                    : {}),
          },
        }),
  };
}
