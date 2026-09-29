import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import type { AgentSelection } from '@craftingtable/domain';
import { ModelField } from './ModelField.js';
import { ReasoningEffortField } from './ReasoningEffortField.js';
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
      <ReasoningEffortField
        backend={value.backend}
        value={value.reasoningEffort}
        disabled={disabled}
        onChange={(effort) => {
          const { reasoningEffort: _old, ...rest } = value;
          onChange(effort ? { ...rest, reasoningEffort: effort } : rest);
        }}
      />
    </div>
  );
}
