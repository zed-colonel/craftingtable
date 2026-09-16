import type { AuthenticatedSessionResponse, SessionSummary } from '@craftingtable/contracts';
import type { SessionId } from '@craftingtable/domain';
import { type FormEvent, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { SessionPanel } from '../../components/SessionPanel.js';

export function AccountPage({
  user,
  sessions,
  busy,
  error,
  notice,
  onRevoke,
  onChangePassword,
}: {
  user: AuthenticatedSessionResponse['user'];
  sessions: readonly SessionSummary[];
  busy: boolean;
  error?: string;
  notice?: string;
  onRevoke: (sessionId: SessionId) => void;
  onChangePassword: (input: { currentPassword: string; newPassword: string }) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string>();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setLocalError(undefined);
    if (newPassword !== confirm) {
      setLocalError('The new password and its confirmation do not match.');
      return;
    }
    onChangePassword({ currentPassword, newPassword });
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
  };

  return (
    <div className="page">
      <PageHeader title="Account" subtitle={`Signed in as ${user.username}`} />

      <div className="two-column">
        <Section title="Change password">
          <form className="stack-form" onSubmit={submit}>
            <label className="field">
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label className="field">
              New password
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={busy}
                minLength={12}
                required
              />
            </label>
            <label className="field">
              Confirm new password
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                disabled={busy}
                required
              />
            </label>
            <p className="hint">
              At least 12 characters. Every other signed-in session is revoked when the password
              changes; this one stays signed in.
            </p>
            {localError !== undefined && (
              <p className="error-state" role="alert">
                {localError}
              </p>
            )}
            {error !== undefined && (
              <p className="error-state" role="alert">
                {error}
              </p>
            )}
            {notice !== undefined && (
              <p className="success-state" role="status">
                {notice}
              </p>
            )}
            <div>
              <button type="submit" className="primary-button" disabled={busy}>
                Change password
              </button>
            </div>
          </form>
        </Section>

        <SessionPanel sessions={sessions} onRevoke={onRevoke} />
      </div>
    </div>
  );
}
