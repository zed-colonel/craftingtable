import { type KeyboardEvent, useEffect, useRef } from 'react';
import { StatusStrip } from '../../components/StatusStrip.js';
import { ENTRY_STATE_LABELS } from '../planning/roadmap-labels.js';
import { type BoardModel, type Card, cardOf, indexOfKey, nodeAt } from './board-model.js';
import { ACTOR_LABELS, type BoardLinks, SelectionContent } from './SelectionPanel.js';

/** Gates shown before "show all". */
const GATES_SHOWN = 8;

/** The status strip's counts, as the daemon gave them. */
export function BoardSummary({ model }: { model: BoardModel }) {
  const { summary } = model.board;
  return (
    <StatusStrip
      label="Board summary"
      facts={[
        {
          label: 'Needs you',
          value: summary.needsYou,
          mono: true,
          ...(summary.needsYou ? { accent: 'var(--color-attention)' } : {}),
        },
        {
          label: 'Agents at work',
          value: summary.agentsAtWork,
          mono: true,
          ...(summary.agentsAtWork ? { accent: 'var(--color-active)' } : {}),
        },
        { label: 'Waiting', value: summary.waiting, mono: true },
        { label: 'Done', value: summary.done, mono: true },
      ]}
    />
  );
}

/** One gate: its checkpoint, the slices it unblocks, and whether Needs you holds it. */
export function GateButton({
  model,
  gate,
  selected,
  onSelect,
}: {
  model: BoardModel;
  gate: BoardModel['board']['gates'][number];
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const node = nodeAt(model, gate.node);
  return (
    <button
      type="button"
      className={`board-gate${gate.attentionItemId ? ' board-gate-inbox' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(node.key)}
    >
      <code>{node.sourceId}</code>
      <span className="board-gate-count">unblocks {gate.slices}</span>
      {gate.attentionItemId && <span className="board-flag">In Needs you</span>}
    </button>
  );
}

function GatesStrip({
  model,
  selected,
  onSelect,
}: {
  model: BoardModel;
  selected: number | undefined;
  onSelect: (key: string) => void;
}) {
  const { gates } = model.board;
  if (gates.length === 0) return null;
  const gate = (g: (typeof gates)[number]) => (
    <li key={g.node}>
      <GateButton model={model} gate={g} selected={selected === g.node} onSelect={onSelect} />
    </li>
  );
  return (
    <section aria-label="Gates" className="board-gates">
      <h3>Gates ({gates.length})</h3>
      <ul className="board-gate-list">{gates.slice(0, GATES_SHOWN).map(gate)}</ul>
      {gates.length > GATES_SHOWN && (
        <details>
          <summary className="board-more">All {gates.length} gates</summary>
          <ul className="board-gate-list">{gates.slice(GATES_SHOWN).map(gate)}</ul>
        </details>
      )}
    </section>
  );
}

/** A milestone chip: selectable, labelled with its state and whether it is met. */
function MilestoneChip({
  model,
  index,
  selected,
  onSelect,
}: {
  model: BoardModel;
  index: number;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const node = nodeAt(model, index);
  const met = model.board.nodes[index]?.satisfied === true;
  return (
    <button
      type="button"
      className={`board-chip${met ? ' board-chip-met' : ''}`}
      aria-pressed={selected}
      aria-label={`${node.sourceId} ${node.state}: ${met ? 'met' : 'not met'}`}
      onClick={() => onSelect(node.key)}
    >
      {met ? '✓ ' : ''}
      {node.state}
    </button>
  );
}

/** Moves focus to the next or previous card's title on the arrow keys. */
function moveBetweenCards(event: KeyboardEvent<HTMLButtonElement>) {
  const step = ['ArrowDown', 'ArrowRight'].includes(event.key)
    ? 1
    : ['ArrowUp', 'ArrowLeft'].includes(event.key)
      ? -1
      : 0;
  if (step === 0) return;
  const board = event.currentTarget.closest('[data-board]');
  const cards = [...(board?.querySelectorAll<HTMLButtonElement>('[data-board-card]') ?? [])];
  const next = cards[cards.indexOf(event.currentTarget) + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

export function BoardCard({
  model,
  card,
  selected,
  onSelect,
}: {
  model: BoardModel;
  card: Card;
  selected: number | undefined;
  onSelect: (key: string) => void;
}) {
  const node = nodeAt(model, card.node);
  const row = card.headline;
  const chosen = selected !== undefined && card.nodes.includes(selected);
  return (
    <article className={`board-card${chosen ? ' board-card-selected' : ''}`}>
      <button
        type="button"
        className="board-card-title"
        data-board-card
        aria-pressed={selected === card.node}
        onClick={() => onSelect(node.key)}
        onKeyDown={moveBetweenCards}
      >
        <code>{node.sourceId}</code> <span className="board-card-name">{node.title}</span>
      </button>
      {row ? (
        <div className="board-card-state">
          <span className={`board-state board-actor-${row.actor}`}>
            {ENTRY_STATE_LABELS[row.state]} · {ACTOR_LABELS[row.actor]}
          </span>
          {card.runId && <span className="board-live">Agent at work</span>}
        </div>
      ) : (
        <div className="board-card-state subtle">No open entry</div>
      )}
      {row?.waitsOn && <div className="board-card-wait">{row.waitsOn.reason}</div>}
      {card.slices.length > 0 && (
        <ul className="board-slices">
          {card.slices.map((slice) => (
            <li key={slice.sourceId} className="board-slice">
              <span className="board-slice-name" title={slice.title}>
                {slice.sourceId.split('/').at(-1)}
              </span>
              {slice.milestones.map((i) => (
                <MilestoneChip
                  key={i}
                  model={model}
                  index={i}
                  selected={selected === i}
                  onSelect={onSelect}
                />
              ))}
            </li>
          ))}
        </ul>
      )}
      {card.gates > 0 && (
        <div className="subtle">
          {card.gates} {card.gates === 1 ? 'gate' : 'gates'}
        </div>
      )}
    </article>
  );
}

/**
 * The roadmap board (R-E3b): the status strip, the Gates strip, the project lanes and the
 * selection panel. Everything shown is the daemon's; selecting changes only the route.
 */
export function RoadmapBoard({
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
  const heading = useRef<HTMLHeadingElement>(null);
  // A selection the operator made moves focus into the panel; one read from the address does not.
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
  const lanes = model.board.lanes.filter((lane) => lane.cards.length + lane.done.length > 0);
  return (
    <div className="roadmap-board" data-board>
      <BoardSummary model={model} />
      {index === undefined && selected !== undefined && (
        <p role="status" className="warning-state">
          {`${selected} is not on this roadmap's board.`}
        </p>
      )}
      <GatesStrip model={model} selected={index} onSelect={select} />
      <div className="board-body">
        <div className="board-lanes">
          {lanes.map((lane) => {
            const label = model.graph.lanes[lane.lane]!;
            return (
              <section key={lane.lane} aria-label={`Lane ${label.key}`} className="board-lane">
                <h3>
                  <code>{label.key}</code> <span className="subtle">{label.label}</span>
                </h3>
                <div className="board-cards">
                  {lane.cards.map((c) => (
                    <BoardCard
                      key={c.node}
                      model={model}
                      card={cardOf(model, c)}
                      selected={index}
                      onSelect={select}
                    />
                  ))}
                </div>
                {lane.done.length > 0 && (
                  <details className="board-done">
                    <summary className="board-more">✓ {lane.done.length} done</summary>
                    <div className="board-cards">
                      {lane.done.map((node) => (
                        <BoardCard
                          key={node}
                          model={model}
                          card={cardOf(model, { node, gates: 0 })}
                          selected={index}
                          onSelect={select}
                        />
                      ))}
                    </div>
                  </details>
                )}
              </section>
            );
          })}
        </div>
        <aside aria-label="Selection" className="board-panel">
          {index === undefined ? (
            <p className="empty-state">
              Select a card, slice or gate to see what it waits on and what it unblocks.
            </p>
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
