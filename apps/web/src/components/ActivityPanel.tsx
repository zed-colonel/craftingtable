import type { AgentEventEnvelope } from '@craftingtable/contracts';
import type { ConnectionState } from '../lib/useEventStream.js';

function describeEvent(event: AgentEventEnvelope): string {
  switch (event.kind) {
    case 'run-started':
      return `Run started: ${event.payload.title} on ${event.payload.branch} via ${event.payload.backend}`;
    case 'status-changed':
      return event.payload.status;
    case 'completion-proposed':
      return event.payload.summary;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export interface ActivityPanelProps {
  connection: ConnectionState;
  events: AgentEventEnvelope[];
  invalidEventCount: number;
}

export function ActivityPanel({ connection, events, invalidEventCount }: ActivityPanelProps) {
  return (
    <section className="activity" aria-label="Agent activity">
      <h2>Activity</h2>
      <p className="activity-note">
        Normalized events from the fake agent backend. Every event shown was validated against the
        shared contract.
      </p>

      {connection === 'disconnected' && (
        <p className="error-state" role="alert">
          The event stream is unreachable. Check that the CraftingTable server is running; the
          dashboard keeps retrying automatically.
        </p>
      )}
      {invalidEventCount > 0 && (
        <p className="error-state" role="alert">
          {invalidEventCount} event{invalidEventCount === 1 ? '' : 's'} failed contract validation
          and {invalidEventCount === 1 ? 'was' : 'were'} not displayed.
        </p>
      )}

      {events.length === 0 && connection !== 'disconnected' ? (
        <p className="empty-state">Waiting for the simulated run to begin…</p>
      ) : (
        <ol className="activity-list">
          {events.map((event) => (
            <li key={`${event.runId ?? 'no-run'}-${event.sequence}`} className="activity-item">
              <span className="activity-kind">{event.kind}</span>
              <span>{describeEvent(event)}</span>
              <time className="activity-time" dateTime={event.occurredAt}>
                {formatTime(event.occurredAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
