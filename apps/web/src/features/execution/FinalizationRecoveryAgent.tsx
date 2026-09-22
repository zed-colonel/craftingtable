import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { AGENT_BACKEND_LABELS, type FinalizationAgentSelection } from '@craftingtable/domain';
import { AgentSelectionFields } from './AgentSelectionFields.js';

export function FinalizationRecoveryAgent({
  mode,
  onMode,
  value,
  onChange,
  current,
  backends,
  disabled,
}: {
  mode: 'keep' | 'switch' | 'restore';
  onMode: (mode: 'keep' | 'switch' | 'restore') => void;
  value: FinalizationAgentSelection;
  onChange: (value: FinalizationAgentSelection) => void;
  current: FinalizationAgentSelection | null | undefined;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
}) {
  return (
    <fieldset className="stack-form" disabled={disabled}>
      <legend>Recovery agent</legend>
      <p>
        {current
          ? `Current override: ${AGENT_BACKEND_LABELS[current.backend]} · ${current.model ?? 'Backend default'}.`
          : 'Using the original per-step agent settings.'}
      </p>
      <label className="field">
        Agent settings
        <select value={mode} onChange={(e) => onMode(e.target.value as typeof mode)}>
          <option value="keep">Keep current settings</option>
          <option value="switch">Switch remaining finalization runs</option>
          {current && <option value="restore">Restore original settings</option>}
        </select>
      </label>
      {mode === 'switch' && (
        <AgentSelectionFields
          value={value}
          onChange={onChange}
          backends={backends}
          disabled={disabled}
        />
      )}
      {mode !== 'keep' && (
        <p>
          Applies when you submit this recovery and to all remaining assessment, polish, remediation
          and review runs. Each review remains a separate run. Existing step permissions, budgets
          and final approval requirements are retained. Conflict-resolution agents use their
          separate controls. You can change this choice again at a later checkpoint.
        </p>
      )}
    </fieldset>
  );
}
