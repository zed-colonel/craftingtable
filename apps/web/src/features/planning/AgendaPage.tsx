import type { WorkspaceWorkItemListResponse } from '@craftingtable/contracts';
import type { ProjectId, WorkItemId } from '@craftingtable/domain';
import type { CSSProperties } from 'react';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import {
  blockerSummary,
  READINESS_ACCENTS,
  RISK_LABELS,
  readinessLabel,
} from '../../lib/planning-labels.js';
import { AGENDA_FILTERS, type AgendaFilter } from '../../lib/route.js';

const FILTER_LABELS: Readonly<Record<AgendaFilter, string>> = {
  all: 'All',
  admitted: 'In agenda',
  'planning-ready': 'Ready for admission',
  'dependency-blocked': 'Dependency-blocked',
  completed: 'Completed',
};

/** Work items across every project of the workspace, one state at a time. */
export function AgendaPage({
  filter,
  listing,
  onSelectFilter,
  onOpenWorkItem,
  onOpenProject,
}: {
  filter: AgendaFilter;
  listing?: WorkspaceWorkItemListResponse;
  onSelectFilter: (filter: AgendaFilter) => void;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
  onOpenProject: (projectId: ProjectId) => void;
}) {
  const items = listing?.filter === filter ? listing.items : undefined;
  return (
    <div className="page">
      <PageHeader
        title="Work items"
        subtitle="Every project's active plan, filtered by where each item stands."
      />

      <div className="tabs" role="tablist" aria-label="Work item filters">
        {AGENDA_FILTERS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            className="tab"
            aria-selected={candidate === filter}
            onClick={() => onSelectFilter(candidate)}
          >
            {FILTER_LABELS[candidate]}
          </button>
        ))}
      </div>

      <Section
        title={FILTER_LABELS[filter]}
        label={`${FILTER_LABELS[filter]} work items`}
        {...(items === undefined ? {} : { count: items.length })}
      >
        {items === undefined ? (
          <p className="empty-state">Loading…</p>
        ) : items.length === 0 ? (
          <p className="empty-state">Nothing here right now.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">{FILTER_LABELS[filter]} work items</caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Title</th>
                  <th scope="col">Project</th>
                  <th scope="col">State</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Blockers</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="link-button mono"
                        onClick={() => onOpenWorkItem(item.id)}
                      >
                        {item.sourceId}
                      </button>
                    </th>
                    <td>{item.title}</td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onOpenProject(item.projectId)}
                      >
                        {item.projectName}
                      </button>
                    </td>
                    <td>
                      <span
                        className="status-badge"
                        style={
                          { '--badge-accent': READINESS_ACCENTS[item.readiness] } as CSSProperties
                        }
                      >
                        {readinessLabel(item.readiness)}
                      </span>
                    </td>
                    <td>
                      <span className={`risk risk-${item.risk}`}>{RISK_LABELS[item.risk]}</span>
                    </td>
                    <td className="subtle">{blockerSummary(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
