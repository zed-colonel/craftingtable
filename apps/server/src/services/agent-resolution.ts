import {
  AGENT_PROFILE_PURPOSES,
  type AgentAssignmentId,
  type AgentPermissionMode,
  type AgentProfile,
  type AgentProfilePurpose,
  type AgentResolution,
  type AgentRunId,
  type AgentSelection,
  type AgentSelections,
  type AgentSelectionSource,
  type CycleProfiles,
  CYCLE_STEPS,
  type CycleStep,
  type DelegationAssignmentId,
  type EffectiveAgent,
  PROFILE_INHERITANCE,
  type SpecialistProfile,
  selectAgent,
  type WorkspaceAgentProfile,
} from '@craftingtable/domain';

/**
 * Everything one selection can come from, layer by layer (R-E5, E5-2). A place fills in the
 * layers it has; `resolveAgent` alone decides which wins. Each layer is a recorded choice; none is
 * read from storage here, so the resolver is pure.
 */
export type AgentContext = {
  /** The purpose being resolved: a step, or a specialist that inherits one. */
  readonly purpose: AgentProfilePurpose;
  /**
   * The permissions of the step the selection runs, which ADR-064 keeps with the step. A layer
   * that records its own permissions (a resumed session, a stage, a resolution, a retry, a
   * workspace default) runs with those instead.
   */
  readonly permissionMode?: AgentPermissionMode;
  /** The run a resumed session continues: it keeps its own agent. */
  readonly resumed?: AgentProfile;
  /** The choice of the command or record this launch belongs to. */
  readonly action?: {
    readonly layer:
      | 'design-recovery'
      | 'investigation'
      | 'decision-preparation'
      | 'integration-resolution';
    readonly selection: AgentSelection;
    readonly permissionMode?: AgentPermissionMode;
  };
  /**
   * A finalization step's agent: its stage's configured profile (the legacy final reviewer has no
   * stage index) and the recovery's change of agent, which keeps the stage's permissions (ADR-040).
   */
  readonly finalization?: {
    readonly stage: AgentProfile;
    readonly slot: 'review' | 'implement';
    readonly stageIndex?: number;
    readonly recovery?: AgentSelection | null;
  };
  /** The profile an integration resolution in progress recorded. */
  readonly integrationResolution?: AgentProfile;
  /** The roadmap's latest ADR-064 assignment covering the entry, whole. */
  readonly assignment?: { readonly id: AgentAssignmentId; readonly selections: AgentSelections };
  /** The retry profile a service retry recorded. */
  readonly serviceRetry?: AgentProfile;
  /** A cycle's own profiles, or a saved roadmap entry's (E5-1's lowest roadmap layer). */
  readonly profiles?: {
    readonly layer: 'saved-definition' | 'cycle-start';
    readonly value: CycleProfiles;
  };
  /**
   * A delegated integration resolution's profile: a grant's (with its id), or the saved
   * definition's automation. It applies to `conflict` only.
   */
  readonly delegation?: { readonly id?: DelegationAssignmentId; readonly profile: AgentProfile };
  /**
   * The run a hand-off continues (R-E5b): below the workspace's saved defaults, above the
   * daemon's, so a hand-off follows that run when no default is saved.
   */
  readonly continued?: { readonly runId: AgentRunId; readonly profile: AgentProfile };
  /** The workspace's saved defaults, and the daemon's default for a role none covers. */
  readonly workspace?: {
    readonly profiles: readonly WorkspaceAgentProfile[];
    readonly fallback: AgentProfile;
  };
};

type Candidate = AgentResolution & { readonly permissionMode?: AgentPermissionMode };

/**
 * The purposes whose profile `purpose` takes, nearest first: itself, then its base step, and
 * for remediation (and so conflict) implementation, as workspace defaults inherit.
 */
export function inheritanceChain(purpose: AgentProfilePurpose): readonly AgentProfilePurpose[] {
  const parent: AgentProfilePurpose | undefined =
    purpose === 'remediate' ? 'implement' : PROFILE_INHERITANCE[purpose as SpecialistProfile];
  return parent ? [purpose, ...inheritanceChain(parent)] : [purpose];
}

/** The step whose permissions a purpose runs with when nothing else gives them. */
export function baseStep(purpose: AgentProfilePurpose): CycleStep {
  return (CYCLE_STEPS as readonly string[]).includes(purpose)
    ? (purpose as CycleStep)
    : PROFILE_INHERITANCE[purpose as SpecialistProfile];
}

function candidate(
  selection: AgentSelection,
  source: AgentSelectionSource,
  permissionMode?: AgentPermissionMode,
): Candidate {
  return {
    selection: selectAgent(selection),
    source,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

/**
 * Every layer's answer for the purpose, in precedence order. This is the decision table:
 *
 * 1. a resumed session keeps its run's agent;
 * 2. the command's or record's own choice (design questions, an investigation, a decision
 *    preparation, the operator's integration resolution);
 * 3. finalization's recovery agent, then 4. the stage's profile (E5-3: a per-action override);
 * 5. an integration resolution's recorded profile;
 * 6. the latest ADR-064 assignment, whose specialist inherits within the assignment;
 * 7. a service retry's recorded profile;
 * 8. the cycle's or entry's own profile for the purpose, then 9. a delegated resolution's
 *    profile (conflict only), then 10. the profile the purpose inherits from those profiles.
 *    For conflict with a delegated or automation resolver, the assignment's inherited slots come
 *    after 9: only an assignment that names `conflict` itself displaces the resolver, its own
 *    permissions included (R-C17 part 4 increment 3 review HIGH-1; ADR-064 amended 2026-10-18);
 * 11. the workspace's saved default for the purpose or the nearest it inherits from;
 * 12. a hand-off's continued run;
 * 13. the daemon's default.
 */
function candidates(context: AgentContext): readonly Candidate[] {
  const { purpose, permissionMode: step } = context;
  const chain = inheritanceChain(purpose);
  const list: Candidate[] = [];
  if (context.resumed)
    list.push(
      candidate(context.resumed, { layer: 'resumed-session' }, context.resumed.permissionMode),
    );
  if (context.action)
    list.push(
      candidate(
        context.action.selection,
        { layer: context.action.layer },
        context.action.permissionMode ?? step,
      ),
    );
  const finalization = context.finalization;
  if (finalization) {
    const at = {
      slot: finalization.slot,
      ...(finalization.stageIndex === undefined ? {} : { stageIndex: finalization.stageIndex }),
    };
    if (finalization.recovery)
      list.push(
        candidate(
          finalization.recovery,
          { layer: 'finalization-recovery', ...at },
          finalization.stage.permissionMode,
        ),
      );
    list.push(
      candidate(
        finalization.stage,
        { layer: 'finalization-stage', ...at },
        finalization.stage.permissionMode,
      ),
    );
  }
  if (context.integrationResolution)
    list.push(
      candidate(
        context.integrationResolution,
        { layer: 'integration-resolution' },
        context.integrationResolution.permissionMode,
      ),
    );
  // A delegated or automation resolver keeps its rank over an assignment's inherited slots.
  const resolverFirst = purpose === 'conflict' && context.delegation !== undefined;
  const fromAssignment = (slots: readonly AgentProfilePurpose[]) => {
    if (!context.assignment) return;
    const { id, selections } = context.assignment;
    for (const slot of slots) {
      const selection = selections[slot];
      if (selection)
        list.push(
          candidate(selection, { layer: 'roadmap-assignment', slot, assignmentId: id }, step),
        );
    }
  };
  fromAssignment(resolverFirst ? chain.slice(0, 1) : chain);
  if (context.serviceRetry)
    list.push(
      candidate(
        context.serviceRetry,
        { layer: 'service-retry' },
        context.serviceRetry.permissionMode,
      ),
    );
  const profiles = context.profiles;
  const permission = step ?? profiles?.value[baseStep(purpose)].permissionMode;
  const fromProfiles = (slot: AgentProfilePurpose) => {
    const selection = profiles?.value[slot];
    if (profiles && selection)
      list.push(candidate(selection, { layer: profiles.layer, slot }, permission));
  };
  fromProfiles(purpose);
  if (context.delegation && purpose === 'conflict') {
    const { id, profile } = context.delegation;
    list.push(
      candidate(
        profile,
        id === undefined
          ? { layer: 'roadmap-automation' }
          : { layer: 'roadmap-delegation', delegationId: id },
        profile.permissionMode,
      ),
    );
  }
  if (resolverFirst) fromAssignment(chain.slice(1));
  for (const slot of chain.slice(1)) fromProfiles(slot);
  if (context.workspace) {
    const { profiles: saved } = context.workspace;
    for (const slot of chain) {
      const profile = saved.find((p) => p.role === slot);
      if (profile)
        list.push(candidate(profile, { layer: 'workspace-default', slot }, profile.permissionMode));
    }
  }
  if (context.continued)
    list.push(
      candidate(
        context.continued.profile,
        { layer: 'continued-run', runId: context.continued.runId },
        context.continued.profile.permissionMode,
      ),
    );
  if (context.workspace) {
    const { fallback } = context.workspace;
    list.push(candidate(fallback, { layer: 'daemon-default' }, fallback.permissionMode));
  }
  return list;
}

/**
 * The effective selection for one purpose and its source (R-E5, E5-2), with the value it
 * overrides: the next candidate in the table, so a slot's own value overrides the slot it would
 * inherit in the same layer, and a layer's value the layer below. Every selection the daemon
 * resolves comes from here.
 */
export function resolveAgent(context: AgentContext): EffectiveAgent {
  const [first, next] = candidates(context);
  if (!first) throw new Error(`No agent selection layer for ${context.purpose}.`);
  return {
    ...first,
    ...(next ? { inherited: { selection: next.selection, source: next.source } } : {}),
  };
}

/**
 * The effective selection for every purpose, from the same layers. With `steps`, each purpose
 * runs with its base step's permissions there, as a cycle's or an entry's launches would.
 */
export function resolveAgents(
  context: Omit<AgentContext, 'purpose'>,
  steps?: CycleProfiles,
): Readonly<Record<AgentProfilePurpose, EffectiveAgent>> {
  return Object.fromEntries(
    AGENT_PROFILE_PURPOSES.map((purpose) => [
      purpose,
      resolveAgent({
        ...context,
        purpose,
        ...(steps ? { permissionMode: steps[baseStep(purpose)].permissionMode } : {}),
      }),
    ]),
  ) as Record<AgentProfilePurpose, EffectiveAgent>;
}

/**
 * The selection set the resolutions make: every step, and each specialist the winning layer
 * names for itself, so a specialist that only inherits stays absent, as it is in the layer.
 */
export function selectionSet(
  resolved: Readonly<Record<AgentProfilePurpose, EffectiveAgent>>,
): AgentSelections {
  return Object.fromEntries(
    AGENT_PROFILE_PURPOSES.flatMap((purpose) =>
      (CYCLE_STEPS as readonly string[]).includes(purpose) ||
      resolved[purpose].source.slot === purpose
        ? [[purpose, resolved[purpose].selection]]
        : [],
    ),
  ) as AgentSelections;
}

/** A resolution as a launch takes it: the selection with its permissions. */
export function launchProfile(resolved: EffectiveAgent): AgentProfile {
  if (resolved.permissionMode === undefined)
    throw new Error('This resolution has no step permissions to launch with.');
  return { ...resolved.selection, permissionMode: resolved.permissionMode };
}
