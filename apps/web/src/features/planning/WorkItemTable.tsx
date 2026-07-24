import type { WorkItemSummary } from '@craftingtable/contracts';
import type { CSSProperties } from 'react';
import {
  blockerSummary,
  READINESS_ACCENTS,
  readinessLabel,
  RISK_LABELS,
} from '../../lib/planning-labels.js';

/**
 * Work items as a table with explicit predecessor and blocker columns.
 *
 * A table, not a graph canvas: CT-03 §5.14 forbids the canvas, and for a
 * fourteen-node graph these columns carry the same information.
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
      <table className="work-item-table">
        <caption className="visually-hidden">
          Work items in this plan version, with risk, readiness, and blockers
        </caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Title</th>
            <th scope="col">Risk</th>
            <th scope="col">Status</th>
            <th scope="col">Required predecessors</th>
            <th scope="col">Blockers</th>
            <th scope="col">Primary areas</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                <button type="button" className="link-button" onClick={() => onOpen(item.id)}>
                  {item.sourceId}
                </button>
              </th>
              <td>{item.title}</td>
              <td>
                <span className={`risk risk-${item.risk}`}>{RISK_LABELS[item.risk]}</span>
              </td>
              <td>
                <span
                  className="readiness-badge"
                  style={{ '--badge-accent': READINESS_ACCENTS[item.readiness] } as CSSProperties}
                >
                  {readinessLabel(item.readiness)}
                </span>
              </td>
              <td>{item.requiredPredecessorCount}</td>
              <td>{blockerSummary(item)}</td>
              <td>{item.primaryAreas.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
