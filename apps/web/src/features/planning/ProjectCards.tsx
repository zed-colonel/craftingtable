import type { ProjectSummary } from '@craftingtable/contracts';
import type { ProjectId } from '@craftingtable/domain';
import { PlanCompletion } from './PlanCompletion.js';

/** Project cards on the workspace dashboard. */
export function ProjectCards({
  projects,
  onOpen,
  onImport,
}: {
  projects: readonly ProjectSummary[];
  onOpen: (projectId: ProjectId) => void;
  onImport: () => void;
}) {
  if (projects.length === 0) {
    return (
      <section className="panel" aria-label="Projects">
        <h3>Projects</h3>
        <p className="empty-state">
          No plans have been imported yet.{' '}
          <button type="button" className="link-button" onClick={onImport}>
            Import plan
          </button>{' '}
          to build an agenda.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Projects">
      <ul className="card-grid">
        {projects.map((project) => (
          <li key={project.id} className="card">
            <div className="card-title">
              <button type="button" className="link-button" onClick={() => onOpen(project.id)}>
                {project.name}
              </button>
              <span className="hint">{project.document ?? 'no active plan'}</span>
            </div>
            <PlanCompletion completion={project.completion} compact />
            <dl className="card-counts">
              <div>
                <dt>In agenda</dt>
                <dd>{project.admittedCount}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{project.completedCount}</dd>
              </div>
              <div>
                <dt>Ready</dt>
                <dd>{project.planningReadyCount}</dd>
              </div>
              <div>
                <dt>Blocked</dt>
                <dd>{project.dependencyBlockedCount}</dd>
              </div>
              <div>
                <dt>Proposed</dt>
                <dd>{project.proposedCount}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
