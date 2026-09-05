import type { SessionSummary } from '@craftingtable/contracts';
import type { SessionId } from '@craftingtable/domain';

export function SessionPanel({
  sessions,
  onRevoke,
}: {
  sessions: readonly SessionSummary[];
  onRevoke: (sessionId: SessionId) => void;
}) {
  return (
    <section className="panel" aria-labelledby="sessions-title">
      <h3 id="sessions-title">Sessions</h3>
      <ul className="compact-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <span>
              {session.current ? 'This session' : (session.userAgent ?? 'Other session')}
              <small>
                {session.status === 'active' ? 'Expires' : 'Ended'}{' '}
                {new Date(session.expiresAt).toLocaleDateString()}
              </small>
            </span>
            {!session.current && session.status === 'active' && (
              <button
                type="button"
                className="text-button danger"
                onClick={() => onRevoke(session.id)}
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
