import type { ImportIssue } from '@craftingtable/domain';
export function ImportIssues({
  issues,
  errorLabel = 'Needs resolution',
}: {
  issues: readonly ImportIssue[];
  errorLabel?: string;
}) {
  if (!issues.length) return null;
  return (
    <ul className="import-issues">
      {issues.map((issue) => (
        <li key={`${issue.code}-${issue.path ?? ''}-${issue.message}`}>
          <strong>
            {issue.severity === 'error'
              ? errorLabel
              : issue.severity === 'warning'
                ? 'Note'
                : 'Information'}
            :
          </strong>{' '}
          {issue.message}
          {issue.path && <code>{issue.path}</code>}
        </li>
      ))}
    </ul>
  );
}
