import {
  AGENT_BACKEND_LABELS,
  type AgentProfilePurpose,
  type AgentSelection,
  type AgentSelectionLayer,
  type AgentSelectionSource,
  PROFILE_LABELS,
} from '@craftingtable/domain';

/**
 * Where an effective agent came from, in the operator's words (R-E5b). The daemon decides the
 * source (`resolveAgent`); these only name it. A per-action layer reads as "this …'s choice".
 */
export const AGENT_LAYER_LABELS: Readonly<Record<AgentSelectionLayer, string>> = {
  'daemon-default': 'Daemon default',
  'continued-run': 'The run it continues',
  'workspace-default': 'Workspace default',
  'saved-definition': 'Saved roadmap definition',
  'cycle-start': 'Chosen when the cycle started',
  'roadmap-automation': 'Roadmap integration policy',
  'roadmap-delegation': 'Delegation grant',
  'service-retry': 'Service retry',
  'roadmap-assignment': 'Roadmap assignment',
  'integration-resolution': 'This integration resolution',
  'finalization-stage': 'Finalization stage',
  'finalization-recovery': 'Finalization recovery agent',
  'design-recovery': 'Design-question recovery',
  investigation: 'This investigation',
  'decision-preparation': 'This decision preparation',
  'resumed-session': 'Resumed session',
};

/**
 * A source as one phrase: its layer, the slot it was read from when that is not the purpose
 * itself ("Workspace default, inherited from Implementation"), and a finalization stage's number.
 */
export function agentSourceLabel(
  source: AgentSelectionSource,
  purpose?: AgentProfilePurpose,
): string {
  const layer =
    source.layer === 'finalization-stage' || source.layer === 'finalization-recovery'
      ? `${AGENT_LAYER_LABELS[source.layer]}${source.stageIndex === undefined ? '' : ` ${source.stageIndex + 1}`}`
      : AGENT_LAYER_LABELS[source.layer];
  return source.slot !== undefined && purpose !== undefined && source.slot !== purpose
    ? `${layer}, inherited from ${PROFILE_LABELS[source.slot]}`
    : layer;
}

/** A selection as one line: the agent, its model and its effort, unset ones named as such. */
export function agentSelectionLabel(selection: AgentSelection): string {
  return `${AGENT_BACKEND_LABELS[selection.backend]} · ${selection.model ?? 'backend default'}${
    selection.reasoningEffort ? ` · ${selection.reasoningEffort} effort` : ''
  }`;
}
