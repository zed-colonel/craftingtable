import type { WorkspaceEventEnvelope } from '@craftingtable/contracts';
import type { ConnectionState } from '../lib/workspace-projection.js';

function describeEvent(event: WorkspaceEventEnvelope): string {
  switch (event.kind) {
    case 'workspace-created':
      return `Workspace created: ${event.payload.name}`;
    case 'project-created':
      return `Project created: ${event.payload.name}`;
    case 'plan-version-imported':
      return `Plan version ${event.payload.versionNumber} imported: ${event.payload.document} (${event.payload.itemCount} work items, ${event.payload.requiredDependencyCount} required dependencies)`;
    case 'work-item-admitted':
      return `Work item admitted: ${event.payload.sourceWorkItemId}`;
  }
}

export function ActivityPanel({
  connection,
  events,
  invalidPayloadCount,
  foreignWorkspaceEventCount,
}: {
  connection: ConnectionState;
  events: readonly WorkspaceEventEnvelope[];
  invalidPayloadCount: number;
  foreignWorkspaceEventCount: number;
}) {
  return (
    <section className="activity" aria-label="Workspace activity">
      <h2>Activity</h2>
      <p className="activity-note">
        Durable workspace events committed by the CraftingTable daemon.
      </p>
      {connection === 'disconnected' && (
        <p className="error-state" role="alert">
          The event stream is unreachable. Your last committed workspace state remains visible;
          reconnection continues automatically.
        </p>
      )}
      {invalidPayloadCount > 0 && (
        <p className="error-state" role="alert">
          {invalidPayloadCount} event{invalidPayloadCount === 1 ? '' : 's'} failed contract
          validation and {invalidPayloadCount === 1 ? 'was' : 'were'} not displayed.
        </p>
      )}
      {foreignWorkspaceEventCount > 0 && (
        <p className="error-state" role="alert">
          {foreignWorkspaceEventCount} event
          {foreignWorkspaceEventCount === 1 ? '' : 's'} addressed to another workspace
          {foreignWorkspaceEventCount === 1 ? ' was' : ' were'} rejected.
        </p>
      )}
      {events.length === 0 ? (
        <p className="empty-state">No durable workspace activity yet.</p>
      ) : (
        <ol className="activity-list">
          {events.map((event) => (
            <li key={event.id} className="activity-item">
              <span className="activity-kind">{event.kind}</span>
              <span>{describeEvent(event)}</span>
              <time className="activity-time" dateTime={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleTimeString()}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
