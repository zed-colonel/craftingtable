import type { WorkItemDetailResponse } from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import { type CSSProperties, Fragment, type ReactNode } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { type SectionNavItem, SectionNav } from '../../components/SectionNav.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { Link } from '../../lib/navigation.js';
import {
  blockerSummary,
  READINESS_ACCENTS,
  READINESS_DESCRIPTIONS,
  RISK_LABELS,
  readinessLabel,
  STATUS_LABELS,
} from '../../lib/planning-labels.js';

type Dependency = WorkItemDetailResponse['dependents'][number];

/** Work items as links to their pages, each with its state in words (R-E4). */
function DependencyLinks({
  workspaceId,
  entries,
}: {
  workspaceId: WorkspaceId;
  entries: readonly Dependency[];
}) {
  return (
    <ul className="dependency-links">
      {entries.map((entry) => (
        <li key={entry.workItemId}>
          <Link
            route={{ name: 'work-item', workspaceId, workItemId: entry.workItemId }}
            title={entry.title}
          >
            <span className="mono">{entry.sourceId}</span>
          </Link>{' '}
          <span className="hint">{STATUS_LABELS[entry.status]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The head of a work item page (R-E4): identity, state, the lifecycle actions, the slice strip,
 * the on-page navigation and the overview, whose predecessors and dependents are links. The
 * automation, slice, delegation, run, branch and diff sections follow it, composed by the app,
 * and `sections` names them for the on-page navigation.
 */
export function WorkItemPage({
  workspaceId,
  strip,
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
  workspaceId: WorkspaceId;
  /** The item's slices at a glance, above its sections (R-E4); absent without slices. */
  strip?: ReactNode;
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
  const dependencyRows = (
    [
      ['Requires', detail.requiredPredecessors],
      ['Recommended', detail.recommendedPredecessors],
      ['Unblocks', detail.dependents],
    ] as const
  ).filter(([, entries]) => entries.length > 0);
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
          This item is dependency-blocked by{' '}
          {item.blockerSourceIds.map((sourceId, index) => {
            const blocker = detail.requiredPredecessors.find((p) => p.sourceId === sourceId);
            return (
              <Fragment key={sourceId}>
                {index > 0 && ', '}
                {blocker ? (
                  <Link
                    route={{ name: 'work-item', workspaceId, workItemId: blocker.workItemId }}
                    title={blocker.title}
                  >
                    {sourceId}
                  </Link>
                ) : (
                  sourceId
                )}
              </Fragment>
            );
          })}
          . You may still admit it: admission means “I accept this into the agenda”, not “run this
          now”. The blockers stay visible afterwards.
        </p>
      )}
      {!canMutate && item.status !== 'completed' && (
        <p className="hint">Your workspace role does not permit changing work items.</p>
      )}

      {strip}
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
        <p>
          <strong>Exit gate.</strong> {item.exitGate}
        </p>
        {/* Only the dependency rows that have entries; the section's summary says when none
            block (R-E4). */}
        {dependencyRows.length === 0 ? (
          <p className="hint">No predecessors or dependents.</p>
        ) : (
          <dl className="dependency-facts">
            {dependencyRows.map(([label, entries]) => (
              <Fragment key={label}>
                <dt>
                  {label} ({entries.length})
                </dt>
                <dd>
                  <DependencyLinks workspaceId={workspaceId} entries={entries} />
                </dd>
              </Fragment>
            ))}
          </dl>
        )}
      </Section>
    </>
  );
}
