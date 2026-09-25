import type { PlanImportResponse, ProjectSummary } from '@craftingtable/contracts';
import type { ProjectId, WorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { PLAN_BUNDLE_LIMITS } from '../../lib/plan-limits.js';
import type { PlanImportUpload } from '../../lib/planning-api.js';
import { IMPORT_OUTCOME_LABELS } from '../../lib/planning-labels.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { DiagnosticList } from './DiagnosticList.js';
import { PlanArchiveForm } from './PlanArchiveForm.js';

const ROLES = [
  { role: 'implementation-plan', label: 'Implementation plan', required: true, multiple: false },
  { role: 'work-breakdown', label: 'Work breakdown', required: true, multiple: false },
  { role: 'validation-manifest', label: 'Checksum manifest', required: false, multiple: false },
  { role: 'assumption-ledger', label: 'Assumption ledger', required: false, multiple: false },
  { role: 'decision-log', label: 'Decision log', required: false, multiple: false },
  { role: 'supporting', label: 'Supporting material', required: false, multiple: true },
] as const;

/**
 * The import surface.
 *
 * Each file input is labelled with the artifact role it supplies, because the
 * role *is* the multipart field name — CraftingTable never guesses a role from
 * a filename or from prose (CT-03 §5.1).
 */
export function ImportPlanPage({
  projects,
  workspaceId,
  csrfToken,
  onZipImported,
  onImport,
  result,
  busy,
  error,
}: {
  workspaceId?: WorkspaceId;
  csrfToken?: string;
  onZipImported?: (result: PlanImportResponse) => void;
  projects: readonly ProjectSummary[];
  onImport: (upload: PlanImportUpload) => void;
  result?: PlanImportResponse;
  busy: boolean;
  error?: string;
}) {
  const [mode, setMode] = useState<'files' | 'zip'>('files');
  const [projectName, setProjectName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [selections, setSelections] = useState<Record<string, File[]>>({});
  const [localError, setLocalError] = useState<string>();

  const files = Object.entries(selections).flatMap(([role, chosen]) =>
    chosen.map((file) => ({ role, file })),
  );

  const submit = (): void => {
    setLocalError(undefined);
    // Local pre-validation mirrors the server limits so an obviously invalid
    // request never leaves the browser.
    for (const required of ROLES.filter((entry) => entry.required)) {
      if ((selections[required.role] ?? []).length !== 1) {
        setLocalError(`Select exactly one ${required.label.toLowerCase()} file.`);
        return;
      }
    }
    if (files.length > PLAN_BUNDLE_LIMITS.maxArtifacts) {
      setLocalError(`Select at most ${PLAN_BUNDLE_LIMITS.maxArtifacts} files.`);
      return;
    }
    const oversize = files.find(
      (entry) => entry.file.size > PLAN_BUNDLE_LIMITS.maxBytesPerArtifact,
    );
    if (oversize !== undefined) {
      setLocalError(`"${oversize.file.name}" exceeds the 2 MiB per-file limit.`);
      return;
    }
    const total = files.reduce((sum, entry) => sum + entry.file.size, 0);
    if (total > PLAN_BUNDLE_LIMITS.maxTotalBytes) {
      setLocalError('The selected files exceed the 8 MiB total upload limit.');
      return;
    }
    if (projectId === '' && projectName.trim() === '') {
      setLocalError('Enter a project name, or choose an existing project.');
      return;
    }
    onImport({
      ...(projectId === '' ? {} : { projectId: projectId as ProjectId }),
      ...(projectName.trim() === '' ? {} : { projectName: projectName.trim() }),
      files,
    });
  };

  return (
    <div className="page">
      <PageHeader
        title="Import plan"
        subtitle="Planning files or a complete planning ZIP, into a new or existing project."
      />

      {workspaceId && csrfToken && (
        <div className="button-row">
          <button type="button" aria-pressed={mode === 'files'} onClick={() => setMode('files')}>
            Individual files
          </button>
          <button type="button" aria-pressed={mode === 'zip'} onClick={() => setMode('zip')}>
            Import ZIP archive
          </button>
        </div>
      )}
      {mode === 'zip' && workspaceId && csrfToken ? (
        <PlanArchiveForm
          workspaceId={workspaceId}
          csrfToken={csrfToken}
          projects={projects}
          onImported={onZipImported}
        />
      ) : (
        <>
          <Section title="Planning files" label="Import form">
            <label className="field">
              Project name
              <input
                type="text"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="ActionQueue — AQ-CONT-1"
                maxLength={120}
              />
            </label>

            {projects.length > 0 && (
              <label className="field">
                Or add a version to an existing project
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">Create a new project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {ROLES.map((entry) => (
              <label className="field" key={entry.role}>
                {entry.label}
                {entry.required ? ' (required)' : ' (optional)'}
                <input
                  type="file"
                  multiple={entry.multiple}
                  accept=".md,.markdown,.yaml,.yml,.json,.txt,.sha256"
                  onChange={(event) =>
                    setSelections((current) => ({
                      ...current,
                      [entry.role]: [...(event.target.files ?? [])],
                    }))
                  }
                />
              </label>
            ))}

            {localError !== undefined && (
              <p className="error-state" role="alert">
                {localError}
              </p>
            )}
            {error !== undefined && (
              <p className="error-state" role="alert">
                {error}
              </p>
            )}

            <div>
              <button type="button" className="primary-button" onClick={submit} disabled={busy}>
                {busy ? 'Importing…' : 'Import plan bundle'}
              </button>
            </div>
          </Section>

          {result !== undefined && <ImportOutcome result={result} />}
        </>
      )}
    </div>
  );
}

/** The three recorded outcomes are visually and textually distinct. */
function ImportOutcome({ result }: { result: PlanImportResponse }) {
  const label = IMPORT_OUTCOME_LABELS[result.outcome];
  if (result.outcome === 'succeeded') {
    return (
      <section className="panel import-outcome import-succeeded" aria-label="Import result">
        <h3>{label}</h3>
        <p>
          Version {result.versionNumber} · {result.itemCount} work items ·{' '}
          {result.requiredDependencyCount} required dependencies
          {result.isActiveVersion ? ' · now the active plan' : ' · preserved, not activated'}
        </p>
        <DiagnosticList
          diagnostics={result.diagnostics}
          emptyMessage="No diagnostics were raised."
        />
      </section>
    );
  }
  if (result.outcome === 'duplicate') {
    return (
      <section className="panel import-outcome import-duplicate" aria-label="Import result">
        <h3>{label}</h3>
        <p>
          These exact files are already stored as version {result.versionNumber}. Nothing was
          duplicated.
        </p>
      </section>
    );
  }
  return (
    <section className="panel import-outcome import-failed" aria-label="Import result">
      <h3>{label}</h3>
      <p>No project, plan version, or work item was created.</p>
      <DiagnosticList diagnostics={result.diagnostics} />
    </section>
  );
}
