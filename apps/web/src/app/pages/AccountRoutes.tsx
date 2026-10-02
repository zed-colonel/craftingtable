import type { WorkspaceOverview } from '@craftingtable/contracts';
import type { SessionId, WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { AccountPage } from '../../features/account/AccountPage.js';
import { WorkspacesPage } from '../../features/home/WorkspacesPage.js';
import { ApiError, changePassword, createWorkspace, revokeSession } from '../../lib/api-client.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQueryStore } from '../../lib/query-store.js';
import { useSessions } from '../reads.js';
import { useAlive, useSession } from '../session.js';

/** The user's workspaces, and a new one. */
export function HomeRoute({
  workspaces,
  onOpen,
}: {
  workspaces: readonly WorkspaceOverview[];
  onOpen: (workspaceId: WorkspaceId) => void;
}) {
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const create = (name: string): void => {
    setBusy(true);
    setError(undefined);
    void createWorkspace(name, csrfToken)
      .then(async (response) => {
        await store.refetch(queryKeys.workspaces());
        if (alive()) onOpen(response.workspace.id);
      })
      .catch((failure: unknown) => {
        if (alive())
          setError(
            failure instanceof ApiError ? failure.message : 'The workspace could not be created',
          );
      })
      .finally(() => {
        if (alive()) setBusy(false);
      });
  };
  return (
    <WorkspacesPage
      workspaces={workspaces}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      onOpen={onOpen}
      onCreate={create}
    />
  );
}

/** The user's account: password and signed-in sessions. */
export function AccountRoute() {
  const { user, csrfToken, expire } = useSession();
  const store = useQueryStore();
  const alive = useAlive();
  const sessions = useSessions().data?.sessions ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const revoke = async (sessionId: SessionId): Promise<void> => {
    if (await revokeSession(sessionId, csrfToken)) {
      expire();
      return;
    }
    await store.refetch(queryKeys.sessions());
  };
  const changeOwnPassword = (input: { currentPassword: string; newPassword: string }): void => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    void changePassword(input, csrfToken)
      .then(async (response) => {
        if (!alive()) return;
        setNotice(
          response.revokedSessionCount === 0
            ? 'Password changed.'
            : `Password changed; ${response.revokedSessionCount} other session${
                response.revokedSessionCount === 1 ? '' : 's'
              } signed out.`,
        );
        await store.refetch(queryKeys.sessions());
      })
      .catch((failure: unknown) => {
        if (alive())
          setError(
            failure instanceof ApiError
              ? failure.status === 401
                ? 'The current password is not correct.'
                : failure.message
              : 'The password could not be changed',
          );
      })
      .finally(() => {
        if (alive()) setBusy(false);
      });
  };
  return (
    <AccountPage
      user={user}
      sessions={sessions}
      busy={busy}
      {...(error === undefined ? {} : { error })}
      {...(notice === undefined ? {} : { notice })}
      onRevoke={(id) => void revoke(id)}
      onChangePassword={changeOwnPassword}
    />
  );
}
