import type { PlanVersionDetailResponse } from '@craftingtable/contracts';
import type { PlanArtifactId, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import type { ReactNode } from 'react';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { archiveDownloadPath } from '../../lib/package-import-api.js';
import { formatBytes, shortDigest } from '../../lib/planning-labels.js';
import { DiagnosticList } from './DiagnosticList.js';
import { PlanCompletion } from './PlanCompletion.js';
import { WorkItemTable } from './WorkItemTable.js';

/** An immutable, content-addressed plan version. */
export function PlanVersionPage({
  detail,
  workspaceId,
  branchSettings,
  onOpenWorkItem,
  onViewArtifact,
}: {
  branchSettings?: ReactNode;
  workspaceId?: WorkspaceId;
  detail: PlanVersionDetailResponse;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
  onViewArtifact: (artifactId: PlanArtifactId, filename: string) => void;
}) {
  return (
    <div className="page">
      <PageHeader
        title={`Plan version ${detail.version.versionNumber}`}
        subtitle={`${detail.version.document} · ${
          detail.version.isActive ? 'Active plan version' : 'Preserved, not active'
        }`}
      />
      <PlanCompletion completion={detail.version.completion} />
      {branchSettings}

      <Section title={`Work items (${detail.workItems.length})`} label="Work items">
        <WorkItemTable items={detail.workItems} onOpen={onOpenWorkItem} />
      </Section>

      <Section title="Source artifacts" count={detail.artifacts.length}>
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
      </Section>

      {workspaceId && !!detail.archives?.length && (
        <Section
          title="Original planning archives"
          count={detail.archives.length}
          summary="Full uploaded ZIPs with scripts, historical files, and package provenance."
        >
          <ul className="artifact-list">
            {detail.archives.map((archive) => (
              <li key={archive.id} className="artifact">
                <a href={archiveDownloadPath(workspaceId, archive.id)}>{archive.filename}</a>
                <span className="artifact-meta">
                  {formatBytes(archive.byteLength)} · <code>{archive.digest}</code>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Version identity"
        collapsible
        defaultOpen={false}
        summary={`Digest ${shortDigest(detail.version.contentDigest)} · imported ${new Date(
          detail.version.createdAt,
        ).toLocaleDateString()}`}
      >
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
      </Section>

      <Section
        title="Diagnostics"
        label="Import diagnostics"
        count={detail.diagnostics.length}
        collapsible
        defaultOpen={detail.diagnostics.length > 0}
      >
        <DiagnosticList diagnostics={detail.diagnostics} />
      </Section>
    </div>
  );
}
