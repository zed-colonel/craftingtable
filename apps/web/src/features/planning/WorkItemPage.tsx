import type { WorkItemDetailResponse } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { type SectionNavItem, SectionNav } from '../../components/SectionNav.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import {
  blockerSummary,
  READINESS_ACCENTS,
  READINESS_DESCRIPTIONS,
  RISK_LABELS,
  readinessLabel,
  STATUS_LABELS,
} from '../../lib/planning-labels.js';

/**
 * The head of a work item page: identity, state, the lifecycle actions, and
 * the overview section. The delegation, automation, slice, branch, and diff
 * sections follow it, composed by the app, and `sections` names them for the
 * on-page navigation.
 */
export function WorkItemPage({
  detail,
  inProgress,
  sections = [],
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
  sections?: readonly SectionNavItem[];
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
  const lifecycleActions =
    item.status === 'proposed' ? (
      <button
        type="button"
        className="primary-button"
        onClick={onAdmit}
        disabled={busy || !canMutate}
      >
        {busy ? 'Admitting…' : 'Admit into agenda'}
      </button>
    ) : item.status === 'admitted' ? (
      <>
        {detail.agendaRemoval && onRemoveFromAgenda && (
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
        <button
          type="button"
          className="secondary-button"
          onClick={onComplete}
          disabled={busy || !canMutate}
          title="Mark complete without merging a worktree"
        >
          Mark complete
        </button>
      </>
    ) : undefined;
  return (
    <>
      <PageHeader
        crumbs={
          <button type="button" className="link-button" onClick={onOpenProject}>
            {detail.projectName}
          </button>
        }
        title={
          <>
            <span className="mono">{item.sourceId}</span> · {item.title}
          </>
        }
        subtitle={READINESS_DESCRIPTIONS[item.readiness]}
        status={
          <span
            className="status-badge large"
            style={{ '--badge-accent': stateAccent } as CSSProperties}
          >
            {stateLabel}
          </span>
        }
        actions={
          lifecycleActions === undefined ? undefined : (
            <ActionBar label="Work item lifecycle">{lifecycleActions}</ActionBar>
          )
        }
      />

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

      <SectionNav items={sections} />

      <Section id="overview" title="Overview" summary={blockerSummary(item)}>
        <StatusStrip
          label="Work item facts"
          facts={[
            { label: 'Status', value: STATUS_LABELS[item.status] },
            {
              label: 'Risk',
              value: <span className={`risk risk-${item.risk}`}>{RISK_LABELS[item.risk]}</span>,
            },
            { label: 'Areas', value: item.primaryAreas.join(', ') || '—' },
            ...(item.admittedAt === undefined
              ? []
              : [{ label: 'Admitted', value: new Date(item.admittedAt).toLocaleString() }]),
            ...(item.completedAt === undefined
              ? []
              : [
                  {
                    label: 'Completed',
                    value: `${new Date(item.completedAt).toLocaleString()}${
                      item.mergeSha === undefined
                        ? ''
                        : ` · merged as ${item.mergeSha.slice(0, 10)}`
                    }`,
                  },
                ]),
          ]}
        />
        <div className="two-column">
          <div className="stack">
            <h4>Exit gate</h4>
            <p>{item.exitGate}</p>
          </div>
          <div className="stack">
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
          </div>
        </div>
      </Section>
    </>
  );
}
