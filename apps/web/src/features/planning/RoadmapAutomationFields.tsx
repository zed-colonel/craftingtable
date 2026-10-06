import type { ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  DEFAULT_ROADMAP_AUTOMATION,
  type RoadmapAutomation,
} from '@craftingtable/domain';
import { ModelField } from '../execution/ModelField.js';

export function RoadmapAutomationFields({
  value,
  onChange,
  disabled,
  backends,
}: {
  value?: RoadmapAutomation;
  onChange: (value: RoadmapAutomation) => void;
  disabled: boolean;
  backends: ExecutionStatusResponse['backends'];
}) {
  const policy = value ?? DEFAULT_ROADMAP_AUTOMATION;
  const profile = policy.resolutionProfile;
  return (
    <fieldset disabled={disabled} className="stack-form">
      <legend>Integration automation</legend>
      <label className="field">
        Integration merge
        <select
          value={policy.integrationMerge}
          onChange={(e) =>
            onChange({ ...policy, integrationMerge: e.target.value as 'manual' | 'automatic' })
          }
        >
          <option value="manual">Require my approval</option>
          <option value="automatic">Automatically merge when ready</option>
        </select>
      </label>
      <label className="field">
        Integration conflicts
        <select
          value={policy.integrationConflicts}
          onChange={(e) =>
            onChange({ ...policy, integrationConflicts: e.target.value as 'manual' | 'automatic' })
          }
        >
          <option value="manual">Ask me to delegate resolution</option>
          <option value="automatic">Delegate resolution automatically</option>
        </select>
      </label>
      {policy.integrationConflicts === 'automatic' && (
        <>
          <label className="field">
            Conflict resolution agent
            <select
              value={profile?.backend ?? ''}
              onChange={(e) => {
                const { resolutionProfile: _prior, ...rest } = policy;
                onChange(
                  e.target.value
                    ? {
                        ...rest,
                        resolutionProfile: {
                          backend: e.target.value as 'claude-code' | 'codex',
                          permissionMode: 'auto',
                        },
                      }
                    : rest,
                );
              }}
            >
              <option value="">Use each item's remediation profile</option>
              {backends
                .filter((b) => b.available)
                .map((b) => (
                  <option key={b.kind} value={b.kind}>
                    {AGENT_BACKEND_LABELS[b.kind]}
                  </option>
                ))}
            </select>
          </label>
          {profile && (
            <>
              <ModelField
                models={backends.find((b) => b.kind === profile.backend)?.models ?? []}
                catalog={backends.find((b) => b.kind === profile.backend)?.catalog}
                value={profile.model ?? ''}
                disabled={disabled}
                onChange={(model) => {
                  const { model: _prior, ...rest } = profile;
                  onChange({ ...policy, resolutionProfile: model ? { ...rest, model } : rest });
                }}
              />
              <label className="field">
                Conflict resolution permissions
                <select
                  value={profile.permissionMode}
                  onChange={(e) =>
                    onChange({
                      ...policy,
                      resolutionProfile: {
                        ...profile,
                        permissionMode: e.target.value as 'auto' | 'edit-only' | 'unrestricted',
                      },
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="edit-only">Edit only</option>
                  <option value="unrestricted">Unrestricted</option>
                </select>
              </label>
            </>
          )}
        </>
      )}
      <p className="hint">
        Questions and failed recovery still require attention. Every integration update requires
        fresh review. Protected branches always require your approval.
      </p>
    </fieldset>
  );
}
