import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_PERMISSION_MODES,
  type AgentBackendKind,
  type AgentPermissionMode,
} from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';
import { PERMISSION_MODE_LABELS } from '../../lib/execution-labels.js';
import type { HandoffChoice } from './handoff.js';
import { ModelField } from './ModelField.js';

/**
 * The one form every handoff uses: agent, model, and permissions pre-filled
 * from the role profile, editable before launch. Rendered inline wherever a
 * handoff button lives so the table and the run page behave the same.
 */
export function HandoffForm({
  label,
  backends,
  defaults,
  hint,
  busy,
  onLaunch,
  onCancel,
}: {
  /** Accessible name, e.g. "Remediate with". */
  label: string;
  backends: ExecutionStatusResponse['backends'];
  defaults: HandoffChoice;
  hint?: string;
  busy: boolean;
  onLaunch: (choice: HandoffChoice) => void;
  onCancel: () => void;
}) {
  const [backend, setBackend] = useState<AgentBackendKind>(defaults.backend);
  const [model, setModel] = useState(defaults.model ?? '');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    defaults.permissionMode,
  );
  const selected = backends.find((candidate) => candidate.kind === backend);
  const available = selected?.available === true;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!available) {
      return;
    }
    const trimmedModel = model.trim();
    onLaunch({
      backend,
      ...(trimmedModel.length === 0 ? {} : { model: trimmedModel }),
      permissionMode,
    });
  };

  return (
    <form className="inline-form handoff-form" aria-label={label} onSubmit={submit}>
      <span className="handoff-form-title">{label}</span>
      {backends.length > 1 && (
        <label className="field">
          Agent
          <select
            value={backend}
            onChange={(event) => {
              setBackend(event.target.value as AgentBackendKind);
              setModel('');
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
        value={model}
        onChange={setModel}
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
