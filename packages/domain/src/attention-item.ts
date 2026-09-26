import {
  type AttentionOwner,
  CYCLE_ATTENTION,
  type CycleAttentionCode,
  ROADMAP_ATTENTION,
  type RoadmapAttentionCode,
} from './attention.js';
import type { WorkspaceId } from './ids.js';

/**
 * Durable attention items (review item R-A4, ADR-070).
 *
 * An item is one occurrence of something only the operator can move: a subject (a cycle, a
 * run, a roadmap, a roadmap entry, a set of checkpoints, the storage volumes) stopped at one
 * code. The daemon opens and resolves items in the same transaction as the state that causes
 * them, so the inbox, the rail count and the push log all read the same rows. An item is
 * never reopened: a subject that stops again gets a new item, which may continue the earlier
 * one's reminder schedule when it reopens within the flap window.
 */

/** Operator stops that are not a cycle's or a roadmap's own declared attention. */
export const ITEM_ATTENTION = {
  // A run started by hand, outside an automated cycle.
  'manual-run-failed': 'operator',
  'manual-run-interrupted': 'operator',
  'manual-review-mergeable': 'operator',
  'manual-review-needs-attention': 'operator',
  'manual-design-questions': 'operator',
  // An agent preparing an architecture decision for a roadmap stopped with questions.
  'decision-preparation-questions': 'operator',
  // A merge interrupted after its reservation, or one whose cleanup failed afterwards.
  'merge-recovery-required': 'operator',
  'merge-cleanup-failed': 'operator',
  'finalization-cleanup-blocked': 'operator',
  // Roadmaps waiting on an operator step they were paused for.
  'amendment-decision': 'operator',
  'dependency-refresh-resume': 'operator',
  // Roadmap-level sets the scheduler derives on each pass.
  'verification-setup': 'operator',
  'checkpoint-evidence': 'operator',
  // One map checkpoint ready for the operator's acceptance, by the checkpoint's kind.
  'architecture-decision': 'operator',
  'plan-acceptance': 'operator',
  'storage-pressure': 'operator',
  'storage-maintenance-failed': 'operator',
} as const satisfies Record<string, AttentionOwner>;
export type ItemAttentionCode = keyof typeof ITEM_ATTENTION;

export type AttentionItemCode = CycleAttentionCode | RoadmapAttentionCode | ItemAttentionCode;
export const ATTENTION_ITEM_CODES = [
  ...new Set<AttentionItemCode>([
    ...(Object.keys(CYCLE_ATTENTION) as CycleAttentionCode[]),
    ...(Object.keys(ROADMAP_ATTENTION) as RoadmapAttentionCode[]),
    ...(Object.keys(ITEM_ATTENTION) as ItemAttentionCode[]),
  ]),
];

/** Codes that only an installation owner may see: they concern the host, not the work. */
export const INSTALLATION_ATTENTION_CODES: ReadonlySet<AttentionItemCode> = new Set([
  'storage-pressure',
  'storage-maintenance-failed',
]);

/**
 * What resolved an item.
 * - `operator`: an operator command was recorded in the workspace after the item opened.
 * - `automation`: nothing the operator did; the daemon moved on by itself.
 * - `superseded`: the same subject stopped again at a different code.
 *
 * A pushed item resolved by automation is a false alarm (NOTIF-01), which makes false alarms
 * directly countable.
 */
export type AttentionResolution = 'operator' | 'automation' | 'superseded';

export interface AttentionItemRefs {
  readonly cycleId?: string;
  readonly runId?: string;
  readonly worktreeId?: string;
  readonly workItemId?: string;
  readonly projectId?: string;
  readonly planVersionId?: string;
  readonly roadmapId?: string;
  readonly entryId?: string;
  readonly finalizationId?: string;
}

/** Controls an item offers besides its subject's own form. */
export const ATTENTION_ITEM_ACTIONS = ['reverify'] as const;
export type AttentionItemAction = (typeof ATTENTION_ITEM_ACTIONS)[number];

/** Push scheduling for one occurrence. The delivery log keeps the history. */
export interface AttentionItemDelivery {
  readonly firstSentAt: string | null;
  readonly lastSentAt: string | null;
  readonly deliveredCount: number;
  readonly nextAttemptAt: string;
  readonly failures: number;
  readonly lastError: string | null;
  readonly leaseToken: string | null;
  readonly leaseUntil: string | null;
  /**
   * When the current paging began, if later than the item's opening: a set that gained a
   * member pages again from here, through the same settle, quiescence and presence gates.
   */
  readonly since?: string;
}

export interface AttentionItem {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  /** The projection unit that owns the item: `worktree:<id>`, `roadmap:<id>`, … */
  readonly scopeKey: string;
  /** What is stopped: `cycle:<id>`, `run:<id>`, `roadmap:<id>:entry:<entryId>`, … */
  readonly subjectKey: string;
  readonly code: AttentionItemCode;
  readonly kind: 'merge' | 'attention';
  /** Display text, rendered from current state while the item is open; never parsed. */
  readonly title: string;
  readonly message: string;
  /** Where the subject's own controls live. */
  readonly path: string;
  readonly refs: AttentionItemRefs;
  /** Members of a set-valued item; a new member is new work and pages again. */
  readonly members?: readonly string[];
  readonly actions?: readonly AttentionItemAction[];
  /** Map milestones waiting on this item, for items the scheduler derives from the map. */
  readonly blocks?: number;
  readonly state: 'open' | 'resolved';
  readonly openedAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: AttentionResolution;
  /** The earlier occurrence of the same subject and code this one reopened within the flap window. */
  readonly continues?: string;
  readonly delivery: AttentionItemDelivery;
}

/** One push attempt. Append-only: the history of what was sent, when, and for which items. */
export interface NotificationDelivery {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly attemptedAt: string;
  readonly itemIds: readonly string[];
  /** The subset of `itemIds` that had been sent before: reminders. */
  readonly reminderItemIds: readonly string[];
  /** Set for an operator-requested test push instead of items. */
  readonly testId?: string;
  readonly title: string;
  readonly message: string;
  readonly result: 'accepted' | 'retry' | 'blocked';
  readonly error?: string;
}

/** An occurrence reopened this soon after resolving continues it (NOTIF-03). */
export const ATTENTION_FLAP_WINDOW_MS = 10 * 60_000;
