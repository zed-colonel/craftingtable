import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ENTRY_STATE_LABELS } from '../planning/roadmap-labels.js';
import { type BoardModel, cardOf, indexOfKey, nodeAt } from './board-model.js';
import { type GraphGroup, neighbourhood } from './graph-neighbourhood.js';
import { layeredLayout } from './layered-layout.js';
import { BoardNotice, BoardSummary, GatesStrip } from './RoadmapBoard.js';
import { ACTOR_LABELS, type BoardLinks, SelectionContent } from './SelectionPanel.js';

/** The most groups drawn at once (ADR-072). */
export const NODE_CAP = 40;
/** Hops up and downstream before "expand". */
export const HOPS = 2;
const SIZE = { nodeWidth: 184, nodeHeight: 58, layerGap: 56, nodeGap: 14 };
const PAD = 8;

type Tone = 'done' | 'operator' | 'agent' | 'waiting';

/** What a group's node says: its id, title and the daemon's state, in words. */
function describe(model: BoardModel, group: GraphGroup): { line: string; tone: Tone } {
  const node = nodeAt(model, group.node);
  const states = group.members.map((i) => model.board.nodes[i]);
  if (states.every((s) => s?.satisfied)) return { line: 'Met', tone: 'done' };
  if (node.kind === 'checkpoint') {
    const state = states[0];
    const slices = state?.unblocks?.length ?? 0;
    return {
      line: `${state?.attentionItemId ? 'In Needs you · ' : 'Not met · '}unblocks ${slices}`,
      tone: state?.attentionItemId ? 'operator' : 'waiting',
    };
  }
  const card = cardOf(model, { node: group.node, gates: 0 });
  const row = card.headline;
  if (!row) return { line: 'No open entry', tone: 'waiting' };
  return {
    line: `${ENTRY_STATE_LABELS[row.state]} · ${ACTOR_LABELS[row.actor]}`,
    tone: row.actor === 'operator' ? 'operator' : card.runId ? 'agent' : 'waiting',
  };
}

/** A smooth path through an edge's points, left to right. */
function pathOf(points: readonly { x: number; y: number }[]): string {
  let d = `M ${points[0]!.x + PAD} ${points[0]!.y + PAD}`;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const dx = (b.x - a.x) / 2;
    d += ` C ${a.x + dx + PAD} ${a.y + PAD}, ${b.x - dx + PAD} ${b.y + PAD}, ${b.x + PAD} ${b.y + PAD}`;
  }
  return d;
}

/** Shortens a title to what a node holds. */
const short = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/**
 * The neighbourhood graph (R-E3b, ADR-072): the selection's work-item-level neighbourhood, two
 * hops each way, transitively reduced, laid out in layers; "expand" adds a hop, up to a node
 * cap. Nodes select in place as the board's cards do; nothing is posted or read.
 */
export function NeighbourhoodGraph({
  model,
  selected,
  onSelect,
  links,
}: {
  model: BoardModel;
  selected: string | undefined;
  onSelect: (key: string | undefined) => void;
  links: BoardLinks;
}) {
  const index = indexOfKey(model, selected);
  // A new selection starts at the first hops again.
  const [expanded, setHops] = useState({ index, hops: HOPS });
  const hops = expanded.index === index ? expanded.hops : HOPS;
  // Drawing never takes the page down: a graph it cannot lay out says so instead (R-E3b review).
  const drawn = useMemo(() => {
    if (index === undefined) return { near: undefined, wider: undefined, layout: undefined };
    try {
      const near = neighbourhood(model, index, hops, NODE_CAP);
      return {
        near,
        wider: neighbourhood(model, index, hops + 1, NODE_CAP),
        layout:
          near &&
          layeredLayout(
            near.groups.map((g) => g.node),
            near.edges,
            SIZE,
          ),
      };
    } catch {
      return { near: undefined, wider: undefined, layout: undefined, failed: true };
    }
  }, [model, index, hops]);
  const { near, wider, layout } = drawn;
  const heading = useRef<HTMLHeadingElement>(null);
  // The selection's node is brought into the middle of the scroll area.
  const scroller = useRef<HTMLDivElement>(null);
  const centre = near && layout?.nodes.get(near.centre);
  useEffect(() => {
    const area = scroller.current;
    if (!area || !centre) return;
    area.scrollLeft = centre.x + PAD + SIZE.nodeWidth / 2 - area.clientWidth / 2;
    area.scrollTop = centre.y + PAD + SIZE.nodeHeight / 2 - area.clientHeight / 2;
  }, [centre]);
  const moved = useRef(false);
  useEffect(() => {
    if (index === undefined || !moved.current) return;
    moved.current = false;
    heading.current?.focus();
  }, [index]);
  const select = (key: string) => {
    moved.current = true;
    onSelect(key);
  };
  const press = (event: KeyboardEvent<SVGGElement>, key: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select(key);
  };
  const groupOf = new Map(near?.groups.map((g) => [g.node, g]) ?? []);
  return (
    <div className="roadmap-board" data-board>
      <BoardSummary model={model} />
      <BoardNotice model={model} selected={selected} index={index} />
      <GatesStrip model={model} selected={index} onSelect={select} />
      <div className="board-body">
        <section aria-label="Neighbourhood graph" className="board-graph">
          {'failed' in drawn ? (
            <p role="alert" className="error-state">
              This neighbourhood could not be drawn. The selection panel still says what it waits
              on.
            </p>
          ) : index !== undefined && !near ? (
            <p className="empty-state">
              The selection is outside this roadmap's selected work, so it has no neighbourhood
              here.
            </p>
          ) : !near || !layout ? (
            <p className="empty-state">
              Select a gate above, or a card on the board, to draw what it requires and unblocks.
            </p>
          ) : (
            <>
              <div className="board-graph-controls">
                <span className="subtle">
                  {hops} {hops === 1 ? 'hop' : 'hops'} each way · {near.groups.length}
                  {near.reached > near.groups.length ? ` of ${near.reached}` : ''} nodes
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    !wider ||
                    (wider.reached === near.reached && near.reached === near.groups.length) ||
                    near.groups.length >= NODE_CAP
                  }
                  onClick={() => setHops({ index, hops: hops + 1 })}
                >
                  Expand
                </button>
                {hops > HOPS && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setHops({ index, hops: HOPS })}
                  >
                    Back to {HOPS} hops
                  </button>
                )}
              </div>
              <div className="board-graph-scroll" ref={scroller}>
                <svg
                  aria-labelledby="board-graph-title"
                  width={layout.width + 2 * PAD}
                  height={layout.height + 2 * PAD}
                  viewBox={`0 0 ${layout.width + 2 * PAD} ${layout.height + 2 * PAD}`}
                >
                  <title id="board-graph-title">{`Neighbourhood of ${nodeAt(model, near.centre).sourceId}`}</title>
                  <defs>
                    <marker
                      id="board-arrow"
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
                  {layout.edges.map((edge) => {
                    const met = groupOf
                      .get(edge.from)!
                      .members.every((i) => model.board.nodes[i]?.satisfied);
                    return (
                      <path
                        key={`${edge.from}>${edge.to}`}
                        d={pathOf(edge.points)}
                        className={`board-edge${met ? ' board-edge-met' : ''}${edge.back ? ' board-edge-back' : ''}`}
                        markerEnd="url(#board-arrow)"
                      />
                    );
                  })}
                  {near.groups.map((group) => {
                    const node = nodeAt(model, group.node);
                    const at = layout.nodes.get(group.node)!;
                    const { line, tone } = describe(model, group);
                    const chosen = index !== undefined && group.members.includes(index);
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be a <button>; it takes the button role, focus and keys.
                      <g
                        key={group.node}
                        role="button"
                        tabIndex={0}
                        aria-pressed={chosen}
                        aria-label={`${node.sourceId} ${node.title}: ${line}`}
                        className={`board-graph-node board-tone-${tone}${chosen ? ' board-graph-chosen' : ''}${group.node === near.centre ? ' board-graph-centre' : ''}`}
                        transform={`translate(${at.x + PAD} ${at.y + PAD})`}
                        onClick={() => select(node.key)}
                        onKeyDown={(event) => press(event, node.key)}
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
            </>
          )}
        </section>
        <aside aria-label="Selection" className="board-panel">
          {index === undefined ? (
            <p className="empty-state">Nothing selected.</p>
          ) : (
            <>
              <SelectionContent
                model={model}
                index={index}
                links={links}
                onSelect={select}
                headingRef={heading}
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => onSelect(undefined)}
              >
                Clear selection
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
