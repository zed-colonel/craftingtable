import type {
  AgentRunProfileEntry,
  ExecutionStatusResponse,
  WorkspaceOverview,
} from '@craftingtable/contracts';
import type { WorkspaceAgentProfile } from '@craftingtable/domain';
import { type FormEvent, type ReactNode, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { WorkspaceProfilesSection } from './WorkspaceProfilesSection.js';

export function SettingsPage({
  workspace,
  canEdit,
  busy,
  error,
  notice,
  onRename,
  notifications,
  storage,
  hostScheduling,
  roadmapProfiles,
  backends,
  profiles,
  profilesBusy,
  profilesError,
  profilesNotice,
  onSaveProfiles,
}: {
  notifications?: ReactNode;
  storage?: ReactNode;
  hostScheduling?: ReactNode;
  roadmapProfiles?: ReactNode;
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
  onSaveProfiles?: (profiles: readonly WorkspaceAgentProfile[]) => void;
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
      <PageHeader
        title="Workspace settings"
        subtitle={
          <StatusStrip
            compact
            label="Workspace identity"
            facts={[
              { label: 'Workspace', value: workspace.name },
              { label: 'Slug', value: workspace.slug, mono: true },
              { label: 'Your role', value: workspace.role },
              { label: 'Projects', value: workspace.projectCount, mono: true },
              { label: 'Identifier', value: workspace.id, mono: true },
            ]}
          />
        }
      />

      <Section title="Name" label="Rename workspace">
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
      </Section>

      {profiles !== undefined && onSaveProfiles !== undefined && (
        <WorkspaceProfilesSection
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

      {roadmapProfiles}
      {hostScheduling}
      {notifications}
      {storage}
    </div>
  );
}
