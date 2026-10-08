import type { AgentBackendKind, AgentPermissionMode, AgentRun } from './execution.js';
import type { CycleStep, WorkCycle } from './work-cycle.js';

export const SPECIALIST_PROFILES = [
  'security',
  'checkpoint',
  'acceptance',
  'conflict',
  'investigation',
] as const;
export type SpecialistProfile = (typeof SPECIALIST_PROFILES)[number];
export const AGENT_PROFILE_PURPOSES = [
  'design',
  'implement',
  'review',
  'remediate',
  ...SPECIALIST_PROFILES,
] as const;
export type AgentProfilePurpose = (typeof AGENT_PROFILE_PURPOSES)[number];
export const AGENT_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];
/**
 * The one agent selection (R-E5, DATA-11): the backend, model and reasoning effort a launch
 * asks for. Every place that chooses an agent, from workspace defaults to a recovery's choice,
 * holds this shape; the permissions belong to the step that runs it.
 */
export type AgentSelection = {
  readonly backend: AgentBackendKind;
  readonly model?: string;
  readonly reasoningEffort?: AgentReasoningEffort;
};
/**
 * A selection with the permissions of the step it runs (ADR-064: the step owns them). These are
 * type aliases, not interfaces, so records holding them stay assignable to audit metadata.
 */
export type AgentProfile = AgentSelection & { readonly permissionMode: AgentPermissionMode };
/** A selection for each step, and for each specialist that has its own (ADR-064 assignments). */
export type AgentSelections = Readonly<
  Record<CycleStep, AgentSelection> & Partial<Record<SpecialistProfile, AgentSelection>>
>;
/** A cycle's or a saved roadmap entry's profiles: each step's profile, each specialist's selection. */
export type CycleProfiles = Readonly<
  Record<CycleStep, AgentProfile> & Partial<Record<SpecialistProfile, AgentSelection>>
>;
/** A workspace default: a profile for one purpose (`workspace_run_profiles`). */
export type WorkspaceAgentProfile = AgentProfile & { readonly role: AgentProfilePurpose };
/**
 * Where an effective selection came from (R-E5, E5-2): the layer of the daemon's resolution
 * (`resolveAgent`) that supplied it, lowest first. A workspace default is the lowest a new
 * choice starts from; a saved roadmap definition's profiles are the lowest a roadmap's work
 * reads (E5-1); `cycle-start` is a cycle's own profiles, chosen when it was started on its own;
 * an ADR-064 assignment and a delegation grant are the roadmap's operational choices; the rest
 * are per-action choices, finalization's stage profiles among them (E5-3).
 */
export const AGENT_SELECTION_LAYERS = [
  'daemon-default',
  'workspace-default',
  'saved-definition',
  'cycle-start',
  'roadmap-delegation',
  'service-retry',
  'roadmap-assignment',
  'integration-resolution',
  'finalization-stage',
  'finalization-recovery',
  'design-recovery',
  'investigation',
  'decision-preparation',
  'resumed-session',
] as const;
export type AgentSelectionLayer = (typeof AGENT_SELECTION_LAYERS)[number];
/** A selection's source: its layer, and which slot and record of that layer supplied it. */
export type AgentSelectionSource = {
  readonly layer: AgentSelectionLayer;
  /**
   * The purpose whose profile the layer supplied: the one asked for, or the one it inherits
   * (`PROFILE_INHERITANCE`; remediation inherits implementation among workspace defaults).
   */
  readonly slot?: AgentProfilePurpose;
  /** The ADR-064 assignment, for `roadmap-assignment`. */
  readonly assignmentId?: string;
  /** The delegation grant, for `roadmap-delegation`. */
  readonly delegationId?: string;
  /** The finalization stage, for `finalization-stage` and `finalization-recovery`. */
  readonly stageIndex?: number;
};
/** A selection and where it came from. */
export type AgentResolution = {
  readonly selection: AgentSelection;
  readonly source: AgentSelectionSource;
};
/**
 * What the daemon reports as an effective selection (R-E5a): the selection, its source, the
 * permissions it runs with when the place has them, and what it overrides, which is the value the
 * next layer down would give. The browser shows these; it derives none of them.
 */
export type EffectiveAgent = AgentResolution & {
  readonly permissionMode?: AgentPermissionMode;
  readonly inherited?: AgentResolution;
};
export const PROFILE_LABELS: Record<AgentProfilePurpose, string> = {
  design: 'Design',
  implement: 'Implementation',
  review: 'Review',
  remediate: 'Remediation',
  security: 'Security review',
  checkpoint: 'Technical checkpoint review',
  acceptance: 'Parent acceptance',
  conflict: 'Integration conflict resolution',
  investigation: 'Evidence investigation',
};
export const PROFILE_INHERITANCE: Record<SpecialistProfile, CycleStep> = {
  security: 'review',
  checkpoint: 'review',
  acceptance: 'review',
  conflict: 'remediate',
  investigation: 'design',
};
export function selectAgent(profile: AgentSelection): AgentSelection {
  return {
    backend: profile.backend,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  };
}
export function agentSelections(profiles: CycleProfiles): AgentSelections {
  return Object.fromEntries(
    AGENT_PROFILE_PURPOSES.flatMap((p) => (profiles[p] ? [[p, selectAgent(profiles[p])]] : [])),
  ) as AgentSelections;
}
export function profileForPurpose(
  profiles: CycleProfiles,
  purpose: AgentProfilePurpose,
): AgentProfile {
  const base =
    purpose in PROFILE_INHERITANCE
      ? PROFILE_INHERITANCE[purpose as SpecialistProfile]
      : (purpose as CycleStep);
  const selected = profiles[purpose] ?? profiles[base];
  return { ...selectAgent(selected), permissionMode: profiles[base].permissionMode };
}
export function selectionsForPurpose(
  profiles: AgentSelections,
  purpose: AgentProfilePurpose,
): AgentSelection {
  return profiles[purpose] ?? profiles[PROFILE_INHERITANCE[purpose as SpecialistProfile]];
}
export function cycleProfilePurpose(cycle: WorkCycle): AgentProfilePurpose {
  if (
    cycle.integrationResolution &&
    ['preparing', 'resolving', 'committing'].includes(cycle.integrationResolution.status)
  )
    return 'conflict';
  if (
    cycle.designRecovery?.mode === 'investigate' &&
    cycle.designRecovery.runId === cycle.currentRunId
  )
    return 'investigation';
  if (cycle.workflow?.activeReview?.kind === 'security') return 'security';
  if (cycle.workflow?.activeReview?.kind === 'checkpoint') return 'checkpoint';
  if (cycle.workflow?.activeReview?.kind === 'reassessment') return 'investigation';
  if (cycle.step === 'review' && cycle.executionScope?.kind === 'parent-acceptance')
    return 'acceptance';
  return cycle.step;
}
export function cycleProfilesFromDefaults(
  profiles: readonly (WorkspaceAgentProfile & { readonly stored?: boolean })[],
  fallback: AgentProfile,
): CycleProfiles {
  const choose = (p: AgentProfilePurpose) => profiles.find((x) => x.role === p);
  const result = Object.fromEntries(
    ['design', 'implement', 'review', 'remediate'].map((p) => {
      const selected =
        choose(p as AgentProfilePurpose) ??
        (p === 'remediate' ? choose('implement') : undefined) ??
        fallback;
      return [p, { ...selectAgent(selected), permissionMode: selected.permissionMode }];
    }),
  ) as unknown as CycleProfiles;
  return {
    ...result,
    ...Object.fromEntries(
      SPECIALIST_PROFILES.flatMap((p) => {
        const selected = choose(p);
        return selected?.stored ? [[p, selectAgent(selected)]] : [];
      }),
    ),
  };
}
export function matchingAgent(run: AgentRun, profile: AgentProfile): boolean {
  return (
    run.backend === profile.backend &&
    run.model === profile.model &&
    run.permissionMode === profile.permissionMode &&
    run.reasoningEffort === profile.reasoningEffort
  );
}
