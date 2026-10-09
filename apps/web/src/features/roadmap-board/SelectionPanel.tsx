import { asAgentRunId, type WorkItemId, type WorkspaceId } from '@craftingtable/domain';
import type { MouseEvent, Ref } from 'react';
import { Link } from '../../lib/navigation.js';
import type { Route } from '../../lib/route.js';
import { ENTRY_STATE_LABELS as STATE_LABELS } from '../planning/roadmap-labels.js';
import {
  type BoardModel,
  nodeAt,
  nodeLabel,
  rowsOf,
  type StatusRow,
  workItemOf,
} from './board-model.js';

export const ACTOR_LABELS: Record<StatusRow['actor'], string> = {
  operator: 'Needs you',
  agent: 'Agent at work',
  controller: 'Waiting',
  none: 'No one',
};

/** Long lists open on request. */
const SHOWN = 8;

export interface BoardLinks {
  readonly workspaceId: WorkspaceId;
  readonly roadmapId: string;
  readonly onOpenWorkItem: (id: WorkItemId) => void;
  readonly onOpenAttention?: (itemId: string) => void;
}

/** A link to an inbox item, opened in place when the page can. */
export function InboxLink({ links, itemId }: { links: BoardLinks; itemId: string }) {
  return (
    <Link
      className="text-button"
      route={{ name: 'inbox', workspaceId: links.workspaceId, itemId }}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!links.onOpenAttention) return;
        event.preventDefault();
        links.onOpenAttention(itemId);
      }}
    >
      Open in Needs you
    </Link>
  );
}

/** Where a checkpoint is settled on the roadmap's setup, chosen by its kind. */
function setupRoute(links: BoardLinks, checkpointKind: string | undefined): [Route, string] {
  const [part, label] =
    checkpointKind === 'architecture_decision'
      ? ['decisions', 'Open its decision in setup']
      : checkpointKind === 'plan_approval'
        ? ['plan-acceptance', 'Open plan acceptance in setup']
        : ['evidence', 'Open its evidence in setup'];
  return [
    {
      name: 'roadmap',
      workspaceId: links.workspaceId,
      roadmapId: links.roadmapId,
      tab: 'setup',
      focus: `runtime-evidence-roadmap-${links.roadmapId}-${part}`,
    },
    label,
  ];
}

/** One open entry's state and the daemon's wait, verbatim, with its links. */
export function EntryWait({ row, links }: { row: StatusRow; links: BoardLinks }) {
  const waits = row.waitsOn;
  return (
    <li className="board-entry">
      <div className="board-entry-state">
        <code>{row.sourceId}</code>
        {row.scope === 'item' ? '' : ` · ${row.scope}`}
        <span className={`board-state board-actor-${row.actor}`}>
          {STATE_LABELS[row.state]} · {ACTOR_LABELS[row.actor]}
        </span>
      </div>
      {waits && <div className="board-wait">{waits.reason}</div>}
      <div className="inline-links">
        {waits?.attentionItemId && <InboxLink links={links} itemId={waits.attentionItemId} />}
        {waits?.runId && (
          <Link
            className="text-button"
            route={{
              name: 'run',
              workspaceId: links.workspaceId,
              runId: asAgentRunId(waits.runId),
            }}
          >
            Open run
          </Link>
        )}
      </div>
    </li>
  );
}

/** A node named as an in-page link: selecting it moves the panel to it. */
export function NodeButton({
  model,
  index,
  onSelect,
}: {
  model: BoardModel;
  index: number;
  onSelect: (key: string) => void;
}) {
  const node = nodeAt(model, index);
  return (
    <button type="button" className="board-node-link" onClick={() => onSelect(node.key)}>
      <code>{node.sourceId}</code> <span className="subtle">{nodeLabel(node)}</span>
    </button>
  );
}

function NodeList({
  model,
  nodes,
  onSelect,
}: {
  model: BoardModel;
  nodes: readonly number[];
  onSelect: (key: string) => void;
}) {
  const item = (i: number) => (
    <li key={i}>
      <NodeButton model={model} index={i} onSelect={onSelect} />
    </li>
  );
  return (
    <>
      <ul className="board-node-list">{nodes.slice(0, SHOWN).map(item)}</ul>
      {nodes.length > SHOWN && (
        <details>
          <summary>{nodes.length - SHOWN} more</summary>
          <ul className="board-node-list">{nodes.slice(SHOWN).map(item)}</ul>
        </details>
      )}
    </>
  );
}

/**
 * What the selected node waits on and what it unblocks (R-E3b): the daemon's wait verbatim for
 * each open entry, the root blockers selectable in place, the direct requirements in a
 * disclosure, the slices it unblocks, and links. It posts nothing.
 */
export function SelectionContent({
  model,
  index,
  links,
  onSelect,
  headingRef,
  headingLevel = 3,
}: {
  model: BoardModel;
  index: number;
  links: BoardLinks;
  onSelect: (key: string) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  headingLevel?: 3 | 4;
}) {
  const node = nodeAt(model, index);
  const state = model.board.nodes[index];
  const rows = rowsOf(model, index);
  const workItemId = workItemOf(model, index);
  const roots = state?.roots ?? [];
  const unmet = state?.unmet ?? [];
  const unblocks = state?.unblocks ?? [];
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const [setup, setupLabel] = setupRoute(links, node.checkpointKind);
  return (
    <>
      <Heading ref={headingRef} tabIndex={-1} className="board-panel-title">
        <code>{node.sourceId}</code> {node.title}
      </Heading>
      <p className="subtle">
        {nodeLabel(node)} · {state?.satisfied ? 'Met' : 'Not met'}
        {node.included ? '' : ' · Not selected by this roadmap'}
      </p>
      {rows.length > 0 && (
        <section aria-label="Waiting on" className="board-panel-part">
          <h5>Waiting on</h5>
          <ul className="board-entries">
            {rows.map((row) => (
              <EntryWait key={row.entryId} row={row} links={links} />
            ))}
          </ul>
        </section>
      )}
      {!state?.satisfied && (
        <section aria-label="Root blockers" className="board-panel-part">
          <h5>Root blockers ({roots.length})</h5>
          {roots.length ? (
            <NodeList model={model} nodes={roots} onSelect={onSelect} />
          ) : (
            <p className="subtle">Nothing upstream is unmet.</p>
          )}
          {unmet.length > 0 && (
            <details>
              <summary>Direct requirements not met ({unmet.length})</summary>
              <NodeList model={model} nodes={unmet} onSelect={onSelect} />
            </details>
          )}
        </section>
      )}
      {unblocks.length > 0 && (
        <section aria-label="Unblocks" className="board-panel-part">
          <h5>Unblocks {unblocks.length} slices</h5>
          <NodeList model={model} nodes={unblocks} onSelect={onSelect} />
        </section>
      )}
      <div className="inline-links">
        {state?.attentionItemId && <InboxLink links={links} itemId={state.attentionItemId} />}
        {node.kind === 'checkpoint' && !state?.satisfied && (
          <Link className="text-button" route={setup}>
            {setupLabel}
          </Link>
        )}
        {workItemId && (
          <Link
            className="text-button"
            route={{
              name: 'work-item',
              workspaceId: links.workspaceId,
              workItemId: workItemId as WorkItemId,
            }}
            onClick={(event) => {
              event.preventDefault();
              links.onOpenWorkItem(workItemId as WorkItemId);
            }}
          >
            Open work item
          </Link>
        )}
      </div>
    </>
  );
}
