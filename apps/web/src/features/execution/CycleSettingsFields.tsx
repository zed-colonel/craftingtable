import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_PERMISSION_MODES,
  CYCLE_STEPS,
  type AgentBackendKind,
  type AgentPermissionMode,
  type CompletionPolicy,
  type CycleProfiles,
} from '@craftingtable/domain';
import { ModelField } from './ModelField.js';
import { PERMISSION_MODE_LABELS } from '../../lib/execution-labels.js';
export function CycleSettingsFields({
  policy,
  setPolicy,
  choices,
  setChoices,
  instructions,
  setInstructions,
  backends,
  disabled,
}: {
  policy: CompletionPolicy;
  setPolicy: (policy: CompletionPolicy) => void;
  choices: CycleProfiles;
  setChoices: (profiles: CycleProfiles) => void;
  instructions: string;
  setInstructions: (instructions: string) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
}) {
  return (
    <>
      <p>
        Completion requires zero open blocking, major, or minor findings and a mergeable review with
        its exit gate met.
      </p>
      <div className="cycle-settings-grid">
        <label className="field">
          Allowed nits
          <input
            type="number"
            min={0}
            max={100}
            required
            value={policy.maxNits}
            disabled={disabled}
            onChange={(event) => setPolicy({ ...policy, maxNits: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          Maximum remediation rounds
          <input
            type="number"
            min={0}
            max={20}
            required
            value={policy.maxRemediationRounds}
            disabled={disabled}
            onChange={(event) =>
              setPolicy({ ...policy, maxRemediationRounds: Number(event.target.value) })
            }
          />
        </label>
        <label className="field">
          Minutes per step
          <input
            type="number"
            min={1}
            max={1440}
            required
            value={policy.maxRunMinutes}
            disabled={disabled}
            onChange={(event) =>
              setPolicy({ ...policy, maxRunMinutes: Number(event.target.value) })
            }
          />
        </label>
      </div>
      <div className="cycle-settings-grid">
        {CYCLE_STEPS.map((step) => (
          <fieldset key={step} disabled={disabled}>
            <legend>
              {step[0]?.toUpperCase()}
              {step.slice(1)}
            </legend>
            <label className="field">
              Agent
              <select
                value={choices[step].backend}
                onChange={(event) =>
                  setChoices({
                    ...choices,
                    [step]: {
                      backend: event.target.value as AgentBackendKind,
                      permissionMode: choices[step].permissionMode,
                    },
                  })
                }
              >
                {backends.map((backend) => (
                  <option key={backend.kind} value={backend.kind} disabled={!backend.available}>
                    {backend.label}
                    {backend.available ? '' : ' (unavailable)'}
                  </option>
                ))}
              </select>
            </label>
            <ModelField
              key={choices[step].backend}
              models={
                backends.find((backend) => backend.kind === choices[step].backend)?.models ?? []
              }
              value={choices[step].model ?? ''}
              disabled={disabled}
              onChange={(model) => {
                const { model: _old, ...choice } = choices[step];
                setChoices({
                  ...choices,
                  [step]: { ...choice, ...(model.trim() === '' ? {} : { model }) },
                });
              }}
            />
            <label className="field">
              Permissions
              <select
                title={PERMISSION_MODE_LABELS[choices[step].permissionMode]}
                value={choices[step].permissionMode}
                onChange={(event) =>
                  setChoices({
                    ...choices,
                    [step]: {
                      ...choices[step],
                      permissionMode: event.target.value as AgentPermissionMode,
                    },
                  })
                }
              >
                {AGENT_PERMISSION_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'auto' ? 'Auto' : mode === 'edit-only' ? 'Edit only' : 'Unrestricted'}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        ))}
      </div>
      <label className="field">
        Instructions for every step
        <textarea
          value={instructions}
          maxLength={16000}
          rows={3}
          disabled={disabled}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
    </>
  );
}
