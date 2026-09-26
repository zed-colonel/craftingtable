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
const STORAGE_CODES: ReadonlySet<string> = new Set([
  'storage-pressure',
  'storage-maintenance-failed',
]);

/** Which existing controls an inbox item hosts (R-A5), decided from its code and refs only. */
export interface InboxHost {
  /** The work item's automated cycle panel: resume, guidance, recovery forms. */
  readonly cycle: boolean;
  /** The work item's worktrees, runs and merge form. */
  readonly delegation: boolean;
  /** The plan version's finalization panel. */
  readonly finalization: boolean;
  readonly storage: boolean;
  readonly run: boolean;
  /** The roadmap's own controls, open or collapsed, and what to bring into view. */
  readonly roadmap?: { readonly open: boolean; readonly focus?: string };
}

export function inboxHost(item: AttentionItemView): InboxHost {
  const { workItemId, roadmapId, planVersionId, runId, cycleId, entryId } = item.refs;
  const cycle = workItemId !== undefined && cycleId !== undefined;
  return {
    cycle,
    delegation:
      workItemId !== undefined &&
      (cycleId === undefined || item.kind === 'merge' || MERGE_CODES.has(item.code)),
    finalization:
      workItemId === undefined && roadmapId === undefined && planVersionId !== undefined,
    storage: STORAGE_CODES.has(item.code),
    run: runId !== undefined,
    ...(roadmapId === undefined
      ? {}
      : {
          roadmap: {
            open: cycleId === undefined || ROADMAP_DECISION_CODES.has(item.code),
            ...(entryId !== undefined && cycleId === undefined
              ? { focus: `roadmap-entry-${roadmapId}-${entryId}` }
              : item.code === 'verification-setup'
                ? { focus: `runtime-evidence-roadmap-${roadmapId}-native` }
                : {}),
          },
        }),
  };
}
