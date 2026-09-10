import type { WorkspaceEventEnvelope } from '@craftingtable/contracts';

export function describeEvent(event: WorkspaceEventEnvelope): string {
  switch (event.kind) {
    case 'branches-changed':
      return `Branch settings ${event.payload.action}`;
    case 'work-cycle-changed':
      return `Cycle ${event.payload.status}: ${event.payload.reason}`;
    case 'workspace-created':
      return `Workspace created: ${event.payload.name}`;
    case 'workspace-updated':
      return `Workspace renamed: ${event.payload.name}`;
    case 'project-created':
      return `Project created: ${event.payload.name}`;
    case 'plan-version-imported':
      return `Plan version ${event.payload.versionNumber} imported: ${event.payload.document} (${event.payload.itemCount} work items, ${event.payload.requiredDependencyCount} required dependencies)`;
    case 'work-item-admitted':
      return `Work item admitted: ${event.payload.sourceWorkItemId}`;
    case 'work-item-completed':
      return `Work item completed: ${event.payload.sourceWorkItemId}${
        event.payload.mergeSha === undefined
          ? ''
          : ` (merged ${event.payload.mergeSha.slice(0, 10)})`
      }`;
    case 'repository-registered':
      return `Repository registered: ${event.payload.displayName}`;
    case 'repository-status-changed':
      return `Repository status changed from ${event.payload.fromStatus} to ${event.payload.toStatus}: ${event.payload.displayName}`;
    case 'repository-evidence-changed':
      return `Repository risk evidence changed: ${event.payload.displayName}`;
    case 'project-repository-bound':
      return `Repository bound to project: ${event.payload.repositoryDisplayName}`;
    case 'project-repository-binding-retired':
      return `Repository binding retired: ${event.payload.repositoryDisplayName}`;
    case 'source-repository-registered':
      return `Repository registered: ${event.payload.displayName} (${event.payload.rootPath})`;
    case 'worktree-created':
      return `Worktree created on ${event.payload.branchName}`;
    case 'worktree-removed':
      return `Worktree removed: ${event.payload.branchName}`;
    case 'worktree-merged':
      return `Merged ${event.payload.branchName} into ${event.payload.targetBranch}`;
    case 'agent-run-started':
      return `Agent run started: ${event.payload.role} with ${event.payload.backend}`;
    case 'agent-run-status-changed':
      return `Agent run ${event.payload.toStatus} (was ${event.payload.fromStatus})`;
    default: {
      const unreachable: never = event;
      throw new TypeError(`Unsupported workspace event: ${String(unreachable)}`);
    }
  }
}

/** Collapsed by default: useful, but not what the dashboard is for. */
export function ActivityPanel({
  events,
  invalidPayloadCount,
  foreignWorkspaceEventCount,
}: {
  events: readonly WorkspaceEventEnvelope[];
  invalidPayloadCount: number;
  foreignWorkspaceEventCount: number;
}) {
  return (
    <details className="disclosure" aria-label="Workspace activity">
      <summary>
        <span>Activity</span>
        <span className="hint">{events.length} recent</span>
      </summary>
      <div className="disclosure-body">
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
            {[...events].reverse().map((event) => (
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
      </div>
    </details>
  );
}
