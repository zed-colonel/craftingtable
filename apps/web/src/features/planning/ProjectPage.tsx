import type { ProjectDetailResponse } from '@craftingtable/contracts';
import type { PlanArtifactId, PlanVersionId, WorkItemId } from '@craftingtable/domain';
import type { ReactNode } from 'react';
import { formatBytes, RISK_LABELS, shortDigest } from '../../lib/planning-labels.js';
import { DiagnosticList } from './DiagnosticList.js';
import { WorkItemTable } from './WorkItemTable.js';

export function ProjectPage({
  detail,
  branchSettings,
  onOpenWorkItem,
  onOpenVersion,
  onViewArtifact,
}: {
  branchSettings?: ReactNode;
  detail: ProjectDetailResponse;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
  onOpenVersion: (planVersionId: PlanVersionId) => void;
  onViewArtifact: (artifactId: PlanArtifactId, filename: string) => void;
}) {
  const active = detail.activeVersion;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{detail.project.name}</h1>
          <p className="subtitle">
            {detail.project.document ?? 'No active plan'} · {detail.project.versionCount} version
            {detail.project.versionCount === 1 ? '' : 's'}
          </p>
        </div>
      </header>
      {branchSettings}

      <section className="status-cards" aria-label="Plan summary">
        <SummaryTile
          label="In agenda"
          count={detail.project.admittedCount}
          accent="var(--color-accent)"
        />
        <SummaryTile
          label="Completed"
          count={detail.project.completedCount}
          accent="var(--color-done)"
        />
        <SummaryTile
          label="Ready for admission"
          count={detail.project.planningReadyCount}
          accent="var(--color-ready)"
        />
        <SummaryTile
          label="Dependency-blocked"
          count={detail.project.dependencyBlockedCount}
          accent="var(--color-blocked)"
        />
        <SummaryTile
          label="Proposed"
          count={detail.project.proposedCount}
          accent="var(--color-attention)"
        />
      </section>

      <section className="panel" aria-label="Risk distribution">
        <h3>Risk</h3>
        <ul className="risk-list">
          {(['critical', 'high', 'medium', 'low', 'unspecified'] as const).map((risk) => (
            <li key={risk} className={`risk risk-${risk}`}>
              {RISK_LABELS[risk]}: {detail.project.riskCounts[risk]}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-label="Plan versions">
        <h3>Plan versions</h3>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Document</th>
                <th scope="col">Digest</th>
                <th scope="col">Items</th>
                <th scope="col">Required edges</th>
                <th scope="col">Active</th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((version) => (
                <tr key={version.id}>
                  <th scope="row">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onOpenVersion(version.id)}
                    >
                      v{version.versionNumber}
                    </button>
                  </th>
                  <td>{version.document}</td>
                  <td>
                    <code>{shortDigest(version.contentDigest)}</code>
                  </td>
                  <td>{version.itemCount}</td>
                  <td>{version.requiredDependencyCount}</td>
                  <td>{version.isActive ? 'Active' : 'Preserved'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {active !== null && (
        <>
          <section className="panel" aria-label="Source artifacts">
            <h3>Source artifacts</h3>
            <ul className="artifact-list">
              {active.artifacts.map((artifact) => (
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
            <h3>Import diagnostics</h3>
            <DiagnosticList
              diagnostics={active.diagnostics}
              emptyMessage="This plan version imported without diagnostics."
            />
          </section>

          <section className="panel" aria-label="Work items">
            <h3>Work items ({active.workItems.length})</h3>
            <WorkItemTable items={active.workItems} onOpen={onOpenWorkItem} />
          </section>
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, count, accent }: { label: string; count: number; accent: string }) {
  return (
    <article className="status-card" style={{ '--card-accent': accent } as React.CSSProperties}>
      <span className="count">{count}</span>
      <span className="label">{label}</span>
    </article>
  );
}
