import type { WorkContractDraftSummary } from '@craftingtable/contracts';

interface DraftDocument {
  readonly objective?: { readonly title?: string; readonly exitGate?: string };
  readonly classification?: { readonly risk?: string; readonly primaryAreas?: string[] };
  readonly dependencies?: {
    readonly required?: { readonly sourceId: string; readonly status: string }[];
    readonly recommended?: { readonly sourceId: string; readonly status: string }[];
  };
  readonly missing?: readonly string[];
  readonly merge?: { readonly humanAuthorizationRequired?: boolean };
  readonly review?: {
    readonly requiredPerspectives?: readonly string[];
    readonly maxRemediationGenerations?: number;
  };
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  'registered-repository': 'Registered repository',
  'exact-base-revision': 'Exact base revision',
  'path-scope': 'Writable and forbidden path scope',
  'verification-policy': 'Verification commands',
  'protected-acceptance-criteria': 'Protected acceptance criteria',
  'agent-backend': 'Agent backend',
  'execution-environment': 'Execution environment',
};

/**
 * The initial work-contract draft.
 *
 * There is no edit, save, or approve control anywhere in this panel: CT-03
 * cannot approve a contract, create a change request, create a worktree, or
 * start an agent, and the draft must not imply otherwise (ADR-014).
 */
export function WorkContractDraftPanel({ draft }: { draft: WorkContractDraftSummary }) {
  const document = draft.document as DraftDocument;
  const missing = document.missing ?? [];
  return (
    <section className="draft-panel" aria-label="Work contract draft">
      <h3>Work contract draft</h3>
      <p className="draft-banner" role="note">
        <strong>Draft — not executable.</strong> CraftingTable cannot approve, run, or merge this
        contract. Admission accepts the item into your agenda; it does not make work runnable.
      </p>

      <dl className="definition-grid">
        <dt>Status</dt>
        <dd>{draft.status}</dd>
        <dt>Completeness</dt>
        <dd>{draft.completeness}</dd>
        <dt>Schema version</dt>
        <dd>{draft.schemaVersion}</dd>
        <dt>Objective</dt>
        <dd>{document.objective?.title ?? '—'}</dd>
        <dt>Exit gate</dt>
        <dd>{document.objective?.exitGate ?? '—'}</dd>
        <dt>Risk</dt>
        <dd>{document.classification?.risk ?? '—'}</dd>
        <dt>Primary areas</dt>
        <dd>{(document.classification?.primaryAreas ?? []).join(', ') || '—'}</dd>
        <dt>Required dependencies</dt>
        <dd>
          {(document.dependencies?.required ?? []).map((entry) => entry.sourceId).join(', ') ||
            'None'}
        </dd>
        <dt>Merge</dt>
        <dd>
          {document.merge?.humanAuthorizationRequired === true
            ? 'Human authorization required'
            : '—'}
        </dd>
        <dt>Review perspectives</dt>
        <dd>{(document.review?.requiredPerspectives ?? []).join(', ') || '—'}</dd>
      </dl>

      <section aria-label="Unresolved fields">
        <h4>Unresolved ({missing.length})</h4>
        <p className="hint">
          These are enumerated rather than left blank: a blank field reads as “nothing required”, an
          enumerated one reads as “not yet decided”.
        </p>
        <ul className="missing-list">
          {missing.map((field) => (
            <li key={field} className="missing-field">
              {MISSING_FIELD_LABELS[field] ?? field}
            </li>
          ))}
        </ul>
      </section>

      <details className="draft-source">
        <summary>Read-only draft document</summary>
        <section className="source-text-region" aria-label="Draft contract document">
          <pre className="source-text">{JSON.stringify(draft.document, null, 2)}</pre>
        </section>
      </details>
    </section>
  );
}
