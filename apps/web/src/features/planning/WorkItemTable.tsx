import type { WorkItemSummary } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';
import {
  blockerSummary,
  READINESS_ACCENTS,
  RISK_LABELS,
  readinessLabel,
} from '../../lib/planning-labels.js';

/**
 * Work items as a table with explicit predecessor and blocker columns.
 *
 * A table, not a graph canvas: for a fourteen-node graph these columns carry
 * the same information with none of the layout noise.
 */
export function WorkItemTable({
  items,
  onOpen,
}: {
  items: readonly WorkItemSummary[];
  onOpen: (workItemId: WorkItemSummary['id']) => void;
}) {
  if (items.length === 0) {
    return <p className="empty-state">This plan version has no work items.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">
          Work items in this plan version, with risk, state, and blockers
        </caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Title</th>
            <th scope="col">Risk</th>
            <th scope="col">State</th>
            <th scope="col">Required</th>
            <th scope="col">Blockers</th>
            <th scope="col">Areas</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                <button type="button" className="link-button mono" onClick={() => onOpen(item.id)}>
                  {item.sourceId}
                </button>
              </th>
              <td>{item.title}</td>
              <td>
                <span className={`risk risk-${item.risk}`}>{RISK_LABELS[item.risk]}</span>
              </td>
              <td>
                <span
                  className="status-badge"
                  style={{ '--badge-accent': READINESS_ACCENTS[item.readiness] } as CSSProperties}
                >
                  {readinessLabel(item.readiness)}
                </span>
              </td>
              <td className="numeric">{item.requiredPredecessorCount}</td>
              <td className="subtle">{blockerSummary(item)}</td>
              <td className="subtle">{item.primaryAreas.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
