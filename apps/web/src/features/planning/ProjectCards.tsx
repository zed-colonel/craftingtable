import type { ProjectSummary } from '@craftingtable/contracts';
import type { ProjectId } from '@craftingtable/domain';

/** Project cards on the workspace dashboard. */
export function ProjectCards({
  projects,
  onOpen,
}: {
  projects: readonly ProjectSummary[];
  onOpen: (projectId: ProjectId) => void;
}) {
  if (projects.length === 0) {
    return (
      <section className="panel" aria-label="Projects">
        <h2>Projects</h2>
        <p className="empty-state">
          No plans have been imported yet. Import a plan bundle to build an agenda.
        </p>
      </section>
    );
  }
  return (
    <section className="panel" aria-label="Projects">
      <h2>Projects</h2>
      <ul className="project-cards">
        {projects.map((project) => (
          <li key={project.id} className="project-card">
            <button type="button" className="link-button" onClick={() => onOpen(project.id)}>
              {project.name}
            </button>
            <p className="project-document">{project.document ?? 'No active plan version'}</p>
            <dl className="project-counts">
              <dt>Proposed</dt>
              <dd>{project.proposedCount}</dd>
              <dt>Admitted</dt>
              <dd>{project.admittedCount}</dd>
              <dt>Ready for admission</dt>
              <dd>{project.planningReadyCount}</dd>
              <dt>Dependency-blocked</dt>
              <dd>{project.dependencyBlockedCount}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
