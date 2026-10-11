import type {
  ExecutionStatusResponse,
  RunProfilesResponse,
  StepPermissions,
} from '@craftingtable/contracts';
import {
  type AgentSelections,
  CYCLE_STEPS,
  PROFILE_INHERITANCE,
  PROFILE_LABELS,
  SPECIALIST_PROFILES,
  type WorkspaceAgentProfile,
} from '@craftingtable/domain';
import { useState } from 'react';
import { Section } from '../../components/Section.js';
import { agentSourceLabel } from '../../lib/agent-labels.js';
import { AGENT_BACKEND_LABELS } from '@craftingtable/domain';
import { AgentSelectionsEditor } from '../execution/AgentSelectionsEditor.js';
import { defaultEffortLabel } from '../execution/ReasoningEffortField.js';
import { SavedModelNotes } from '../execution/SavedModelNotes.js';
import { defaultStepPermissions } from '../execution/step-permissions.js';
import { AgentRecommendations } from './AgentRecommendations.js';

/**
 * The workspace's agent defaults (R-E5b): one of the two places agents are chosen. Each purpose
 * shows its effective default and where it came from as the daemon reports it (`run-profiles`'
 * `agents`); the editor starts from the daemon's selection set and the defaults' permissions.
 */
export function WorkspaceProfilesSection({
  defaults,
  backends,
  canEdit,
  busy,
  error,
  notice,
  onSave,
}: {
  defaults: RunProfilesResponse;
  backends: ExecutionStatusResponse['backends'];
  canEdit: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  onSave: (p: readonly WorkspaceAgentProfile[]) => void;
}) {
  const [draft, setDraft] = useState<{
    permissions: StepPermissions;
    selections: AgentSelections;
  }>();
  const { agents, selections } = defaults;
  return (
    <Section
      id="workspace-agent-profiles"
      title="Agent profiles"
      summary="Workspace defaults for new work. Each roadmap keeps its own agents, changed in its setup."
    >
      {agents && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Default</th>
                <th>Agent / model</th>
                <th>Reasoning effort</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {CYCLE_STEPS.map((p) => (
                <tr key={p}>
                  <th scope="row">{PROFILE_LABELS[p]}</th>
                  <td>
                    {AGENT_BACKEND_LABELS[agents[p].selection.backend]} ·{' '}
                    {agents[p].selection.model ?? 'Backend default'}
                  </td>
                  <td>
                    {agents[p].selection.reasoningEffort ??
                      defaultEffortLabel(agents[p].selection.backend)}
                  </td>
                  <td>{agentSourceLabel(agents[p].source, p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <SavedModelNotes
        backends={backends}
        selections={defaults.profiles.map(
          (profile) => [PROFILE_LABELS[profile.role], profile] as const,
        )}
      />
      <AgentRecommendations />
      {!draft ? (
        <button
          type="button"
          className="secondary-button"
          disabled={!canEdit || busy || !selections}
          onClick={() =>
            selections &&
            setDraft({ permissions: defaultStepPermissions(agents), selections: { ...selections } })
          }
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
                permissionMode: draft.permissions[role],
              })),
              ...SPECIALIST_PROFILES.flatMap((role) =>
                draft.selections[role]
                  ? [
                      {
                        ...draft.selections[role],
                        role,
                        permissionMode: draft.permissions[PROFILE_INHERITANCE[role]],
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
                    value={draft.permissions[role]}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        permissions: {
                          ...draft.permissions,
                          [role]: e.target.value as WorkspaceAgentProfile['permissionMode'],
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
            Defaults apply to new roadmaps and cycles; an existing roadmap's agents change in its
            setup. Specialists inherit permissions from the step they perform.
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
