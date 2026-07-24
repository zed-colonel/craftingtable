import type { AuditRecordSummary } from '@craftingtable/contracts';

export function AuditPanel({ records }: { records: readonly AuditRecordSummary[] }) {
  return (
    <section className="utility-panel" aria-labelledby="audit-title">
      <h2 id="audit-title">Audit history</h2>
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
    </section>
  );
}
