import type { NotificationStatus } from '@craftingtable/contracts';
import type { NotificationPreferences, WorkspaceId } from '@craftingtable/domain';
import { type FormEvent, useEffect, useState } from 'react';
import {
  loadNotifications,
  saveNotifications,
  testNotifications,
} from '../../lib/notification-api.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../../lib/query-store.js';
import { About } from '../../components/About.js';
import { PathLink } from '../../lib/navigation.js';

export function NotificationPanel({
  workspaceId,
  csrfToken,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
}) {
  // Delivery status follows notification and attention events (R-D4), never a poll.
  const store = useQueryStore();
  const key = queryKeys.notifications(workspaceId);
  const query = useQuery(key, () => loadNotifications(workspaceId));
  const status = query.data;
  const setStatus = (next: NotificationStatus) => store.set(key, next);
  const [draft, setDraft] = useState<NotificationPreferences>();
  const [version, setVersion] = useState(0);
  const [applicationToken, setApplicationToken] = useState('');
  const [userKey, setUserKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [commandError, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const error =
    commandError ??
    (query.error === undefined
      ? undefined
      : query.error instanceof Error
        ? query.error.message
        : 'Could not load notifications.');
  // Polling delivery status must never erase unsaved settings or credentials.
  useEffect(() => {
    if (status !== undefined && draft === undefined) {
      setDraft(status.preferences);
      setVersion(status.version);
    }
  }, [status, draft]);
  const apply = (next: NotificationStatus) => {
    setStatus(next);
    setDraft(next.preferences);
    setVersion(next.version);
    setApplicationToken('');
    setUserKey('');
  };
  const save = async (clearCredentials = false) => {
    if (draft === undefined) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      apply(
        await saveNotifications(
          workspaceId,
          {
            expectedVersion: version,
            preferences: clearCredentials ? { ...draft, enabled: false } : draft,
            ...(applicationToken.trim() ? { applicationToken: applicationToken.trim() } : {}),
            ...(userKey.trim() ? { userKey: userKey.trim() } : {}),
            clearCredentials,
          },
          csrfToken,
        ),
      );
      setNotice(
        clearCredentials
          ? 'Credentials cleared; notifications disabled.'
          : 'Notification settings saved.',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save notifications.');
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await testNotifications(workspaceId, csrfToken);
      setStatus(next);
      setVersion((current) => (next.version === current + 1 ? next.version : current));
      setNotice('Test queued. Delivery status will update below.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not queue a test.');
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };
  return (
    <section className="panel" aria-label="Pushover notifications">
      <h3>Pushover notifications</h3>
      <About label="About notifications">
        <p>
          Receive alerts when a review is ready for merge, a design needs your input, or a run or
          cycle needs attention. Each alert includes the project, work item, reason, branches, and a
          link back here.
        </p>
        <p>
          Reminders: immediately, after 30 minutes, at 1, 2, 3, 4, 5, and 6 hours, then daily at the
          time below. They stop when work resumes or the item is resolved. Your phone’s Pushover
          quiet hours still apply.
        </p>
        <p>
          Links use this daemon’s configured public address; keep Tailscale connected on your phone.
        </p>
      </About>
      {error !== undefined && (
        <p role="alert" className="error-state">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError(undefined);
              setDraft(undefined);
              store.refreshNow([key]);
            }}
          >
            Reload settings
          </button>
        </p>
      )}
      {notice !== undefined && (
        <p role="status" className="success-state">
          {notice}
        </p>
      )}
      {draft === undefined || status === undefined ? (
        <p>Loading notification settings…</p>
      ) : (
        <>
          <p className="hint">
            Create an application in{' '}
            <a href="https://pushover.net/apps/build" target="_blank" rel="noreferrer">
              Pushover
            </a>
            , then enter its API token and your account’s user key. Save before sending a test.
          </p>
          <form className="stack-form" onSubmit={submit}>
            <label>
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />{' '}
              Enable notifications
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.mergeReady}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, mergeReady: event.target.checked })}
              />{' '}
              Ready for merge
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.needsAttention}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, needsAttention: event.target.checked })}
              />{' '}
              Needs attention
            </label>
            <div className="form-row">
              <label className="field">
                Daily reminder time
                <input
                  type="time"
                  required
                  value={draft.dailyTime}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, dailyTime: event.target.value })}
                />
              </label>
              <label className="field">
                Reminder timezone
                <input
                  required
                  value={draft.timeZone}
                  disabled={busy}
                  placeholder="America/Los_Angeles"
                  onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}
                />
              </label>
            </div>
            <div className="form-row">
              <label className="field">
                Application API token
                <input
                  type="password"
                  autoComplete="new-password"
                  value={applicationToken}
                  disabled={busy}
                  onChange={(event) => setApplicationToken(event.target.value)}
                />
              </label>
              <label className="field">
                Pushover user key
                <input
                  type="password"
                  autoComplete="new-password"
                  value={userKey}
                  disabled={busy}
                  onChange={(event) => setUserKey(event.target.value)}
                />
              </label>
              <label className="field">
                Device name (optional)
                <input
                  value={draft.device}
                  disabled={busy}
                  maxLength={25}
                  onChange={(event) => setDraft({ ...draft, device: event.target.value })}
                />
              </label>
            </div>
            <p className="hint">
              {status.credentialsConfigured
                ? 'Credentials configured. Leave password fields blank to keep them.'
                : 'Credentials not configured.'}{' '}
              Credentials are stored in the daemon’s private database and never displayed again.
            </p>
            <div className="inline-actions">
              <button type="submit" className="primary-button" disabled={busy}>
                Save notifications
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !status.credentialsConfigured ||
                  applicationToken !== '' ||
                  userKey !== '' ||
                  draft.device !== status.preferences.device
                }
                onClick={() => void test()}
              >
                Send test notification
              </button>
              <button
                type="button"
                disabled={busy || !status.credentialsConfigured}
                onClick={() => void save(true)}
              >
                Clear credentials
              </button>
            </div>
          </form>
          {status.blockedReason !== null && (
            <p className="error-state" role="alert">
              Delivery paused: {status.blockedReason}
            </p>
          )}
          {status.retryAt !== null && status.blockedReason === null && (
            <p className="hint">
              Delivery retry after {new Date(status.retryAt).toLocaleString()}.
            </p>
          )}
          <h4>Recent notification activity</h4>
          <p className="hint">
            Accepted means Pushover queued the message; it does not confirm that you read it.{' '}
            {status.preferences.enabled
              ? ''
              : 'Attention notifications are disabled. Tests can still be sent.'}
          </p>
          {status.records.length === 0 ? (
            <p className="hint">No notifications yet.</p>
          ) : (
            <ul className="notification-records">
              {status.records.map((record) => (
                <li key={record.id}>
                  <PathLink path={record.path}>{record.title}</PathLink>
                  <p>
                    {record.kind === 'test'
                      ? record.lastSentAt !== null
                        ? 'Test accepted by Pushover'
                        : record.state === 'active'
                          ? 'Test pending'
                          : 'Test failed'
                      : record.state === 'active'
                        ? 'Still needs attention'
                        : 'Resolved'}{' '}
                    · {record.deliveredCount} accepted
                  </p>
                  {record.lastSentAt !== null && (
                    <p className="hint">
                      Last accepted: {new Date(record.lastSentAt).toLocaleString()}
                    </p>
                  )}
                  {record.state === 'active' && (
                    <p className="hint">
                      {status.blockedReason !== null ||
                      (!status.preferences.enabled && record.kind !== 'test')
                        ? 'Delivery paused'
                        : `Next delivery: ${new Date(Math.max(Date.parse(record.nextAttemptAt), status.retryAt === null ? 0 : Date.parse(status.retryAt))).toLocaleString()}`}
                    </p>
                  )}
                  {record.lastError !== null && <p className="error-state">{record.lastError}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
