import type { ImportIssue } from '@craftingtable/domain';
export function ImportIssues({ issues }: { issues: readonly ImportIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="import-issues">
      {issues.map((issue) => (
        <li key={`${issue.code}-${issue.path ?? ''}-${issue.message}`}>
          <strong>
            {issue.severity === 'error'
              ? 'Needs resolution'
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
