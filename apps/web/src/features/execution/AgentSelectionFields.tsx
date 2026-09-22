import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { AGENT_REASONING_EFFORTS, type AgentSelection } from '@craftingtable/domain';
import { ModelField } from './ModelField.js';
export function AgentSelectionFields({
  value,
  onChange,
  backends,
  disabled = false,
}: {
  value: AgentSelection;
  onChange: (v: AgentSelection) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled?: boolean;
}) {
  return (
    <div className="form-row">
      <label className="field">
        Agent
        <select
          value={value.backend}
          disabled={disabled}
          onChange={(e) => onChange({ backend: e.target.value as AgentSelection['backend'] })}
        >
          {backends.map((b) => (
            <option key={b.kind} value={b.kind} disabled={!b.available}>
              {b.label}
              {b.available ? '' : ' (unavailable)'}
            </option>
          ))}
          {!backends.some((b) => b.kind === value.backend) && (
            <option value={value.backend}>{value.backend}</option>
          )}
        </select>
      </label>
      <ModelField
        models={backends.find((b) => b.kind === value.backend)?.models ?? []}
        value={value.model ?? ''}
        disabled={disabled}
        onChange={(model) => {
          const { model: _old, ...rest } = value;
          onChange(model.trim() ? { ...rest, model: model.trim() } : rest);
        }}
      />
      {value.backend === 'codex' && (
        <label className="field">
          Reasoning effort
          <select
            value={value.reasoningEffort ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const { reasoningEffort: _old, ...rest } = value;
              onChange(
                e.target.value
                  ? {
                      ...rest,
                      reasoningEffort: e.target.value as NonNullable<
                        AgentSelection['reasoningEffort']
                      >,
                    }
                  : rest,
              );
            }}
          >
            <option value="">Use local Codex configuration</option>
            {AGENT_REASONING_EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e === 'xhigh' ? 'Extra high' : e[0]?.toUpperCase() + e.slice(1)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
