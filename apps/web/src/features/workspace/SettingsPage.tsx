import type {
  AgentRunProfileEntry,
  ExecutionStatusResponse,
  WorkspaceOverview,
} from '@craftingtable/contracts';
import {
  AGENT_PERMISSION_MODES,
  type AgentBackendKind,
  type AgentPermissionMode,
  type AgentRunProfile,
} from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';
import {
  PERMISSION_MODE_LABELS,
  RUN_ROLE_DESCRIPTIONS,
  RUN_ROLE_LABELS,
} from '../../lib/execution-labels.js';
import { ModelField } from '../execution/ModelField.js';

export function SettingsPage({
  workspace,
  canEdit,
  busy,
  error,
  notice,
  onRename,
  backends,
  profiles,
  profilesBusy,
  profilesError,
  profilesNotice,
  onSaveProfiles,
}: {
  workspace: WorkspaceOverview;
  canEdit: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  onRename: (name: string) => void;
  backends?: ExecutionStatusResponse['backends'];
  /** Every role, as the daemon reports it; absent until loaded. */
  profiles?: readonly AgentRunProfileEntry[];
  profilesBusy?: boolean;
  profilesError?: string;
  profilesNotice?: string;
  onSaveProfiles?: (profiles: readonly AgentRunProfile[]) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === workspace.name) return;
    onRename(trimmed);
  };
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Workspace settings</h1>
          <p className="subtitle">{workspace.name}</p>
        </div>
      </header>

      <section className="panel" aria-label="Workspace identity">
        <dl className="definition-grid">
          <dt>Slug</dt>
          <dd className="mono">{workspace.slug}</dd>
          <dt>Identifier</dt>
          <dd className="mono">{workspace.id}</dd>
          <dt>Your role</dt>
          <dd>{workspace.role}</dd>
          <dt>Projects</dt>
          <dd>{workspace.projectCount}</dd>
        </dl>
      </section>

      <section className="panel" aria-label="Rename workspace">
        <h3>Name</h3>
        <form className="inline-form" onSubmit={submit}>
          <label className="field">
            Workspace name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              disabled={!canEdit || busy}
              required
            />
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={!canEdit || busy || name.trim() === '' || name.trim() === workspace.name}
          >
            Rename
          </button>
        </form>
        {!canEdit && <p className="hint">Only a workspace owner can rename it.</p>}
        {notice !== undefined && (
          <p className="success-state" role="status">
            {notice}
          </p>
        )}
        {error !== undefined && (
          <p className="error-state" role="alert">
            {error}
          </p>
        )}
      </section>

      {profiles !== undefined && onSaveProfiles !== undefined && (
        <ProfilesSection
          key={profiles.map((profile) => `${profile.role}:${profile.stored}`).join(',')}
          backends={backends ?? []}
          profiles={profiles}
          canEdit={workspace.role !== 'viewer'}
          busy={profilesBusy === true}
          {...(profilesError === undefined ? {} : { error: profilesError })}
          {...(profilesNotice === undefined ? {} : { notice: profilesNotice })}
          onSave={onSaveProfiles}
        />
      )}
    </div>
  );
}

/**
 * One row per role. The launch form and every handoff pre-fill from these;
 * saving stores all roles so what the operator sees is what will be used.
 */
function ProfilesSection({
  backends,
  profiles,
  canEdit,
  busy,
  error,
  notice,
  onSave,
}: {
  backends: ExecutionStatusResponse['backends'];
  profiles: readonly AgentRunProfileEntry[];
  canEdit: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  onSave: (profiles: readonly AgentRunProfile[]) => void;
}) {
  const [drafts, setDrafts] = useState<readonly AgentRunProfile[]>(() =>
    profiles.map(({ role, backend, model, permissionMode }) => ({
      role,
      backend,
      ...(model === undefined ? {} : { model }),
      permissionMode,
    })),
  );
  const update = (index: number, patch: Partial<AgentRunProfile>): void => {
    setDrafts((current) =>
      current.map((draft, candidate) => {
        if (candidate !== index) return draft;
        const next = { ...draft, ...patch };
        const model = next.model?.trim();
        return {
          role: next.role,
          backend: next.backend,
          ...(model === undefined || model.length === 0 ? {} : { model }),
          permissionMode: next.permissionMode,
        };
      }),
    );
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(drafts);
  };
  return (
    <section className="panel" aria-label="Agent profiles">
      <h3>Agent profiles</h3>
      <p className="hint">
        The agent, model, and permissions each kind of run starts with. The launch form and every
        handoff pre-fill from these; each launch can still override them.
      </p>
      <form className="stack-form" onSubmit={submit}>
        {drafts.map((draft, index) => {
          const selected = backends.find((backend) => backend.kind === draft.backend);
          return (
            <fieldset key={draft.role} className="profile-row">
              <legend>{RUN_ROLE_LABELS[draft.role]}</legend>
              <p className="hint">{RUN_ROLE_DESCRIPTIONS[draft.role]}</p>
              <div className="form-row">
                <label className="field">
                  Agent
                  <select
                    value={draft.backend}
                    onChange={(event) =>
                      update(index, {
                        backend: event.target.value as AgentBackendKind,
                        model: '',
                      })
                    }
                    disabled={!canEdit || busy}
                  >
                    {backends.map((backend) => (
                      <option key={backend.kind} value={backend.kind}>
                        {backend.label}
                        {backend.available ? '' : ' (not found)'}
                      </option>
                    ))}
                    {selected === undefined && (
                      <option value={draft.backend}>{draft.backend}</option>
                    )}
                  </select>
                </label>
                <ModelField
                  key={draft.backend}
                  models={selected?.models ?? []}
                  value={draft.model ?? ''}
                  onChange={(model) => update(index, { model })}
                  disabled={!canEdit || busy}
                />
                <label className="field">
                  Permissions
                  <select
                    value={draft.permissionMode}
                    onChange={(event) =>
                      update(index, {
                        permissionMode: event.target.value as AgentPermissionMode,
                      })
                    }
                    disabled={!canEdit || busy}
                  >
                    {AGENT_PERMISSION_MODES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {PERMISSION_MODE_LABELS[candidate]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
          );
        })}
        <div>
          <button type="submit" className="primary-button" disabled={!canEdit || busy}>
            {busy ? 'Saving…' : 'Save profiles'}
          </button>
        </div>
      </form>
      {!canEdit && <p className="hint">Viewers cannot change profiles.</p>}
      {notice !== undefined && (
        <p className="success-state" role="status">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
