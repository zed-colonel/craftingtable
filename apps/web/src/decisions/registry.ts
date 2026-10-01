import type { AttentionItemView } from '@craftingtable/contracts';
import type { AttentionItemCode } from '@craftingtable/domain';
import type { SetupStep } from '../features/planning/setup-steps.js';

/**
 * One part of a roadmap an inbox item is decided in, rendered alone (R-A6 increment 2a): its
 * controls with one held entry, one setup step, or its map amendments.
 */
export type RoadmapItemPart =
  | {
      readonly kind: 'controls';
      readonly entryId?: string;
      /**
       * Only while the entry is held or the roadmap stopped: a roadmap-owned cycle's item
       * carries the hold, whose exits (resume, re-verify) are the roadmap's (LIVE-24).
       */
      readonly heldOnly?: true;
    }
  | { readonly kind: 'setup'; readonly step: SetupStep }
  | { readonly kind: 'amendments'; readonly entryId?: string };

/**
 * What an inbox item's detail renders (R-A6 increment 2a, operator decision 2026-09-30): the
 * decision kinds that resolve it, chosen from its typed code. Each kind is one component.
 */
export type Decision =
  /** The cycle's own decision, chosen by its stop: continuation, design, scope repair, … */
  | { readonly kind: 'cycle' }
  /** A slice's merge, or a merge's recovery. */
  | { readonly kind: 'merge' }
  /** The contract-checkpoint evidence a slice's merge waits on. */
  | { readonly kind: 'checkpoint-preparation' }
  /** The work item's worktrees and runs, where a manual run is launched again. */
  | { readonly kind: 'worktrees' }
  /** The repository's declared checks: adopt, or see which definition changed (LIVE-30). */
  | { readonly kind: 'check-adoption' }
  /** A slice-verification or parent-acceptance review records its scope evidence. */
  | { readonly kind: 'scope-evidence' }
  | { readonly kind: 'finalization' }
  | { readonly kind: 'run' }
  | { readonly kind: 'storage' }
  | { readonly kind: 'acknowledge' }
  | { readonly kind: 'roadmap'; readonly part: RoadmapItemPart };

const CYCLE: Decision = { kind: 'cycle' };
const setup = (step: SetupStep): Decision => ({ kind: 'roadmap', part: { kind: 'setup', step } });

/**
 * Codes whose decision is a roadmap's: its controls, one setup step, or its amendments. A
 * roadmap-subject item with a code a cycle shares (`restart-resume`, `legacy-attention`) is
 * told apart by its subject (below).
 */
const ROADMAP: Partial<Record<AttentionItemCode, (item: AttentionItemView) => Decision>> = {
  'scheduler-error': (i) => controls(i),
  'entry-preparation-failed': (i) => controls(i),
  'entry-blocked': (i) => controls(i),
  'evidence-not-current': (i) => controls(i),
  'cycle-needs-attention': (i) => controls(i),
  // Automatic recovery stopped converging: a split of the remaining work into a follow-up
  // slice is offered through the amendment form (R-C5, ADR-049), beside the held entry.
  'recovery-not-converging': (i) => ({
    kind: 'roadmap',
    part: { kind: 'amendments', ...entry(i) },
  }),
  'amendment-decision': () => ({ kind: 'roadmap', part: { kind: 'amendments' } }),
  // The refresh is saved; resuming the roadmap runs the refreshed reviews (beside it, below).
  'dependency-refresh-resume': () => setup('dependency'),
  'upstream-pin-moved': () => setup('dependency'),
  'upstream-transition-undeclared': () => setup('dependency'),
  'verification-setup': () => setup('verification'),
  'checkpoint-evidence': () => setup('evidence'),
  'plan-acceptance': () => setup('plan-acceptance'),
  'architecture-decision': () => setup('decisions'),
  // The decisions a shared-decision stop waits on (LIVE-18).
  'shared-decision-required': () => setup('decisions'),
  'decision-preparation-questions': () => setup('decisions'),
};

const entry = (item: AttentionItemView) =>
  item.refs.entryId === undefined ? {} : { entryId: item.refs.entryId };
const controls = (item: AttentionItemView): Decision => ({
  kind: 'roadmap',
  part: { kind: 'controls', ...entry(item) },
});

/** A cycle stop the merge controls resolve. */
const MERGE: ReadonlySet<AttentionItemCode> = new Set([
  'merge-approval',
  'merge-requirements',
  'merge-recovery-required',
  'merge-cleanup-failed',
  'manual-review-mergeable',
]);
const CHECKS: ReadonlySet<AttentionItemCode> = new Set([
  'repository-checks-undeclared',
  'check-definition-changed',
]);
const FINALIZATION: ReadonlySet<AttentionItemCode> = new Set([
  'final-promotion',
  'finalization-cleanup-blocked',
]);
const RUN: ReadonlySet<AttentionItemCode> = new Set([
  'manual-run-failed',
  'manual-run-interrupted',
  'manual-review-needs-attention',
  'manual-design-questions',
]);
const STORAGE: ReadonlySet<AttentionItemCode> = new Set([
  'storage-pressure',
  'storage-maintenance-failed',
]);

/** The subject an item is about, from the daemon's subject key (an identifier, not prose). */
function subject(item: AttentionItemView): string {
  return item.subjectKey.slice(0, item.subjectKey.indexOf(':'));
}

/** The decisions that resolve an item, most direct first. Every code has at least one. */
export function decisionsFor(item: AttentionItemView): readonly Decision[] {
  const { workItemId, roadmapId, planVersionId, runId } = item.refs;
  const code = item.code;
  if (code === 'protected-ref-moved') return [{ kind: 'acknowledge' }];
  if (STORAGE.has(code)) return [{ kind: 'storage' }];
  // A roadmap-owned cycle's item may carry its entry's hold, whose exits are the roadmap's.
  const held: readonly Decision[] =
    roadmapId !== undefined && item.refs.entryId !== undefined && subject(item) === 'cycle'
      ? [
          {
            kind: 'roadmap',
            part: { kind: 'controls', entryId: item.refs.entryId, heldOnly: true },
          },
        ]
      : [];
  const roadmap = roadmapId === undefined ? undefined : ROADMAP[code];
  // A roadmap's own stop, held entry or checkpoint is decided on the roadmap, even when it
  // names the cycle of its attempt.
  if (subject(item) === 'roadmap' && roadmapId !== undefined)
    return [
      roadmap ? roadmap(item) : controls(item),
      ...(code === 'dependency-refresh-resume' ? [controls(item)] : []),
    ];
  // A cycle stopped for a roadmap decision continues once it is made.
  if (roadmap)
    return [
      roadmap(item),
      ...(workItemId !== undefined && subject(item) === 'cycle' ? [CYCLE] : []),
      ...held,
    ];
  // A finalization's own cycle, merge or cleanup has no work item.
  if (workItemId === undefined && planVersionId !== undefined)
    return FINALIZATION.has(code) ||
      ['cycle', 'merge', 'run', 'finalization'].includes(subject(item))
      ? [{ kind: 'finalization' }]
      : [];
  // Adopting the checks is the way on; the cycle then resumes for a fresh review.
  if (CHECKS.has(code))
    return [{ kind: 'check-adoption' }, ...(workItemId === undefined ? [] : [CYCLE]), ...held];
  if (MERGE.has(code) || item.kind === 'merge')
    return workItemId === undefined
      ? []
      : [
          { kind: 'merge' },
          // A merge waiting on its requirements, or a manual review whose merge may be held by
          // them: checkpoint evidence is settled here (R-A6 review).
          ...(code === 'merge-requirements' || code === 'manual-review-mergeable'
            ? [{ kind: 'checkpoint-preparation' } as const]
            : []),
          ...(code === 'manual-review-mergeable' && runId !== undefined
            ? [{ kind: 'run' } as const]
            : []),
          ...held,
        ];
  if (code === 'record-scope-evidence') return [{ kind: 'scope-evidence' }, ...held];
  if (RUN.has(code) && runId !== undefined)
    return [{ kind: 'run' }, ...(workItemId === undefined ? [] : [{ kind: 'worktrees' } as const])];
  return workItemId === undefined ? [] : [CYCLE, ...held];
}
