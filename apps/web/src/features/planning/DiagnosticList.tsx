import type { PlanImportDiagnosticPayload } from '@craftingtable/contracts';

/**
 * A content-derived key.
 *
 * Diagnostics carry no wire identifier, and the server already orders them
 * deterministically by content, so this is stable across refetches in a way a
 * list index would not be.
 */
function diagnosticKey(diagnostic: PlanImportDiagnosticPayload): string {
  return [
    diagnostic.code,
    diagnostic.artifactName ?? '',
    diagnostic.workItemSourceId ?? '',
    diagnostic.path ?? '',
    diagnostic.message,
  ].join('|');
}

/** Diagnostics grouped by severity, each showing its stable machine code. */
export function DiagnosticList({
  diagnostics,
  emptyMessage = 'No diagnostics.',
}: {
  diagnostics: readonly PlanImportDiagnosticPayload[];
  emptyMessage?: string;
}) {
  if (diagnostics.length === 0) {
    return <p className="empty-state">{emptyMessage}</p>;
  }
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== 'error');
  return (
    <div className="diagnostics">
      {errors.length > 0 && (
        <section aria-label="Errors">
          <h4>
            {errors.length} error{errors.length === 1 ? '' : 's'}
          </h4>
          <ul className="diagnostic-list">
            {errors.map((diagnostic) => (
              <DiagnosticRow key={diagnosticKey(diagnostic)} diagnostic={diagnostic} />
            ))}
          </ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section aria-label="Warnings">
          <h4>
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </h4>
          <ul className="diagnostic-list">
            {warnings.map((diagnostic) => (
              <DiagnosticRow key={diagnosticKey(diagnostic)} diagnostic={diagnostic} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: PlanImportDiagnosticPayload }) {
  return (
    <li className={`diagnostic diagnostic-${diagnostic.severity}`}>
      <code className="diagnostic-code">{diagnostic.code}</code>
      <span className="diagnostic-message">{diagnostic.message}</span>
      <span className="diagnostic-where">
        {[diagnostic.artifactName, diagnostic.workItemSourceId, diagnostic.path]
          .filter((part) => part !== undefined)
          .join(' · ')}
      </span>
    </li>
  );
}
