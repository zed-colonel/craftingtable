import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  type AgentSelections,
  CYCLE_STEPS,
  PROFILE_INHERITANCE,
  PROFILE_LABELS,
  SPECIALIST_PROFILES,
  selectionsForPurpose,
} from '@craftingtable/domain';
import { AgentSelectionFields } from './AgentSelectionFields.js';

const description = (p: ReturnType<typeof selectionsForPurpose>) =>
  `${p.backend === 'codex' ? 'Codex' : 'Claude Code'} · ${p.model ?? 'backend default'}${p.reasoningEffort ? ` · ${p.reasoningEffort} effort` : ''}`;
export function AgentSelectionsEditor({
  value,
  onChange,
  backends,
  disabled = false,
  base = true,
  kept = [],
}: {
  value: AgentSelections;
  onChange: (v: AgentSelections) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled?: boolean;
  base?: boolean;
  /**
   * Overrides that are changed here but not removed: a stopped cycle's settings change can change
   * a specialist's agent but not drop its override (R-C17 part 4 increment 4 review M-1).
   */
  kept?: readonly string[];
}) {
  return (
    <>
      {base && (
        <div className="cycle-settings-grid agent-profiles-grid">
          {CYCLE_STEPS.map((p) => (
            <fieldset key={p} disabled={disabled}>
              <legend>{PROFILE_LABELS[p]}</legend>
              <AgentSelectionFields
                value={value[p]}
                onChange={(v) => onChange({ ...value, [p]: v })}
                backends={backends}
                disabled={disabled}
              />
            </fieldset>
          ))}
        </div>
      )}
      <details>
        <summary>
          Specialist overrides · {SPECIALIST_PROFILES.filter((p) => !!value[p]).length} configured
        </summary>
        {SPECIALIST_PROFILES.map((p) => (
          <fieldset key={p} disabled={disabled} className="stack-form">
            <legend>{PROFILE_LABELS[p]}</legend>
            <p className="hint">
              {value[p] ? 'Override' : `Inherits ${PROFILE_LABELS[PROFILE_INHERITANCE[p]]}`}:{' '}
              {description(selectionsForPurpose(value, p))}
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={!!value[p]}
                disabled={kept.includes(p)}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.checked) next[p] = { ...value[PROFILE_INHERITANCE[p]] };
                  else delete next[p];
                  onChange(next);
                }}
              />
              <span>Use a separate model for {PROFILE_LABELS[p].toLowerCase()}</span>
            </label>
            {kept.includes(p) && (
              <p className="hint">This override can be changed here, not removed.</p>
            )}
            {value[p] && (
              <AgentSelectionFields
                value={value[p]}
                onChange={(v) => onChange({ ...value, [p]: v })}
                backends={backends}
                disabled={disabled}
              />
            )}
          </fieldset>
        ))}
      </details>
    </>
  );
}
