import {
  type CheckDeclarationPreview,
  type CheckDefinitionDiagnosisView,
  checkDeclarationPreviewSchema,
  type RepositoryChecksView,
  repositoryChecksViewSchema,
  type SourceRepositorySummary,
} from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { type FormEvent, useEffect, useState } from 'react';
import { request } from '../../lib/api-client.js';
import { loadCheckDefinitions, loadRepositoryChecks } from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';

const encode = encodeURIComponent;
const mutation = (csrfToken: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'x-craftingtable-csrf': csrfToken },
  body: JSON.stringify(body),
});
const checksUrl = (workspaceId: WorkspaceId, repositoryId: string) =>
  `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/checks`;

/** What adopting the repository's checks file at `ref` would record; it changes nothing. */
function previewChecks(
  workspaceId: WorkspaceId,
  repositoryId: string,
  ref: string,
  csrfToken: string,
): Promise<CheckDeclarationPreview> {
  return request(
    `${checksUrl(workspaceId, repositoryId)}/preview`,
    checkDeclarationPreviewSchema,
    mutation(csrfToken, { ref }),
  );
}

/** The decision: adopt the checks file at the commit the operator reviewed (R-G13). */
function adoptChecks(
  workspaceId: WorkspaceId,
  repositoryId: string,
  input: { ref: string; expectedCommit: string; rationale: string },
  csrfToken: string,
): Promise<RepositoryChecksView> {
  return request(
    `/api/workspaces/${encode(workspaceId)}/repositories/${encode(repositoryId)}/checks/adopt`,
    repositoryChecksViewSchema,
    mutation(csrfToken, input),
  );
}

/**
 * Reviews a repository's checks file at a branch or commit the daemon reads, then adopts it
 * (R-G13). The only poster of `repositories/:id/checks/adopt` (R-A6): the Repositories page
 * and a check stop's inbox item both render it.
 */
export function AdoptChecks({
  workspaceId,
  repository,
  current,
  initialRef,
  csrfToken,
  onAdopted,
}: {
  workspaceId: WorkspaceId;
  repository: SourceRepositorySummary;
  /** The adoption in force, which each definition file is compared with. */
  current: RepositoryChecksView['declarations'][number] | undefined;
  initialRef: string;
  csrfToken: string;
  onAdopted: (view: RepositoryChecksView) => void;
}) {
  const [ref, setRef] = useState(initialRef);
  const [preview, setPreview] = useState<CheckDeclarationPreview>();
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const review = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    void previewChecks(workspaceId, repository.id, ref.trim(), csrfToken)
      .then(setPreview)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const adopt = () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    void adoptChecks(
      workspaceId,
      repository.id,
      { ref: preview.ref, expectedCommit: preview.commitSha, rationale: rationale.trim() },
      csrfToken,
    )
      .then((next) => {
        onAdopted(next);
        setPreview(undefined);
        setRationale('');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      <form
        className="stack-form"
        aria-label={`Review checks for ${repository.displayName}`}
        onSubmit={review}
      >
        <label className="field">
          Branch or commit to read the checks file from
          <input
            type="text"
            value={ref}
            onChange={(event) => {
              setRef(event.target.value);
              setPreview(undefined);
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            required
          />
        </label>
        <div>
          <button type="submit" className="secondary-button" disabled={busy || !ref.trim()}>
            Review checks file
          </button>
        </div>
      </form>
      {preview && (
        <fieldset aria-label={`Proposed checks for ${repository.displayName}`}>
          <p>
            <code>{preview.sourcePath}</code> at {preview.ref} ({shortSha(preview.commitSha)})
          </p>
          {preview.issues.map((issue, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two issues may read the same.
            <p key={index} className="warning-state">
              {issue}
            </p>
          ))}
          {preview.warnings.map((warning, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two warnings may read the same.
            <p key={index} className="hint" role="note">
              {warning}
            </p>
          ))}
          {preview.checks.length > 0 && (
            <ChecksTable
              label={`Proposed checks for ${repository.displayName}`}
              checks={preview.checks}
            />
          )}
          {preview.definitions.map((file) => (
            <details key={file.path}>
              <summary>
                <code>{file.path}</code> ({file.bytes} bytes,{' '}
                {current === undefined || !(file.path in current.definitionDigests)
                  ? 'new'
                  : current.definitionDigests[file.path] === file.digest
                    ? `unchanged since version ${current.version}`
                    : `changed since version ${current.version}`}
                )
              </summary>
              {file.text === undefined ? (
                <p className="hint">Not shown: it is not UTF-8 text.</p>
              ) : (
                <pre className="mono">
                  {file.text}
                  {file.truncated ? '\n[shortened to its first 64 KiB]' : ''}
                </pre>
              )}
            </details>
          ))}
          {preview.issues.length === 0 && (
            <>
              <label className="field">
                Why these checks
                <textarea
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  maxLength={2000}
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                className="primary-button"
                onClick={adopt}
                disabled={busy || !rationale.trim()}
              >
                Adopt checks at {shortSha(preview.commitSha)}
              </button>
            </>
          )}
        </fieldset>
      )}
    </>
  );
}

/** A declaration's checks: each command and the files that define it. */
export function ChecksTable({
  label,
  checks,
}: {
  label: string;
  checks: CheckDeclarationPreview['checks'];
}) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Command</th>
            <th scope="col">Definition files</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id}>
              <td className="mono">{check.id}</td>
              <td className="mono">{check.argv.join(' ')}</td>
              <td className="mono">{check.definitionPaths.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type DefinitionPath = CheckDefinitionDiagnosisView['paths'][number];

/** Who changed one file from its adopted version, in words (LIVE-30). */
function changedBy(row: DefinitionPath, branch: string): string {
  const slice = row.head !== row.base;
  const integration = row.target !== row.base;
  if (slice && integration) return `this slice and ${branch}`;
  if (slice) return 'this slice';
  if (integration) return `${branch}, since this slice left it`;
  return `${branch}, before this slice: the adoption is behind it`;
}

/**
 * A check stop's decision (R-A6 increment 2a, LIVE-30): which definition changed and where,
 * for `check-definition-changed`, and adopting the checks in the item, from the integration
 * branch when the slice did not change them, else from the slice's own commit. For
 * `repository-checks-undeclared` it adopts the repository's first checks.
 */
export function CheckAdoption({
  workspaceId,
  repository,
  worktreeId,
  integrationBranch,
  csrfToken,
  editable,
  onAdopted,
}: {
  workspaceId: WorkspaceId;
  repository: SourceRepositorySummary;
  /** The stopped slice's worktree, whose review the definitions are read for. */
  worktreeId?: WorktreeId;
  integrationBranch?: string;
  csrfToken: string;
  editable: boolean;
  onAdopted: () => void;
}) {
  const [checks, setChecks] = useState<RepositoryChecksView>();
  const [diagnosis, setDiagnosis] = useState<CheckDefinitionDiagnosisView | null>();
  useEffect(() => {
    let alive = true;
    void loadRepositoryChecks(workspaceId, repository.id)
      .then((next) => {
        if (alive) setChecks(next);
      })
      .catch(() => undefined);
    if (worktreeId)
      void loadCheckDefinitions(workspaceId, worktreeId)
        .then((next) => {
          if (alive) setDiagnosis(next);
        })
        .catch(() => {
          // No review of the worktree was held to adopted checks: nothing to compare.
          if (alive) setDiagnosis(null);
        });
    else setDiagnosis(null);
    return () => {
      alive = false;
    };
  }, [workspaceId, repository.id, worktreeId]);
  const current = checks?.declarations[0];
  const changed = (diagnosis?.paths ?? []).filter(
    (row) => row.head !== row.adopted || diagnosis?.sliceChanged.includes(row.path),
  );
  const inherited = changed.some((row) => !diagnosis?.sliceChanged.includes(row.path));
  const ref =
    diagnosis && !inherited && diagnosis.sliceChanged.length
      ? diagnosis.headSha
      : (diagnosis?.targetBranch ?? integrationBranch ?? repository.defaultBranch);
  return (
    <section aria-label={`Checks of ${repository.displayName}`} className="check-adoption">
      <p>
        {current
          ? `Adopted: version ${current.version}, from ${shortSha(current.sourceCommit)}.`
          : checks
            ? 'No adopted checks yet.'
            : 'Loading checks…'}
      </p>
      {diagnosis && changed.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <caption>Definitions that differ from the adoption</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Changed by</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((row) => (
                <tr key={row.path}>
                  <td className="mono">{row.path}</td>
                  <td>{changedBy(row, diagnosis.targetBranch)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && diagnosis !== undefined && checks && (
        <AdoptChecks
          key={ref}
          workspaceId={workspaceId}
          repository={repository}
          current={current}
          initialRef={ref}
          csrfToken={csrfToken}
          onAdopted={(next) => {
            setChecks(next);
            onAdopted();
          }}
        />
      )}
    </section>
  );
}
