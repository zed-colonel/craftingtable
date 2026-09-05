import type { AuditRecordSummary } from '@craftingtable/contracts';

export function AuditPanel({ records }: { records: readonly AuditRecordSummary[] }) {
  return (
    <details className="disclosure" aria-label="Audit history">
      <summary>
        <span>Audit</span>
        <span className="hint">{records.length} recent</span>
      </summary>
      <div className="disclosure-body">
        {records.length === 0 ? (
          <p className="empty-state">No workspace audit records.</p>
        ) : (
          <ul className="compact-list">
            {records.map((record) => (
              <li key={record.id}>
                <span>
                  {record.action}
                  <small>{new Date(record.occurredAt).toLocaleString()}</small>
                </span>
                <span className="audit-outcome">{record.outcome}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
