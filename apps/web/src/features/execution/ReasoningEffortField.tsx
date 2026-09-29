import {
  AGENT_REASONING_EFFORTS,
  type AgentBackendKind,
  type AgentReasoningEffort,
} from '@craftingtable/domain';

/**
 * What an unset effort means for a backend: Codex reads the operator's Codex configuration;
 * Claude runs load no operator settings (R-G5), so they get Claude Code's own default.
 */
export function defaultEffortLabel(backend: AgentBackendKind): string {
  return backend === 'codex' ? 'Local Codex configuration' : "Claude Code's default";
}

export function ReasoningEffortField({
  backend,
  value,
  onChange,
  disabled = false,
}: {
  backend: AgentBackendKind;
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
        <option value="">
          {backend === 'codex' ? 'Use local Codex configuration' : "Use Claude Code's default"}
        </option>
        {AGENT_REASONING_EFFORTS.map((e) => (
          <option key={e} value={e}>
            {e === 'xhigh' ? 'Extra high' : e[0]?.toUpperCase() + e.slice(1)}
          </option>
        ))}
      </select>
    </label>
  );
}
