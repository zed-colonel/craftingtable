import type { WorkItemDetailResponse } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';
import {
  blockerSummary,
  READINESS_ACCENTS,
  READINESS_DESCRIPTIONS,
  readinessLabel,
  RISK_LABELS,
} from '../../lib/planning-labels.js';
import { WorkContractDraftPanel } from './WorkContractDraftPanel.js';

export function WorkItemPage({
  detail,
  onAdmit,
  admitting,
  admitError,
  canAdmit,
}: {
  detail: WorkItemDetailResponse;
  onAdmit: () => void;
  admitting: boolean;
  admitError?: string;
  canAdmit: boolean;
}) {
  const item = detail.workItem;
  const blocked = item.blockerSourceIds.length > 0;
  return (
    <div className="planning-page">
      <header className="page-header">
        <h2>
          {item.sourceId} · {item.title}
        </h2>
        <p className="subtitle">{detail.projectName}</p>
        <span
          className="readiness-badge"
          style={{ '--badge-accent': READINESS_ACCENTS[item.readiness] } as CSSProperties}
        >
          {readinessLabel(item.readiness)}
        </span>
        <p className="hint">{READINESS_DESCRIPTIONS[item.readiness]}</p>
      </header>

      <section className="panel" aria-label="Work item details">
        <dl className="definition-grid">
          <dt>Source ID</dt>
          <dd>{item.sourceId}</dd>
          <dt>Status</dt>
          <dd>{item.status === 'admitted' ? 'Admitted' : 'Proposed'}</dd>
          <dt>Risk</dt>
          <dd className={`risk risk-${item.risk}`}>{RISK_LABELS[item.risk]}</dd>
          <dt>Primary areas</dt>
          <dd>{item.primaryAreas.join(', ') || '—'}</dd>
          <dt>Exit gate</dt>
          <dd>{item.exitGate}</dd>
          <dt>Current blockers</dt>
          <dd>{blockerSummary(item)}</dd>
          {item.admittedAt !== undefined && (
            <>
              <dt>Admitted</dt>
              <dd>{new Date(item.admittedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="panel" aria-label="Dependencies">
        <h3>Dependencies</h3>
        <h4>Required predecessors ({detail.requiredPredecessors.length})</h4>
        {detail.requiredPredecessors.length === 0 ? (
          <p className="empty-state">None. This item has no required predecessors.</p>
        ) : (
          <ul className="dependency-list">
            {detail.requiredPredecessors.map((entry) => (
              <li key={entry.workItemId}>
                <strong>{entry.sourceId}</strong> — {entry.title} (
                {entry.status === 'admitted' ? 'Admitted' : 'Proposed'})
              </li>
            ))}
          </ul>
        )}
        <h4>Recommended ({detail.recommendedPredecessors.length})</h4>
        {detail.recommendedPredecessors.length === 0 ? (
          <p className="empty-state">None. Recommendations never block admission.</p>
        ) : (
          <ul className="dependency-list">
            {detail.recommendedPredecessors.map((entry) => (
              <li key={entry.workItemId}>
                <strong>{entry.sourceId}</strong> — {entry.title}
              </li>
            ))}
          </ul>
        )}
        <h4>Dependents ({detail.dependents.length})</h4>
        <p className="hint">
          {detail.dependents.map((entry) => entry.sourceId).join(', ') || 'None'}
        </p>
      </section>

      <section className="panel" aria-label="Admission">
        <h3>Admission</h3>
        {item.status === 'admitted' ? (
          <p className="hint">
            This item is in your agenda. Admission is not execution readiness — CraftingTable cannot
            run, review, or merge work.
          </p>
        ) : (
          <>
            {blocked && (
              <p className="warning-state" role="note">
                This item is dependency-blocked by {item.blockerSourceIds.join(', ')}. You may still
                admit it: admission means “I accept this into the agenda”, not “run this now”. The
                blockers stay visible afterwards.
              </p>
            )}
            {admitError !== undefined && (
              <p className="error-state" role="alert">
                {admitError}
              </p>
            )}
            <button
              type="button"
              className="primary-button"
              onClick={onAdmit}
              disabled={admitting || !canAdmit}
            >
              {admitting ? 'Admitting…' : 'Admit into agenda'}
            </button>
            {!canAdmit && (
              <p className="hint">Your workspace role does not permit admitting work items.</p>
            )}
          </>
        )}
      </section>

      {detail.draft !== null && <WorkContractDraftPanel draft={detail.draft} />}
    </div>
  );
}
