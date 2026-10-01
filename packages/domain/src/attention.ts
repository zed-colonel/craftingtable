/**
 * Typed attention (review item R-A3).
 *
 * Whoever decides a blocking transition also declares, in the same write, what the stop is
 * (`code`) and who moves it next (`owner`). Consumers branch on the code; the accompanying
 * `reason` or `message` text is for display only and is never parsed. Operator-owned
 * attention is the operator's to resolve; controller-owned attention is a wait the
 * controller resolves itself and is never pushed as a notification.
 */

export type AttentionOwner = 'operator' | 'controller';

/** Stops a cycle's controller declares. The value is the owner. */
export const CYCLE_ATTENTION = {
  // Agent-run outcomes (decideStepOutcome).
  'service-failure-not-retryable': 'operator',
  'service-retries-exhausted': 'operator',
  // The provider kept rejecting credentials the host never supplied (R-C11).
  'provider-credentials-rejected': 'operator',
  'exit-with-open-questions': 'operator',
  'completion-continuations-exhausted': 'operator',
  'background-work-unsafe': 'operator',
  'step-incomplete': 'operator',
  'resolution-needs-guidance': 'operator',
  'workflow-report-invalid': 'operator',
  'workflow-questions-disagree': 'operator',
  'shared-decision-required': 'operator',
  'work-item-questions': 'operator',
  'finalization-needs-input': 'operator',
  'design-investigation-finished': 'operator',
  'design-report-invalid': 'operator',
  'design-dependency-continuations-exhausted': 'operator',
  'design-dependency-unsupported': 'operator',
  'design-planning-conflict': 'operator',
  'design-decision-required': 'operator',
  'design-open-questions': 'operator',
  'implementation-open-questions': 'operator',
  'review-open-questions-at-limit': 'operator',
  'review-open-questions': 'operator',
  'finalization-report-rejected': 'operator',
  // Written by the retired improvement-round finalization; kept so its records still read.
  'polish-assessment-needs-attention': 'operator',
  // A stage-less (legacy) finalization met by the controller after R-B10 retired that path.
  'legacy-finalization-retired': 'operator',
  'scope-review-open-questions': 'operator',
  'scope-review-recovery': 'operator',
  'review-needs-attention': 'operator',
  'restart-session-lost': 'operator',
  // Controller and workflow stops.
  'restart-resume': 'operator',
  'controller-error': 'operator',
  // A run needs a current pin for a consumer→upstream link nobody declared (ADR-069).
  'upstream-transition-undeclared': 'operator',
  // A pinned upstream's integration moved past the saved dependency generation; the refresh
  // preview is the way on (LIVE-15, ADR-058). Refs name the definition and what moved.
  'upstream-pin-moved': 'operator',
  // A scoped run's repository has no adopted check declaration, so the run does not start
  // (R-G13, fail closed). Adopting one on the repository is the way on.
  'repository-checks-undeclared': 'operator',
  // A declared check's definition files differ on the gated commit from the ones adopted
  // (R-G13); the operator adopts the new definition or the change is reverted.
  'check-definition-changed': 'operator',
  'reassessment-failed': 'operator',
  'worktree-inactive': 'operator',
  'authority-lost': 'operator',
  'design-recheck-unavailable': 'operator',
  'step-time-limit': 'operator',
  'service-retry-mismatch': 'operator',
  'scope-review-snapshot-changed': 'operator',
  'review-baseline-changed': 'operator',
  'security-reviewer-unassigned': 'operator',
  'workflow-obligation': 'operator',
  // A delegated checkpoint review could not attest with the evidence it was given (R-C13).
  'checkpoint-attestation-failed': 'operator',
  'stage-report-invalid': 'operator',
  'finalization-ledger-full': 'operator',
  'plan-change-decision': 'operator',
  'stage-batch-selection': 'operator',
  'stage-review-changes-requested': 'operator',
  'remediation-exhausted': 'operator',
  'remediation-no-change': 'operator',
  'remediation-stalled': 'operator',
  'implementation-commit-failed': 'operator',
  'integration-refresh-limit': 'operator',
  'integration-conflict': 'operator',
  'integration-update-failed': 'operator',
  'resolution-abandoned': 'operator',
  // `awaiting-merge` gates (CTRL-10): what the cycle is waiting for at the merge boundary.
  'merge-approval': 'operator',
  // Merge approval is due but the slice's merge requirements are not met yet.
  'merge-requirements': 'operator',
  'final-promotion': 'operator',
  'record-scope-evidence': 'operator',
  'controller-wait': 'controller',
  'scheduling-held': 'controller',
  // A record written before codes existed whose reason maps to nothing more specific.
  'legacy-attention': 'operator',
} as const satisfies Record<string, AttentionOwner>;
export type CycleAttentionCode = keyof typeof CYCLE_ATTENTION;
export const CYCLE_ATTENTION_CODES = Object.keys(CYCLE_ATTENTION) as CycleAttentionCode[];

/** The `awaiting-merge` gate codes; every other cycle code belongs to `needs-attention`. */
export const AWAITING_MERGE_GATES = [
  'merge-approval',
  'merge-requirements',
  'final-promotion',
  'record-scope-evidence',
  'controller-wait',
  'scheduling-held',
] as const satisfies readonly CycleAttentionCode[];
export type AwaitingMergeGate = (typeof AWAITING_MERGE_GATES)[number];

/** Stops a roadmap's scheduler declares, on the roadmap or on one entry's hold. */
export const ROADMAP_ATTENTION = {
  'restart-resume': 'operator',
  'scheduler-error': 'operator',
  'entry-preparation-failed': 'operator',
  'entry-blocked': 'operator',
  // A verification or acceptance entry whose review evidence went stale; Re-verify resolves it.
  'evidence-not-current': 'operator',
  // Automatic scope recovery stopped: a repeat, rounds without progress, or the allowance is
  // spent. The hold carries the rounds' progress (R-C5 increment 4, ADR-057).
  'recovery-not-converging': 'operator',
  'cycle-needs-attention': 'operator',
  'legacy-attention': 'operator',
} as const satisfies Record<string, AttentionOwner>;
export type RoadmapAttentionCode = keyof typeof ROADMAP_ATTENTION;
export const ROADMAP_ATTENTION_CODES = Object.keys(ROADMAP_ATTENTION) as RoadmapAttentionCode[];

/**
 * Why a roadmap's scheduler left an entry it evaluated without moving it on (R-C12). The value
 * is who acts next: the controller when the wait clears without anyone (capacity, prerequisite
 * work, a running review or recovery round, a cycle's own controller wait), the operator when
 * the entry waits on a stop the operator owns (the cycle's attention item, a hold, or their own
 * pause or stop). An operator-owned wait always points at the item, pause or stop that carries
 * it.
 */
export const ENTRY_WAIT = {
  // The scheduler's own blockers (`RoadmapService.blocker`).
  'dependency-blocked': 'controller',
  'capacity-blocked': 'controller',
  'exclusion-blocked': 'controller',
  // Phase gates that clear by themselves (`PhaseGateError.waiting`).
  'phase-blocked': 'controller',
  'integration-held': 'controller',
  // A related independent review of the same work item is still running.
  'review-running': 'controller',
  // A recovery round for this work item is carrying the repair through.
  'recovery-round': 'controller',
  // The entry's cycle waits on its own controller.
  'cycle-waiting': 'controller',
  'cycle-attention': 'operator',
  'cycle-paused': 'operator',
  // The entry's cycle ended (stopped, or completed without the entry completing).
  'cycle-ended': 'operator',
  'entry-held': 'operator',
} as const satisfies Record<string, AttentionOwner>;
export type EntryWaitCode = keyof typeof ENTRY_WAIT;
export const ENTRY_WAIT_CODES = Object.keys(ENTRY_WAIT) as EntryWaitCode[];

export interface AttentionRefs {
  readonly checkpointId?: string;
  readonly cycleId?: string;
  readonly entryId?: string;
  /** The concurrency definition whose dependency environment an `upstream-pin-moved` names. */
  readonly definitionId?: string;
  /** The repository whose declared checks a `repository-checks-*` or `check-definition-*` stop names. */
  readonly repositoryId?: string;
  /** The declared check whose definition changed. */
  readonly checkId?: string;
  /** The pins that moved, for the operator and for automation that may refresh them later. */
  readonly pins?: readonly {
    readonly alias: string;
    readonly pinnedCommitSha: string;
    readonly currentCommitSha: string;
  }[];
}

/**
 * Automation that will act on a stop next. A claimed stop keeps its code (what the stop is)
 * but is owned by the controller until the claim lapses, e.g. a roadmap whose policy merges
 * automatically, or a scope review waiting for prerequisite work (NOTIF-02).
 */
export const ATTENTION_CLAIMS = [
  'roadmap-merge',
  'roadmap-verification',
  'roadmap-acceptance',
  'conflict-automation',
  'scope-recovery',
  'prerequisite-work',
] as const;
export type AttentionClaim = (typeof ATTENTION_CLAIMS)[number];

export interface CycleAttention {
  readonly code: CycleAttentionCode;
  /** `controller` when automation claims the stop; otherwise the code's own owner. */
  readonly owner: AttentionOwner;
  readonly claim?: AttentionClaim;
  readonly refs?: AttentionRefs;
  /** Display text for the specific blocker (e.g. unmet merge requirements); never parsed. */
  readonly detail?: string;
  /** Automatic output-format repairs the controller made before this stop (R-C2). */
  readonly repairAttempts?: number;
}

export interface RoadmapAttention {
  readonly code: RoadmapAttentionCode;
  readonly owner: AttentionOwner;
  readonly refs?: AttentionRefs;
}

/** The only way to build cycle attention: the owner follows the code, or a claim. */
export function cycleAttention(
  code: CycleAttentionCode,
  refs?: AttentionRefs,
  extra: {
    readonly claim?: AttentionClaim;
    readonly detail?: string;
    readonly repairAttempts?: number;
  } = {},
): CycleAttention {
  return {
    code,
    owner: extra.claim ? 'controller' : CYCLE_ATTENTION[code],
    ...(extra.claim ? { claim: extra.claim } : {}),
    ...(refs ? { refs } : {}),
    ...(extra.detail ? { detail: extra.detail.slice(0, 2000) } : {}),
    ...(extra.repairAttempts ? { repairAttempts: extra.repairAttempts } : {}),
  };
}

/**
 * A merge approval whose merge adopts the repository's checks (R-G13 increment 5, operator
 * decision 2026-09-30): the slice changes a check definition, so a person approves its merge,
 * whatever the roadmap's merge policy, and sees the definitions with it.
 */
export function mergeAdoptsChecks(
  attention: Pick<CycleAttention, 'code' | 'refs'> | undefined,
): boolean {
  return (
    (attention?.code === 'merge-approval' || attention?.code === 'merge-requirements') &&
    attention.refs?.repositoryId !== undefined
  );
}

export function roadmapAttention(
  code: RoadmapAttentionCode,
  refs?: AttentionRefs,
): RoadmapAttention {
  return { code, owner: ROADMAP_ATTENTION[code], ...(refs ? { refs } : {}) };
}

/**
 * Why a phase gate holds work. `waits` means the controller keeps waiting and retries on
 * its own; otherwise the gate stops the work for someone to act. `owner` says who resolves
 * the blocker, which is what the browser groups by (UI-09).
 */
export const PHASE_BLOCKERS = {
  'binding-changed': { owner: 'operator', waits: false },
  'plan-inactive': { owner: 'operator', waits: false },
  'repository-unavailable': { owner: 'operator', waits: false },
  'binding-retired': { owner: 'operator', waits: false },
  'amendment-pending': { owner: 'operator', waits: false },
  'runtime-definition-unavailable': { owner: 'operator', waits: false },
  'binding-superseded': { owner: 'operator', waits: false },
  'decision-adoption-required': { owner: 'operator', waits: false },
  'merge-resource-mismatch': { owner: 'operator', waits: false },
  'reviewer-assignment': { owner: 'operator', waits: false },
  // Operator setup the controller waits for rather than stopping.
  'environment-approval': { owner: 'operator', waits: true },
  'resource-unsupported': { owner: 'operator', waits: true },
  'dependency-environment-missing': { owner: 'operator', waits: true },
  'upstream-pin-missing': { owner: 'operator', waits: true },
  'external-qualification-required': { owner: 'operator', waits: true },
  // Other work or the controller itself resolves these.
  'predecessor-not-accepted': { owner: 'controller', waits: true },
  'parent-not-accepted': { owner: 'controller', waits: true },
  'slice-not-started': { owner: 'controller', waits: true },
  'slice-not-merged': { owner: 'controller', waits: true },
  'slice-attempt-active': { owner: 'controller', waits: true },
  'slice-requirement': { owner: 'controller', waits: true },
  'required-slice-unmerged': { owner: 'controller', waits: true },
  'required-slice-unverified': { owner: 'controller', waits: true },
  'checkpoint-evidence': { owner: 'controller', waits: true },
  // Plan acceptance and architecture decisions: only the operator's acceptance satisfies them.
  'decision-checkpoint-evidence': { owner: 'operator', waits: true },
  'staged-approval-prerequisite': { owner: 'controller', waits: true },
  'resource-busy': { owner: 'controller', waits: true },
  'scheduling-held': { owner: 'controller', waits: true },
  'legacy-blocker': { owner: 'operator', waits: false },
} as const satisfies Record<string, { owner: AttentionOwner; waits: boolean }>;
export type PhaseBlockerCode = keyof typeof PHASE_BLOCKERS;
export const PHASE_BLOCKER_CODES = Object.keys(PHASE_BLOCKERS) as PhaseBlockerCode[];

/** Setup the operator does outside the work item: reviewer roles and verification hosts. */
export const SETUP_BLOCKER_CODES: ReadonlySet<PhaseBlockerCode> = new Set([
  'reviewer-assignment',
  'environment-approval',
  'resource-unsupported',
]);
