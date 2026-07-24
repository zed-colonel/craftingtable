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
    <section className="utility-panel" aria-labelledby="sessions-title">
      <h2 id="sessions-title">Sessions</h2>
      <ul className="compact-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <span>
              {session.current ? 'Current session' : (session.userAgent ?? 'Other session')}
              <small>Expires {new Date(session.expiresAt).toLocaleDateString()}</small>
            </span>
            {!session.current && session.status === 'active' && (
              <button type="button" className="text-button" onClick={() => onRevoke(session.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
