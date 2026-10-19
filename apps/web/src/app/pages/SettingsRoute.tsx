import type { WorkspaceAgentProfile } from '@craftingtable/domain';
import { useState } from 'react';
import { CycleDefaultsPanel } from '../../features/workspace/CycleDefaultsPanel.js';
import { HostSchedulingPanel } from '../../features/workspace/HostSchedulingPanel.js';
import { NotificationPanel } from '../../features/workspace/NotificationPanel.js';
import { SettingsPage } from '../../features/workspace/SettingsPage.js';
import { StoragePanel } from '../../features/workspace/StoragePanel.js';
import { ApiError } from '../../lib/api-client.js';
import { renameWorkspace } from '../../lib/workspace-api.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { saveRunProfiles } from '../../lib/execution-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { forgetLaunchOptions, useExecutionStatus, useRunProfiles } from '../reads.js';
import type { SettingsSection } from '../../lib/route.js';
import { useAlive, useSession, useWorkspaceScope } from '../session.js';

/**
 * The workspace's settings, one page per section (R-E5b): its name, agent defaults, capacity,
 * notifications and storage.
 */
export function SettingsRoute({ section }: { section: SettingsSection }) {
  const { workspaceId, workspace, canMutate, isOwner } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const alive = useAlive();
  const status = useExecutionStatus().data;
  const profiles = useRunProfiles(workspaceId).data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [profilesBusy, setProfilesBusy] = useState(false);
  const [profilesError, setProfilesError] = useState<string>();
  const [profilesNotice, setProfilesNotice] = useState<string>();
  const rename = (name: string): void => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    void renameWorkspace(workspaceId, name, csrfToken)
      .then(async () => {
        await store.refetch(queryKeys.workspaces());
        if (!alive()) return;
        setNotice('Workspace renamed.');
        store.refreshNow([queryKeys.snapshot(workspaceId)]);
      })
      .catch((failure: unknown) => {
        if (alive())
          setError(
            failure instanceof ApiError ? failure.message : 'The workspace could not be renamed',
          );
      })
      .finally(() => {
        if (alive()) setBusy(false);
      });
  };
  const saveProfiles = (next: readonly WorkspaceAgentProfile[]): void => {
    setProfilesBusy(true);
    setProfilesError(undefined);
    setProfilesNotice(undefined);
    void saveRunProfiles(workspaceId, { profiles: [...next] }, csrfToken)
      .then((response) => {
        // A save for a workspace no longer shown is not written into the store (4b review).
        if (!alive()) return;
        store.set(queryKeys.runProfiles(workspaceId), response);
        forgetLaunchOptions(store, workspaceId);
        setProfilesNotice('Profiles saved.');
      })
      .catch((failure: unknown) => {
        if (alive())
          setProfilesError(
            failure instanceof ApiError ? failure.message : 'The profiles could not be saved',
          );
      })
      .finally(() => {
        if (alive()) setProfilesBusy(false);
      });
  };
  return (
    <SettingsPage
      section={section}
      workspace={workspace}
      canEdit={isOwner}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      {...(notice === undefined ? {} : { notice })}
      hostScheduling={
        canMutate ? (
          <HostSchedulingPanel
            canManageHost={isOwner}
            workspaceId={workspaceId}
            csrfToken={csrfToken}
          />
        ) : undefined
      }
      storage={
        isOwner ? <StoragePanel workspaceId={workspaceId} csrfToken={csrfToken} /> : undefined
      }
      cycleDefaults={
        <CycleDefaultsPanel workspaceId={workspaceId} csrfToken={csrfToken} canEdit={canMutate} />
      }
      notifications={
        isOwner ? <NotificationPanel workspaceId={workspaceId} csrfToken={csrfToken} /> : undefined
      }
      onRename={rename}
      {...(status === undefined ? {} : { backends: status.backends })}
      {...(profiles === undefined ? {} : { defaults: profiles })}
      profilesBusy={profilesBusy}
      {...(profilesError === undefined ? {} : { profilesError })}
      {...(profilesNotice === undefined ? {} : { profilesNotice })}
      onSaveProfiles={saveProfiles}
    />
  );
}
