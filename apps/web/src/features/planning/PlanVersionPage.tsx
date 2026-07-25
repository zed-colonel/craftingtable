import type { PlanVersionDetailResponse } from '@craftingtable/contracts';
import type { PlanArtifactId, WorkItemId } from '@craftingtable/domain';
import { formatBytes, shortDigest } from '../../lib/planning-labels.js';
import { DiagnosticList } from './DiagnosticList.js';
import { WorkItemTable } from './WorkItemTable.js';

/** An immutable, content-addressed plan version. */
export function PlanVersionPage({
  detail,
  onOpenWorkItem,
  onViewArtifact,
}: {
  detail: PlanVersionDetailResponse;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
  onViewArtifact: (artifactId: PlanArtifactId, filename: string) => void;
}) {
  return (
    <div className="planning-page">
      <header className="page-header">
        <h2>Plan version {detail.version.versionNumber}</h2>
        <p className="subtitle">
          {detail.version.document} ·{' '}
          {detail.version.isActive ? 'Active plan version' : 'Preserved, not active'}
        </p>
      </header>

      <section className="panel" aria-label="Version identity">
        <dl className="definition-grid">
          <dt>Content digest</dt>
          <dd>
            <code>{detail.version.contentDigest}</code>
          </dd>
          <dt>Digest algorithm</dt>
          <dd>
            {detail.version.digestAlgorithm} (format v{detail.version.digestFormatVersion})
          </dd>
          <dt>Source profile</dt>
          <dd>{detail.version.sourceProfile}</dd>
          <dt>Work items</dt>
          <dd>{detail.version.itemCount}</dd>
          <dt>Required dependencies</dt>
          <dd>{detail.version.requiredDependencyCount}</dd>
          <dt>Imported</dt>
          <dd>{new Date(detail.version.createdAt).toLocaleString()}</dd>
        </dl>
        <p className="hint">
          Plan versions are immutable. A revised bundle becomes a new version and never replaces
          this one.
        </p>
      </section>

      <section className="panel" aria-label="Source artifacts">
        <h3>Source artifacts</h3>
        <ul className="artifact-list">
          {detail.artifacts.map((artifact) => (
            <li key={artifact.id} className="artifact">
              <button
                type="button"
                className="link-button"
                onClick={() => onViewArtifact(artifact.id, artifact.logicalFilename)}
              >
                {artifact.logicalFilename}
              </button>
              <span className="artifact-meta">
                {artifact.role} · {artifact.mediaType} · {formatBytes(artifact.byteLength)} ·{' '}
                <code>{shortDigest(artifact.sha256)}</code>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-label="Import diagnostics">
        <h3>Diagnostics</h3>
        <DiagnosticList diagnostics={detail.diagnostics} />
      </section>

      <section className="panel" aria-label="Work items">
        <h3>Work items ({detail.workItems.length})</h3>
        <WorkItemTable items={detail.workItems} onOpen={onOpenWorkItem} />
      </section>
    </div>
  );
}
