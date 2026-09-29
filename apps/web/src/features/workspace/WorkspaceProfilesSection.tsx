import type { AgentRunProfileEntry, ExecutionStatusResponse } from '@craftingtable/contracts';
import {
  AGENT_BACKEND_LABELS,
  type AgentSelections,
  agentSelections,
  CYCLE_STEPS,
  type CycleProfiles,
  cycleProfilesFromDefaults,
  PROFILE_INHERITANCE,
  PROFILE_LABELS,
  SPECIALIST_PROFILES,
  type WorkspaceAgentProfile,
} from '@craftingtable/domain';
import { useState } from 'react';
import { Section } from '../../components/Section.js';
import { AgentSelectionsEditor } from '../execution/AgentSelectionsEditor.js';
import { defaultEffortLabel } from '../execution/ReasoningEffortField.js';
import { AgentRecommendations } from './AgentRecommendations.js';
export function WorkspaceProfilesSection({
  profiles,
  backends,
  canEdit,
  busy,
  error,
  notice,
  onSave,
}: {
  profiles: readonly AgentRunProfileEntry[];
  backends: ExecutionStatusResponse['backends'];
  canEdit: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  onSave: (p: readonly WorkspaceAgentProfile[]) => void;
}) {
  const initial = () =>
    cycleProfilesFromDefaults(profiles, { backend: 'claude-code', permissionMode: 'auto' });
  const [draft, setDraft] = useState<{ profiles: CycleProfiles; selections: AgentSelections }>();
  const current = initial();
  return (
    <Section
      title="Agent profiles"
      summary="Workspace defaults for new work. Existing roadmaps keep their selections until you explicitly apply a change."
    >
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Default</th>
              <th>Agent / model</th>
              <th>Reasoning effort</th>
            </tr>
          </thead>
          <tbody>
            {CYCLE_STEPS.map((p) => (
              <tr key={p}>
                <th scope="row">{PROFILE_LABELS[p]}</th>
                <td>
                  {AGENT_BACKEND_LABELS[current[p].backend]} ·{' '}
                  {current[p].model ?? 'Backend default'}
                </td>
                <td>{current[p].reasoningEffort ?? defaultEffortLabel(current[p].backend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AgentRecommendations />
      {!draft ? (
        <button
          type="button"
          className="secondary-button"
          disabled={!canEdit || busy}
          onClick={() => setDraft({ profiles: current, selections: agentSelections(current) })}
        >
          Edit workspace defaults
        </button>
      ) : (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave([
              ...CYCLE_STEPS.map((role) => ({
                ...draft.selections[role],
                role,
                permissionMode: draft.profiles[role].permissionMode,
              })),
              ...SPECIALIST_PROFILES.flatMap((role) =>
                draft.selections[role]
                  ? [
                      {
                        ...draft.selections[role],
                        role,
                        permissionMode: draft.profiles[PROFILE_INHERITANCE[role]].permissionMode,
                      },
                    ]
                  : [],
              ),
            ]);
          }}
        >
          <AgentSelectionsEditor
            value={draft.selections}
            onChange={(selections) => setDraft({ ...draft, selections })}
            backends={backends}
            disabled={!canEdit || busy}
          />
          <details>
            <summary>Permissions for new work</summary>
            <div className="cycle-settings-grid">
              {CYCLE_STEPS.map((role) => (
                <label key={role} className="field">
                  {PROFILE_LABELS[role]} permissions
                  <select
                    disabled={!canEdit || busy}
                    value={draft.profiles[role].permissionMode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        profiles: {
                          ...draft.profiles,
                          [role]: {
                            ...draft.profiles[role],
                            permissionMode: e.target
                              .value as WorkspaceAgentProfile['permissionMode'],
                          },
                        },
                      })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="edit-only">Edit only</option>
                    <option value="unrestricted">Unrestricted</option>
                  </select>
                </label>
              ))}
            </div>
          </details>
          <p className="hint">
            Defaults apply to future setup; for an existing roadmap, use Apply to future runs below.
            Specialists inherit permissions from the step they perform.
          </p>
          <div className="form-row">
            <button type="submit" className="primary-button" disabled={!canEdit || busy}>
              {busy ? 'Saving…' : 'Save workspace defaults'}
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>
              Close editor
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p role="status" className="success-state">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
    </Section>
  );
}
