import { AGENT_REASONING_EFFORTS, type AgentReasoningEffort } from '@craftingtable/domain';
export function ReasoningEffortField({
  value,
  onChange,
  disabled = false,
}: {
  value: AgentReasoningEffort | undefined;
  onChange: (v: AgentReasoningEffort | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      Reasoning effort
      <select
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value ? (e.target.value as AgentReasoningEffort) : undefined)
        }
      >
        <option value="">Use local Codex configuration</option>
        {AGENT_REASONING_EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e === 'xhigh' ? 'Extra high' : e[0]?.toUpperCase() + e.slice(1)}
          </option>
        ))}
      </select>
    </label>
  );
}
