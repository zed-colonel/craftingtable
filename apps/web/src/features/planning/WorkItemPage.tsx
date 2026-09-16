import type { WorkItemDetailResponse } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';
import {
  blockerSummary,
  READINESS_ACCENTS,
  READINESS_DESCRIPTIONS,
  RISK_LABELS,
  readinessLabel,
  STATUS_LABELS,
} from '../../lib/planning-labels.js';

export function WorkItemPage({
  detail,
  inProgress,
  onAdmit,
  onRemoveFromAgenda,
  onComplete,
  onOpenProject,
  busy,
  error,
  canMutate,
}: {
  detail: WorkItemDetailResponse;
  /** Derived by the app from live worktrees and runs. */
  inProgress: boolean;
  onAdmit: () => void;
  onRemoveFromAgenda?: () => void;
  onComplete: () => void;
  onOpenProject: () => void;
  busy: boolean;
  error?: string;
  canMutate: boolean;
}) {
  const item = detail.workItem;
  const blocked = item.blockerSourceIds.length > 0;
  const stateLabel =
    item.status === 'admitted' && inProgress ? 'In progress' : readinessLabel(item.readiness);
  const stateAccent =
    item.status === 'admitted' && inProgress
      ? 'var(--color-active)'
      : READINESS_ACCENTS[item.readiness];
  return (
    <>
      <header className="page-header">
        <div>
          <div className="crumbs">
            <button type="button" className="link-button" onClick={onOpenProject}>
              {detail.projectName}
            </button>
          </div>
          <h1>
            <span className="mono" style={{ fontSize: 'var(--text-lg)' }}>
              {item.sourceId}
            </span>{' '}
            · {item.title}
          </h1>
          <p className="subtitle">{READINESS_DESCRIPTIONS[item.readiness]}</p>
        </div>
        <div className="page-header-actions">
          <span
            className="status-badge large"
            style={{ '--badge-accent': stateAccent } as CSSProperties}
          >
            {stateLabel}
          </span>
          {item.status === 'proposed' && (
            <button
              type="button"
              className="primary-button"
              onClick={onAdmit}
              disabled={busy || !canMutate}
            >
              {busy ? 'Admitting…' : 'Admit into agenda'}
            </button>
          )}
          {item.status === 'admitted' && detail.agendaRemoval && onRemoveFromAgenda && (
            <button
              type="button"
              className="secondary-button"
              onClick={onRemoveFromAgenda}
              disabled={busy || !canMutate || !detail.agendaRemoval.allowed}
              title={
                detail.agendaRemoval.reason ??
                'Return this unstarted item to Proposed; admission history is preserved.'
              }
            >
              Remove from agenda
            </button>
          )}
          {item.status === 'admitted' && (
            <button
              type="button"
              className="secondary-button"
              onClick={onComplete}
              disabled={busy || !canMutate}
              title="Mark complete without merging a worktree"
            >
              Mark complete
            </button>
          )}
        </div>
      </header>

      {item.status === 'admitted' && detail.agendaRemoval?.reason && (
        <p className="hint">{detail.agendaRemoval.reason}</p>
      )}
      {error !== undefined && (
        <p className="error-state" role="alert">
          {error}
        </p>
      )}
      {item.status === 'proposed' && blocked && (
        <p className="warning-state" role="note">
          This item is dependency-blocked by {item.blockerSourceIds.join(', ')}. You may still admit
          it: admission means “I accept this into the agenda”, not “run this now”. The blockers stay
          visible afterwards.
        </p>
      )}
      {!canMutate && item.status !== 'completed' && (
        <p className="hint">Your workspace role does not permit changing work items.</p>
      )}

      <div className="two-column">
        <section className="panel" aria-label="Work item details">
          <dl className="definition-grid">
            <dt>Status</dt>
            <dd>{STATUS_LABELS[item.status]}</dd>
            <dt>Risk</dt>
            <dd className={`risk risk-${item.risk}`}>{RISK_LABELS[item.risk]}</dd>
            <dt>Primary areas</dt>
            <dd>{item.primaryAreas.join(', ') || '—'}</dd>
            <dt>Exit gate</dt>
            <dd>{item.exitGate}</dd>
            <dt>Blockers</dt>
            <dd>{blockerSummary(item)}</dd>
            {item.admittedAt !== undefined && (
              <>
                <dt>Admitted</dt>
                <dd>{new Date(item.admittedAt).toLocaleString()}</dd>
              </>
            )}
            {item.completedAt !== undefined && (
              <>
                <dt>Completed</dt>
                <dd>
                  {new Date(item.completedAt).toLocaleString()}
                  {item.mergeSha === undefined ? '' : ` · merged as ${item.mergeSha.slice(0, 10)}`}
                </dd>
              </>
            )}
          </dl>
        </section>

        <section className="panel" aria-label="Dependencies">
          <h3>Dependencies</h3>
          <h4>Required predecessors ({detail.requiredPredecessors.length})</h4>
          {detail.requiredPredecessors.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <ul className="dependency-list">
              {detail.requiredPredecessors.map((entry) => (
                <li key={entry.workItemId}>
                  <strong className="mono">{entry.sourceId}</strong> {entry.title}{' '}
                  <span className="hint">({STATUS_LABELS[entry.status]})</span>
                </li>
              ))}
            </ul>
          )}
          <h4>Recommended ({detail.recommendedPredecessors.length})</h4>
          {detail.recommendedPredecessors.length === 0 ? (
            <p className="hint">None. Recommendations never block admission.</p>
          ) : (
            <ul className="dependency-list">
              {detail.recommendedPredecessors.map((entry) => (
                <li key={entry.workItemId}>
                  <strong className="mono">{entry.sourceId}</strong> {entry.title}
                </li>
              ))}
            </ul>
          )}
          <h4>Dependents ({detail.dependents.length})</h4>
          <p className="hint">
            {detail.dependents.map((entry) => entry.sourceId).join(', ') || 'None'}
          </p>
        </section>
      </div>
    </>
  );
}
