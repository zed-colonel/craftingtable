import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_PERMISSION_MODES,
  type AgentBackendKind,
  type AgentPermissionMode,
  type EffectiveAgent,
} from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';
import { PERMISSION_MODE_LABELS } from '../../lib/execution-labels.js';
import { EffectiveAgentText } from './EffectiveAgentText.js';
import type { HandoffChoice } from './handoff.js';
import { ModelField } from './ModelField.js';
import { ReasoningEffortField } from './ReasoningEffortField.js';

/**
 * The one form every handoff uses: agent, model, and permissions pre-filled from the daemon's
 * default (`defaultAgent`, named with its source; R-E5b), editable for this launch. Rendered
 * inline wherever a handoff button lives so the table and the run page behave the same.
 */
export function HandoffForm({
  label,
  backends,
  defaults,
  defaultAgent,
  hint,
  placeholder,
  busy,
  onLaunch,
  onCancel,
  maxInstructionsLength = 20000,
}: {
  /** Accessible name, e.g. "Remediate with". */
  label: string;
  backends: ExecutionStatusResponse['backends'];
  defaults: HandoffChoice;
  /** Where `defaults` came from, as the daemon reports it. */
  defaultAgent?: EffectiveAgent;
  hint?: string;
  /** Example guidance shown in the empty instructions box. */
  placeholder?: string;
  busy: boolean;
  onLaunch: (choice: HandoffChoice) => void;
  onCancel: () => void;
  maxInstructionsLength?: number;
}) {
  const [backend, setBackend] = useState<AgentBackendKind>(defaults.backend);
  const [model, setModel] = useState(defaults.model ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<
    import('@craftingtable/domain').AgentReasoningEffort | undefined
  >(defaults?.reasoningEffort);
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    defaults.permissionMode,
  );
  const [instructions, setInstructions] = useState('');
  const selected = backends.find((candidate) => candidate.kind === backend);
  const available = selected?.available === true;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!available) {
      return;
    }
    const trimmedModel = model.trim();
    const trimmedInstructions = instructions.trim();
    onLaunch({
      backend,
      ...(trimmedModel.length === 0 ? {} : { model: trimmedModel }),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      permissionMode,
      ...(trimmedInstructions.length === 0 ? {} : { instructions: trimmedInstructions }),
    });
  };

  return (
    <form className="inline-form handoff-form" aria-label={label} onSubmit={submit}>
      <span className="handoff-form-title">{label}</span>
      {defaultAgent !== undefined && (
        <p className="hint handoff-form-hint">
          Starts from <EffectiveAgentText agent={defaultAgent} />
        </p>
      )}
      {backends.length > 1 && (
        <label className="field">
          Agent
          <select
            value={backend}
            onChange={(event) => {
              setBackend(event.target.value as AgentBackendKind);
              setModel('');
              setReasoningEffort(undefined);
            }}
            disabled={busy}
          >
            {backends.map((candidate) => (
              <option key={candidate.kind} value={candidate.kind} disabled={!candidate.available}>
                {candidate.label}
                {candidate.available ? '' : ' (not found)'}
              </option>
            ))}
          </select>
        </label>
      )}
      <ModelField
        key={backend}
        models={selected?.models ?? []}
        catalog={selected?.catalog}
        value={model}
        onChange={setModel}
        disabled={busy}
      />
      <ReasoningEffortField
        backend={backend}
        value={reasoningEffort}
        onChange={setReasoningEffort}
        disabled={busy}
      />
      <label className="field">
        Permissions
        <select
          value={permissionMode}
          onChange={(event) => setPermissionMode(event.target.value as AgentPermissionMode)}
          disabled={busy}
        >
          {AGENT_PERMISSION_MODES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {PERMISSION_MODE_LABELS[candidate]}
            </option>
          ))}
        </select>
      </label>
      <label className="field handoff-form-instructions">
        Instructions for this run (optional)
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={2}
          disabled={busy}
          maxLength={maxInstructionsLength}
          {...(placeholder === undefined ? {} : { placeholder })}
        />
      </label>
      <button type="submit" className="primary-button" disabled={busy || !available}>
        Launch
      </button>
      <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      {hint !== undefined && <p className="hint handoff-form-hint">{hint}</p>}
    </form>
  );
}
