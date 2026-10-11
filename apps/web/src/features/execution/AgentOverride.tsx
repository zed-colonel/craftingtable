import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import type { AgentProfilePurpose, AgentSelection, EffectiveAgent } from '@craftingtable/domain';
import { AgentSelectionFields } from './AgentSelectionFields.js';
import { EffectiveAgentText } from './EffectiveAgentText.js';

/**
 * A per-action agent (R-E5b): the agent the action takes and where it came from, as the daemon
 * reports it, with a "Change for this action" disclosure for a one-off choice. `value` is that
 * choice, absent while the daemon's agent stands; the action sends `value ?? agent.selection`.
 */
export function AgentOverride({
  label = 'Agent',
  agent,
  purpose,
  value,
  onChange,
  backends,
  disabled,
  change = 'Change for this action',
}: {
  label?: string;
  agent: EffectiveAgent | undefined;
  purpose?: AgentProfilePurpose;
  value: AgentSelection | undefined;
  onChange: (value: AgentSelection | undefined) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
  /** The disclosure's name: "Change for this action", or "Change for this stage". */
  change?: string;
}) {
  const chosen = value ?? agent?.selection;
  const available = !chosen || backends.some((b) => b.kind === chosen.backend && b.available);
  return (
    <div className="agent-override">
      <p>
        {label}:{' '}
        {agent ? (
          value === undefined ? (
            <EffectiveAgentText agent={agent} {...(purpose ? { purpose } : {})} />
          ) : (
            <span className="mono">
              {backends.find((b) => b.kind === value.backend)?.label ?? value.backend} ·{' '}
              {value.model ?? 'backend default'}
              {value.reasoningEffort ? ` · ${value.reasoningEffort} effort` : ''}
            </span>
          )
        ) : (
          'Loading…'
        )}
        {value !== undefined && <span className="agent-source"> · changed for this action</span>}
        {!available && ' (unavailable on this workstation; choose another)'}
      </p>
      <details className="disclosure" open={value !== undefined || !available}>
        <summary>{change}</summary>
        <div className="disclosure-body stack-form">
          {chosen && (
            <AgentSelectionFields
              value={chosen}
              backends={backends}
              disabled={disabled}
              onChange={onChange}
            />
          )}
          {value !== undefined && agent && (
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => onChange(undefined)}
            >
              Undo the change
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
