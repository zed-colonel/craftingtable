import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import { AGENT_BACKEND_LABELS, type AgentRunProfile } from '@craftingtable/domain';
import { ModelField } from './ModelField.js';
export function AgentProfileFields({
  label,
  value,
  onChange,
  backends,
  disabled,
}: {
  label: string;
  value: Omit<AgentRunProfile, 'role'>;
  onChange: (value: Omit<AgentRunProfile, 'role'>) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="stack-form">
      <legend>{label}</legend>
      <label className="field">
        Agent
        <select
          value={value.backend}
          onChange={(e) =>
            onChange({
              backend: e.target.value as 'claude-code' | 'codex',
              permissionMode: value.permissionMode,
            })
          }
        >
          {backends.map((b) => (
            <option key={b.kind} value={b.kind} disabled={!b.available}>
              {AGENT_BACKEND_LABELS[b.kind]}
            </option>
          ))}
        </select>
      </label>
      <ModelField
        models={backends.find((b) => b.kind === value.backend)?.models ?? []}
        value={value.model ?? ''}
        disabled={disabled}
        onChange={(model) => {
          const { model: _old, ...profile } = value;
          onChange(model ? { ...profile, model } : profile);
        }}
      />
      <label className="field">
        Permissions
        <select
          value={value.permissionMode}
          onChange={(e) =>
            onChange({
              ...value,
              permissionMode: e.target.value as 'auto' | 'edit-only' | 'unrestricted',
            })
          }
        >
          <option value="auto">Auto</option>
          <option value="edit-only">Edit only</option>
          <option value="unrestricted">Unrestricted</option>
        </select>
      </label>
    </fieldset>
  );
}
