import type { ExecutionStatusResponse, StepPermissions } from '@craftingtable/contracts';
import {
  AGENT_PERMISSION_MODES,
  type AgentPermissionMode,
  agentSelections,
  type CompletionPolicy,
  CYCLE_STEPS,
  type CycleProfiles,
  PROFILE_LABELS,
} from '@craftingtable/domain';
import { PERMISSION_MODE_LABELS } from '../../lib/execution-labels.js';
import { AgentSelectionFields } from './AgentSelectionFields.js';
import { AgentSelectionsEditor } from './AgentSelectionsEditor.js';
/**
 * A cycle's settings: its completion policy, each step's agent and permissions, and its
 * instructions. A roadmap's settings form passes `permissions` instead of `choices` (R-E5b): its
 * save carries each step's permission mode, and its agents are edited beside it, by assignment.
 */
export function CycleSettingsFields({
  policy,
  setPolicy,
  choices,
  setChoices,
  permissions,
  setPermissions,
  instructions,
  setInstructions,
  backends,
  disabled,
  profilesLocked = false,
}: {
  policy: CompletionPolicy;
  setPolicy: (policy: CompletionPolicy) => void;
  instructions: string;
  setInstructions: (instructions: string) => void;
  backends: ExecutionStatusResponse['backends'];
  disabled: boolean;
  profilesLocked?: boolean;
} & (
  | {
      choices: CycleProfiles;
      setChoices: (profiles: CycleProfiles) => void;
      permissions?: undefined;
      setPermissions?: undefined;
    }
  | {
      choices?: undefined;
      setChoices?: undefined;
      permissions: StepPermissions;
      setPermissions: (permissions: StepPermissions) => void;
    }
)) {
  if (permissions)
    return (
      <>
        <PolicyFields policy={policy} setPolicy={setPolicy} disabled={disabled} />
        <div className="cycle-settings-grid">
          {CYCLE_STEPS.map((step) => (
            <PermissionField
              key={step}
              label={`${PROFILE_LABELS[step]} permissions`}
              value={permissions[step]}
              disabled={disabled}
              onChange={(mode) => setPermissions({ ...permissions, [step]: mode })}
            />
          ))}
        </div>
        <InstructionsField
          instructions={instructions}
          setInstructions={setInstructions}
          disabled={disabled}
        />
      </>
    );
  return (
    <>
      <PolicyFields policy={policy} setPolicy={setPolicy} disabled={disabled} />
      <div className="cycle-settings-grid">
        {CYCLE_STEPS.map((step) => (
          <fieldset key={step} disabled={disabled}>
            <legend>{PROFILE_LABELS[step]}</legend>
            <AgentSelectionFields
              value={choices[step]}
              onChange={(value) =>
                setChoices({
                  ...choices,
                  [step]: { ...value, permissionMode: choices[step].permissionMode },
                })
              }
              backends={backends}
              disabled={disabled || profilesLocked}
            />
            <PermissionField
              label="Permissions"
              value={choices[step].permissionMode}
              disabled={disabled}
              onChange={(permissionMode) =>
                setChoices({ ...choices, [step]: { ...choices[step], permissionMode } })
              }
            />
          </fieldset>
        ))}
      </div>
      <AgentSelectionsEditor
        base={false}
        value={agentSelections(choices)}
        onChange={(value) =>
          setChoices({
            ...value,
            ...Object.fromEntries(
              CYCLE_STEPS.map((step) => [
                step,
                { ...value[step], permissionMode: choices[step].permissionMode },
              ]),
            ),
          } as CycleProfiles)
        }
        backends={backends}
        disabled={disabled || profilesLocked}
      />
      <InstructionsField
        instructions={instructions}
        setInstructions={setInstructions}
        disabled={disabled}
      />
    </>
  );
}

function PolicyFields({
  policy,
  setPolicy,
  disabled,
}: {
  policy: CompletionPolicy;
  setPolicy: (policy: CompletionPolicy) => void;
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
    </>
  );
}

/** One step's permission mode. */
export function PermissionField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: AgentPermissionMode;
  onChange: (mode: AgentPermissionMode) => void;
  disabled: boolean;
}) {
  return (
    <label className="field">
      {label}
      <select
        title={PERMISSION_MODE_LABELS[value]}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AgentPermissionMode)}
      >
        {AGENT_PERMISSION_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode === 'auto' ? 'Auto' : mode === 'edit-only' ? 'Edit only' : 'Unrestricted'}
          </option>
        ))}
      </select>
    </label>
  );
}

function InstructionsField({
  instructions,
  setInstructions,
  disabled,
}: {
  instructions: string;
  setInstructions: (instructions: string) => void;
  disabled: boolean;
}) {
  return (
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
  );
}
