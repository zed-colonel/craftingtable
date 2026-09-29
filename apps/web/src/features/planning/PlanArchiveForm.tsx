import type {
  ArchivePlanImportResponse,
  PlanArchivePreview,
  PlanImportResponse,
  ProjectSummary,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import {
  archiveDownloadPath,
  importPlanZip,
  previewPlanZip,
} from '../../lib/package-import-api.js';
import { ImportIssues } from './import-issues.js';
import { Link } from '../../lib/navigation.js';

export function PlanArchiveForm({
  workspaceId,
  csrfToken,
  projects,
  onImported,
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  projects: readonly ProjectSummary[];
  onImported?: (result: PlanImportResponse) => void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<PlanArchivePreview>();
  const [implementationPlan, setImplementationPlan] = useState('');
  const [workBreakdown, setWorkBreakdown] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ArchivePlanImportResponse>();
  const selectedProject = projects.find((p) => p.id === projectId);
  const inspect = async () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const inspected = await previewPlanZip(workspaceId, file, csrfToken);
      setPreview(inspected);
      const plan =
        implementationPlan ||
        (inspected.implementationPlans.length === 1
          ? (inspected.implementationPlans[0] ?? '')
          : '');
      const breakdown =
        workBreakdown ||
        (inspected.workBreakdowns.length === 1 ? (inspected.workBreakdowns[0] ?? '') : '');
      setImplementationPlan(plan);
      setWorkBreakdown(breakdown);
      if (plan && breakdown)
        setPreview(
          await previewPlanZip(workspaceId, file, csrfToken, {
            implementationPlan: plan,
            workBreakdown: breakdown,
          }),
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not preview the ZIP.');
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!file || !preview?.valid) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await importPlanZip(
        workspaceId,
        file,
        {
          implementationPlan,
          workBreakdown,
          archiveDigest: preview.archiveDigest,
          activate: String(activate),
          ...(projectId
            ? {
                projectId,
                ...(selectedProject?.activePlanVersionId
                  ? { expectedActivePlanVersionId: selectedProject.activePlanVersionId }
                  : {}),
              }
            : { projectName }),
        },
        csrfToken,
      );
      setResult(response);
      if (response.plan && response.plan.outcome !== 'failed-validation')
        onImported?.(response.plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import the ZIP.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-label="Import plan ZIP">
      <h2>Import a complete planning ZIP</h2>
      <p>
        Choose an existing project to add a new immutable plan version. Earlier plans, work items
        and completion history remain available.
      </p>
      <label className="field">
        Planning ZIP (up to 8 MiB)
        <input
          type="file"
          accept=".zip"
          disabled={busy}
          onChange={(e) => {
            const next = e.target.files?.[0];
            setFile(next);
            setPreview(undefined);
            setImplementationPlan('');
            setWorkBreakdown('');
            setResult(undefined);
            setError(next && next.size > 8 * 1024 * 1024 ? 'ZIP exceeds 8 MiB.' : undefined);
          }}
        />
      </label>
      <button
        type="button"
        onClick={() => void inspect()}
        disabled={busy || !file || file.size > 8 * 1024 * 1024}
      >
        {busy ? 'Working…' : 'Preview ZIP'}
      </button>
      {preview && (
        <>
          <ImportIssues issues={preview.diagnostics} />
          {preview.entries.length > 0 && (
            <>
              <label className="field">
                Implementation plan file
                <select
                  aria-label="Implementation plan file"
                  value={implementationPlan}
                  disabled={busy}
                  onChange={(e) => {
                    setImplementationPlan(e.target.value);
                    setPreview({ ...preview, valid: false });
                  }}
                >
                  <option value="">Select the current implementation plan</option>
                  {preview.entries
                    .filter((f) => /\.md$/i.test(f.path))
                    .map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                Work-breakdown file
                <select
                  aria-label="Work-breakdown file"
                  value={workBreakdown}
                  disabled={busy}
                  onChange={(e) => {
                    setWorkBreakdown(e.target.value);
                    setPreview({ ...preview, valid: false });
                  }}
                >
                  <option value="">Select the current work breakdown</option>
                  {preview.entries
                    .filter((f) => /\.ya?ml$/i.test(f.path))
                    .map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                      </option>
                    ))}
                </select>
              </label>
              {!preview.valid && (
                <p className="hint">
                  Choose both files, then preview again to validate this selection.
                </p>
              )}
              {preview.valid && (
                <p role="status">
                  Plan validated: {preview.itemCount} work items · {preview.selectedPaths?.length}{' '}
                  current planning documents · {preview.entries.length} archived files.
                </p>
              )}
              <details>
                <summary>Documents and archive provenance</summary>
                <p>
                  Current text documents beside the plan become plan artifacts. Scripts, historical
                  copies and source checksums stay in the ZIP. No bundled code runs.
                </p>
                <code className="import-digest">{preview.archiveDigest}</code>
                <ul>
                  {preview.selectedPaths?.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </details>
              <label className="field">
                Target project
                <select
                  aria-label="Target project"
                  value={projectId}
                  disabled={busy}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">Create a new project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.versionCount} existing version(s)
                    </option>
                  ))}
                </select>
              </label>
              {!projectId && (
                <label className="field">
                  New project name
                  <input
                    value={projectName}
                    maxLength={120}
                    disabled={busy}
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                </label>
              )}
              {projectId && (
                <>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={activate}
                      disabled={busy}
                      onChange={(e) => setActivate(e.target.checked)}
                    />
                    Make this the active plan after import
                  </label>
                  <p className="hint">
                    Activation requires idle existing work. Repository and branch settings belong to
                    the new version; existing worktrees keep their original bindings.
                  </p>
                </>
              )}
              <button
                type="button"
                className="primary-button"
                onClick={() => void submit()}
                disabled={busy || !preview.valid || (!projectId && !projectName.trim())}
              >
                Import reviewed plan ZIP
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p>Import: {result.attempt.outcome}</p>
          <ImportIssues issues={result.attempt.diagnostics} />
          <a href={archiveDownloadPath(workspaceId, result.attempt.archiveId)}>
            Download original archive
          </a>
          {result.plan && result.plan.outcome !== 'failed-validation' && (
            <p>
              <Link
                route={{
                  name: 'plan-version',
                  workspaceId,
                  projectId: result.plan.projectId,
                  planVersionId: result.plan.planVersionId,
                }}
              >
                Open plan version {result.plan.versionNumber} and configure Repository &amp;
                branches
              </Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
