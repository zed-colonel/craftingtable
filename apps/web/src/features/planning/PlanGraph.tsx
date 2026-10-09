import type { PlanVersionGraph, WorkItemSummary } from '@craftingtable/contracts';
import type { WorkItemId } from '@craftingtable/domain';
import { type KeyboardEvent, useMemo } from 'react';
import { readinessLabel } from '../../lib/planning-labels.js';
import { transitiveReduction } from '../roadmap-board/graph-neighbourhood.js';
import { edgePath, layeredLayout } from '../roadmap-board/layered-layout.js';

/** The most work items drawn: past this the graph is unreadable, and the table stands in. */
export const PLAN_GRAPH_CAP = 60;
const SIZE = { nodeWidth: 184, nodeHeight: 58, layerGap: 56, nodeGap: 14 };
const PAD = 8;

const short = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/**
 * A plan version's dependency graph (R-E4, deferred from R-E3b; ADR-072): every work item, its
 * required predecessors drawn left of it, transitively reduced, with R-E3b's layered layout. The
 * structure is read once per version; each node says its item's state from the version's detail,
 * in words. A node opens its work item. Desktop only: on a phone the work item table stands in.
 */
export function PlanGraph({
  graph,
  items,
  onOpen,
}: {
  graph: PlanVersionGraph;
  /** The version's work items as its detail reads them, for each node's state. */
  items: readonly WorkItemSummary[];
  onOpen: (workItemId: WorkItemId) => void;
}) {
  const drawn = useMemo(() => {
    if (graph.nodes.length > PLAN_GRAPH_CAP) return undefined;
    const indices = graph.nodes.map((_, i) => i);
    try {
      return layeredLayout(indices, transitiveReduction(indices, graph.edges), SIZE);
    } catch {
      return null;
    }
  }, [graph]);
  if (drawn === undefined)
    return (
      <p className="empty-state">
        {graph.nodes.length} work items are too many to draw; the table lists them.
      </p>
    );
  if (drawn === null)
    return (
      <p className="error-state" role="alert">
        The dependency graph could not be laid out; the table lists the work items.
      </p>
    );
  const state = new Map(items.map((item) => [item.id as string, item]));
  const open = (event: KeyboardEvent<SVGGElement>, workItemId: WorkItemId) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(workItemId);
  };
  return (
    <div className="board-graph-scroll">
      <svg
        aria-labelledby="plan-graph-title"
        width={drawn.width + 2 * PAD}
        height={drawn.height + 2 * PAD}
        viewBox={`0 0 ${drawn.width + 2 * PAD} ${drawn.height + 2 * PAD}`}
      >
        <title id="plan-graph-title">Work item dependencies</title>
        <defs>
          <marker
            id="plan-arrow"
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" className="board-arrow" />
          </marker>
        </defs>
        {drawn.edges.map((edge) => (
          <path
            key={`${edge.from}>${edge.to}`}
            d={edgePath(edge.points, PAD)}
            className={`board-edge${
              state.get(graph.nodes[edge.from]!.workItemId)?.readiness === 'completed'
                ? ' board-edge-met'
                : ''
            }${edge.back ? ' board-edge-back' : ''}`}
            markerEnd="url(#plan-arrow)"
          />
        ))}
        {graph.nodes.map((node, i) => {
          const at = drawn.nodes.get(i)!;
          const item = state.get(node.workItemId);
          const line = item ? readinessLabel(item.readiness) : 'Not read';
          const tone = item?.readiness === 'completed' ? 'done' : 'waiting';
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be a <button>; it takes the button role, focus and keys.
            <g
              key={node.workItemId}
              role="button"
              tabIndex={0}
              aria-label={`${node.sourceId} ${node.title}: ${line}`}
              className={`board-graph-node board-tone-${tone}`}
              transform={`translate(${at.x + PAD} ${at.y + PAD})`}
              onClick={() => onOpen(node.workItemId as WorkItemId)}
              onKeyDown={(event) => open(event, node.workItemId as WorkItemId)}
            >
              <rect width={SIZE.nodeWidth} height={SIZE.nodeHeight} rx={6} />
              <text x={8} y={16} className="board-graph-id">
                {short(node.sourceId, 24)}
              </text>
              <text x={8} y={32} className="board-graph-title">
                {short(node.title, 26)}
              </text>
              <text x={8} y={48} className="board-graph-state">
                {short(line, 28)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
