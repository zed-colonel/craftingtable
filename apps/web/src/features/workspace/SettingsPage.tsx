import type {
  ExecutionStatusResponse,
  RunProfilesResponse,
  WorkspaceOverview,
} from '@craftingtable/contracts';
import type { WorkspaceAgentProfile, WorkspaceId } from '@craftingtable/domain';
import { type FormEvent, type ReactNode, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.js';
import { PageTabs } from '../../components/PageTabs.js';
import type { SettingsSection } from '../../lib/route.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { WorkspaceProfilesSection } from './WorkspaceProfilesSection.js';

const SECTION_LABELS: Readonly<Record<SettingsSection, string>> = {
  general: 'General',
  agents: 'Agents',
  capacity: 'Capacity',
  notifications: 'Notifications',
  storage: 'Storage',
};

/**
 * The workspace's settings, one page per section (R-E5b): its name, its agent defaults, the
 * workstation's and each roadmap's capacity, notifications and storage. A section the operator
 * cannot use is not offered.
 */
export function SettingsPage({
  section = 'general',
  workspace,
  canEdit,
  busy,
  error,
  notice,
  onRename,
  notifications,
  storage,
  hostScheduling,
  backends,
  defaults,
  profilesBusy,
  profilesError,
  profilesNotice,
  onSaveProfiles,
}: {
  section?: SettingsSection;
  notifications?: ReactNode;
  storage?: ReactNode;
  hostScheduling?: ReactNode;
  workspace: WorkspaceOverview;
  canEdit: boolean;
  busy: boolean;
  error?: string;
  notice?: string;
  onRename: (name: string) => void;
  backends?: ExecutionStatusResponse['backends'];
  /** The workspace's agent defaults with their sources, as the daemon reports them. */
  defaults?: RunProfilesResponse;
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
        title="Settings"
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
      <PageTabs
        label="Settings pages"
        tabs={(Object.keys(SECTION_LABELS) as SettingsSection[])
          .filter(
            (key) =>
              (key !== 'notifications' || notifications !== undefined) &&
              (key !== 'storage' || storage !== undefined),
          )
          .map((key) => ({
            route: {
              name: 'settings',
              workspaceId: workspace.id as WorkspaceId,
              ...(key === 'general' ? {} : { section: key }),
            },
            label: SECTION_LABELS[key],
            current: key === section,
          }))}
      />

      {section === 'general' && (
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
      )}

      {section === 'agents' &&
        (defaults !== undefined && onSaveProfiles !== undefined ? (
          <WorkspaceProfilesSection
            key={defaults.profiles.map((profile) => `${profile.role}:${profile.stored}`).join(',')}
            backends={backends ?? []}
            defaults={defaults}
            canEdit={workspace.role !== 'viewer'}
            busy={profilesBusy === true}
            {...(profilesError === undefined ? {} : { error: profilesError })}
            {...(profilesNotice === undefined ? {} : { notice: profilesNotice })}
            onSave={onSaveProfiles}
          />
        ) : (
          <p className="empty-state">Loading the agent defaults…</p>
        ))}
      {section === 'capacity' &&
        (hostScheduling ?? <p className="empty-state">Only an editor manages capacity.</p>)}
      {section === 'notifications' && notifications}
      {section === 'storage' && storage}
    </div>
  );
}
