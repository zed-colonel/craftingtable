import { ENTRY_STATE_LABELS } from '../planning/roadmap-labels.js';
import { type BoardModel, indexOfKey, nodeOfEntry, type StatusRow } from './board-model.js';
import { BoardNotice, BoardSummary, GateButton } from './RoadmapBoard.js';
import { type BoardLinks, SelectionContent } from './SelectionPanel.js';

/** Gates listed before "show all". */
const GATES_SHOWN = 8;

/**
 * The board on a phone (R-E3b): the grouped status list, whose rows and gates select in place,
 * the selection's content opening under what was selected. Everything shown is the daemon's.
 */
export function BoardList({
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
  const { summary } = model.board;
  // Selecting what is open closes it.
  const toggle = (key: string) => onSelect(key === selected ? undefined : key);
  const detail = (at: number | undefined) =>
    at !== undefined && at === index ? (
      <div className="board-inline">
        <SelectionContent
          model={model}
          index={at}
          links={links}
          onSelect={onSelect}
          headingLevel={4}
        />
      </div>
    ) : null;
  const groups: readonly [string, StatusRow['actor'][], number][] = [
    ['Needs you', ['operator'], summary.needsYou],
    ['Agents at work', ['agent'], summary.agentsAtWork],
    ['Waiting', ['controller', 'none'], summary.waiting],
  ];
  const gate = (g: BoardModel['board']['gates'][number]) => (
    <li key={g.node}>
      <GateButton model={model} gate={g} selected={index === g.node} onSelect={toggle} />
      {detail(g.node)}
    </li>
  );
  return (
    <div className="roadmap-board board-list">
      <BoardSummary model={model} />
      <BoardNotice model={model} selected={selected} index={index} />
      {model.board.gates.length > 0 && (
        <section aria-label="Gates" className="board-gates">
          <h3>Gates ({model.board.gates.length})</h3>
          <ul className="board-gate-rows">{model.board.gates.slice(0, GATES_SHOWN).map(gate)}</ul>
          {model.board.gates.length > GATES_SHOWN && (
            <details>
              <summary className="board-more">All {model.board.gates.length} gates</summary>
              <ul className="board-gate-rows">{model.board.gates.slice(GATES_SHOWN).map(gate)}</ul>
            </details>
          )}
        </section>
      )}
      {groups.map(([title, actors, count]) => {
        const rows = model.status.entries.filter((row) => actors.includes(row.actor));
        if (rows.length === 0) return null;
        return (
          <section key={title} aria-label={title} className="board-group">
            <h3>
              {title} ({count})
            </h3>
            <ul className="board-rows">
              {rows.map((row) => {
                const at = nodeOfEntry(model, row.entryId);
                const key = at === undefined ? undefined : model.graph.nodes[at]!.key;
                return (
                  <li key={row.entryId}>
                    <button
                      type="button"
                      className="board-row"
                      aria-expanded={at !== undefined && at === index}
                      disabled={key === undefined}
                      onClick={() => key && toggle(key)}
                    >
                      <span>
                        <code>{row.sourceId}</code>
                        {row.scope === 'item' ? '' : ` · ${row.scope}`}
                      </span>
                      <span className="board-state">{ENTRY_STATE_LABELS[row.state]}</span>
                      {row.waitsOn && <span className="board-row-wait">{row.waitsOn.reason}</span>}
                    </button>
                    {detail(at)}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
