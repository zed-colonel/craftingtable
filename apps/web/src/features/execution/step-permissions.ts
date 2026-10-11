import type { RunProfilesResponse, StepPermissions } from '@craftingtable/contracts';
import { CYCLE_STEPS, type CycleProfiles } from '@craftingtable/domain';

/**
 * Each step's permission mode: what a roadmap's settings save sends (R-E5b). Agents are not part
 * of it; they are chosen by ADR-064 assignment.
 */
export function stepPermissionsOf(profiles: CycleProfiles): StepPermissions {
  return Object.fromEntries(
    CYCLE_STEPS.map((step) => [step, profiles[step].permissionMode]),
  ) as StepPermissions;
}

/** The permissions a new entry or settings level starts from: the daemon's workspace defaults. */
export function defaultStepPermissions(agents: RunProfilesResponse['agents']): StepPermissions {
  return Object.fromEntries(
    CYCLE_STEPS.map((step) => [step, agents?.[step].permissionMode ?? 'auto']),
  ) as StepPermissions;
}
