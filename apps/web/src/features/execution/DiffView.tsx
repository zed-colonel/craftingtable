import type { WorktreeDiffResponse } from '@craftingtable/contracts';
import { shortSha } from '../../lib/execution-labels.js';

const STATUS_LABELS: Readonly<Record<WorktreeDiffResponse['files'][number]['status'], string>> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  'type-changed': 'Type changed',
  untracked: 'Untracked',
  unmerged: 'Unmerged',
  unknown: 'Changed',
};

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line diff-file';
  if (line.startsWith('@@')) return 'diff-line diff-hunk';
  if (line.startsWith('diff --git')) return 'diff-line diff-header';
  if (line.startsWith('+')) return 'diff-line diff-add';
  if (line.startsWith('-')) return 'diff-line diff-del';
  return 'diff-line';
}

/**
 * Renders a unified diff as text with per-line classes. Deliberately no diff
 * library and no HTML in the patch: the content is agent output and is never
 * interpreted as markup.
 */
export function DiffView({ diff, onClose }: { diff: WorktreeDiffResponse; onClose?: () => void }) {
  const totals = diff.files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const lines = diff.patch.length === 0 ? [] : diff.patch.split('\n');
  return (
    <section className="panel diff-panel" aria-label="Worktree diff">
      <header className="panel-header">
        <div>
          <h3>Diff for {diff.worktree.branchName}</h3>
          <p className="hint">
            {shortSha(diff.baseSha)} → {shortSha(diff.headSha)} · {diff.files.length} file
            {diff.files.length === 1 ? '' : 's'} · +{totals.additions} −{totals.deletions}
          </p>
        </div>
        {onClose !== undefined && (
          <button type="button" className="secondary-button" onClick={onClose}>
            Close diff
          </button>
        )}
      </header>

      {diff.commits.length > 0 && (
        <>
          <h4>Commits on this branch ({diff.commits.length})</h4>
          <ul className="compact-list">
            {diff.commits.map((commit) => (
              <li key={commit.sha}>
                <span className="mono">{shortSha(commit.sha)}</span> {commit.subject}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Files</h4>
      {diff.files.length === 0 ? (
        <p className="empty-state">No changes against the base revision.</p>
      ) : (
        <div className="table-scroll">
          <table className="work-item-table">
            <caption className="visually-hidden">Changed files</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Change</th>
                <th scope="col">+</th>
                <th scope="col">−</th>
              </tr>
            </thead>
            <tbody>
              {diff.files.map((file) => (
                <tr key={`${file.status}:${file.path}`}>
                  <td className="mono">
                    {file.previousPath !== undefined && (
                      <span className="hint">{file.previousPath} → </span>
                    )}
                    {file.path}
                  </td>
                  <td>{STATUS_LABELS[file.status]}</td>
                  <td>{file.binary ? 'bin' : file.additions}</td>
                  <td>{file.binary ? 'bin' : file.deletions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {diff.patchTruncated && (
        <p className="warning-state" role="note">
          The patch was truncated at the daemon&rsquo;s size limit. The file list above is complete.
        </p>
      )}
      {lines.length > 0 && (
        <pre className="diff-text" data-testid="diff-text">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and immutable
            <span key={index} className={lineClass(line)}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </section>
  );
}
