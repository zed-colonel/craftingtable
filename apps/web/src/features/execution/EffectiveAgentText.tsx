import type { AgentProfilePurpose, EffectiveAgent } from '@craftingtable/domain';
import { agentSelectionLabel, agentSourceLabel } from '../../lib/agent-labels.js';

/**
 * An effective agent as the daemon reports it (R-E5b): the selection, then where it came from.
 * With `overrides`, also what it overrides, the value the place would have without it.
 */
export function EffectiveAgentText({
  agent,
  purpose,
  overrides = false,
}: {
  agent: EffectiveAgent;
  purpose?: AgentProfilePurpose;
  overrides?: boolean;
}) {
  return (
    <span className="effective-agent">
      <span className="mono">{agentSelectionLabel(agent.selection)}</span>{' '}
      <span className="agent-source">· {agentSourceLabel(agent.source, purpose)}</span>
      {overrides && agent.inherited && (
        <span className="agent-source">
          {' '}
          (over {agentSelectionLabel(agent.inherited.selection)},{' '}
          {agentSourceLabel(agent.inherited.source, purpose).toLowerCase()})
        </span>
      )}
    </span>
  );
}
