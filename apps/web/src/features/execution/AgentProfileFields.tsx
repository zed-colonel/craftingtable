import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import type { AgentRunProfile } from '@craftingtable/domain';
import { AgentSelectionFields } from './AgentSelectionFields.js';
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
      <AgentSelectionFields
        value={value}
        onChange={(selection) => onChange({ ...selection, permissionMode: value.permissionMode })}
        backends={backends}
        disabled={disabled}
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
