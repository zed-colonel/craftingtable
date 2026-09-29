import type {
  CheckDeclarationPreview,
  RepositoryChecksView,
  SourceRepositorySummary,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { type FormEvent, useEffect, useState } from 'react';
import {
  adoptRepositoryChecks,
  loadRepositoryChecks,
  previewRepositoryChecks,
} from '../../lib/execution-api.js';
import { shortSha } from '../../lib/execution-labels.js';

/** The element a check stop's inbox item opens (R-G13). */
export const repositoryChecksFocus = (repositoryId: string): string =>
  `repository-checks-${repositoryId}`;

function ChecksTable({
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

/**
 * One repository's declared checks (R-G13, operator decision 2026-09-29). The operator reviews
 * the repository's checks file at a commit the daemon reads, then adopts it; scoped reviews in
 * the repository are met only by daemon runs of these checks.
 */
export function RepositoryChecksPanel({
  workspaceId,
  repository,
  csrfToken,
  editable,
  refreshToken,
}: {
  workspaceId: WorkspaceId;
  repository: SourceRepositorySummary;
  csrfToken: string;
  editable: boolean;
  refreshToken: number;
}) {
  const [data, setData] = useState<RepositoryChecksView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState(repository.defaultBranch);
  const [preview, setPreview] = useState<CheckDeclarationPreview>();
  const [rationale, setRationale] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on daemon journal changes.
  useEffect(() => {
    let alive = true;
    void loadRepositoryChecks(workspaceId, repository.id)
      .then((next) => {
        if (alive) setData(next);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, repository.id, refreshToken]);
  const [current, ...earlier] = data?.declarations ?? [];
  const review = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    void previewRepositoryChecks(workspaceId, repository.id, ref.trim(), csrfToken)
      .then(setPreview)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const adopt = () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    void adoptRepositoryChecks(
      workspaceId,
      repository.id,
      { ref: preview.ref, expectedCommit: preview.commitSha, rationale: rationale.trim() },
      csrfToken,
    )
      .then((next) => {
        setData(next);
        setPreview(undefined);
        setRationale('');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section
      id={repositoryChecksFocus(repository.id)}
      aria-label={`Checks for ${repository.displayName}`}
      className="integration-resolution"
    >
      <h3>{repository.displayName}</h3>
      <p>
        {current
          ? `Version ${current.version}, adopted from ${shortSha(current.sourceCommit)} on ${new Date(current.adoptedAt).toLocaleString()}.`
          : data
            ? 'No adopted checks. Scoped reviews in this repository stop until its checks are adopted.'
            : 'Loading checks…'}
      </p>
      {current && (
        <>
          <ChecksTable
            label={`Adopted checks for ${repository.displayName}`}
            checks={current.checks}
          />
          <p className="hint">Why: {current.rationale}</p>
        </>
      )}
      {earlier.length > 0 && (
        <details>
          <summary>Earlier versions ({earlier.length})</summary>
          <ul>
            {earlier.map((d) => (
              <li key={d.id}>
                Version {d.version} from {shortSha(d.sourceCommit)},{' '}
                {new Date(d.adoptedAt).toLocaleString()}: {d.checks.map((c) => c.id).join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {editable && (
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
      )}
      {editable && preview && (
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
    </section>
  );
}
