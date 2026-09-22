import type { AgentRun, AgentRunProfile } from './execution.js';
import type { CycleProfiles, CycleStep, WorkCycle } from './work-cycle.js';

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
export type AgentSelection = Pick<AgentRunProfile, 'backend' | 'model' | 'reasoningEffort'>;
export type AgentSelections = Readonly<
  Record<CycleStep, AgentSelection> & Partial<Record<SpecialistProfile, AgentSelection>>
>;
export type WorkspaceAgentProfile = Omit<AgentRunProfile, 'role'> & {
  readonly role: AgentProfilePurpose;
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
    ...(profile.backend === 'codex' && profile.reasoningEffort
      ? { reasoningEffort: profile.reasoningEffort }
      : {}),
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
): Omit<AgentRunProfile, 'role'> {
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
  fallback: Omit<AgentRunProfile, 'role'>,
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
export function matchingAgent(run: AgentRun, profile: Omit<AgentRunProfile, 'role'>): boolean {
  return (
    run.backend === profile.backend &&
    run.model === profile.model &&
    run.permissionMode === profile.permissionMode &&
    run.reasoningEffort === profile.reasoningEffort
  );
}
