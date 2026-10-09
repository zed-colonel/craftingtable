import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import type { ExecutionScope, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { MilestoneChip } from '../../components/MilestoneChip.js';
import { Link } from '../../lib/navigation.js';
import { ACTOR_LABELS } from '../roadmap-board/SelectionPanel.js';

/**
 * The work item's slices at a glance, at the top of its page (R-E4): per slice, the board's
 * milestone chips (R-E3b), who acts next and on what, linking to the slice's requirements and
 * controls below and to the inbox item when the operator has one. Everything shown is the
 * daemon's: the slice's status, and its `next` actor and wait, decided by the roadmap status
 * list's rule (R-E4 review M1), named in the board's words. It posts nothing.
 */

type Milestone = 'started' | 'merged' | 'verified' | 'accepted';
type Phase = ExecutionScopeChoice['phases'][number]['phase'];

/** How far each status has come; a milestone is met once the status reaches it. */
const REACHED: Readonly<Record<ExecutionScopeChoice['status'], number>> = {
  'not-started': 0,
  prepared: 0,
  started: 1,
  merged: 2,
  verified: 3,
  accepted: 4,
};
const MILESTONE_RANK: Readonly<Record<Milestone, number>> = {
  started: 1,
  merged: 2,
  verified: 3,
  accepted: 4,
};
/** The phase that reaches each milestone. */
const PHASE_OF: Readonly<Record<Milestone, Phase>> = {
  started: 'start',
  merged: 'merge',
  verified: 'verify',
  accepted: 'accept',
};

function milestonesOf(scope: ExecutionScope): readonly Milestone[] {
  return scope.kind === 'parent-acceptance' ? ['accepted'] : ['started', 'merged', 'verified'];
}

/** The phase that moves a slice on next: the one reaching its first unmet milestone. */
export function nextPhaseOf(choice: ExecutionScopeChoice): Phase | undefined {
  const next = milestonesOf(choice.scope).find((m) => REACHED[choice.status] < MILESTONE_RANK[m]);
  return next === undefined ? undefined : PHASE_OF[next];
}

/** The id of a slice's place on the page, which the strip and the slices section share. */
export function sliceAnchor(scope: Pick<ExecutionScope, 'kind' | 'sourceId'>): string {
  return `slice-${scope.kind}-${scope.sourceId}`;
}

function sliceName(scope: ExecutionScope): string {
  return scope.kind === 'parent-acceptance'
    ? 'Parent acceptance'
    : (scope.sourceId.split('/').at(-1) ?? scope.sourceId);
}

export function SliceStrip({
  workspaceId,
  workItemId,
  choices,
}: {
  workspaceId: WorkspaceId;
  workItemId: WorkItemId;
  /** The item's slices and parent acceptance, read with its page region (R-D5). */
  choices: readonly ExecutionScopeChoice[];
}) {
  if (choices.length === 0) return null;
  return (
    <section aria-label="Slices" className="slice-strip">
      <ul className="board-slices">
        {choices.map((choice) => {
          const next = choice.next;
          const actor = next?.actor ?? 'done';
          return (
            <li key={`${choice.scope.kind}:${choice.scope.sourceId}`} className="slice-strip-row">
              <Link
                className="slice-strip-name"
                route={{
                  name: 'work-item',
                  workspaceId,
                  workItemId,
                  focus: sliceAnchor(choice.scope),
                }}
                title={`${choice.scope.sourceId} · ${choice.title}`}
              >
                {sliceName(choice.scope)}
              </Link>
              <span className="board-slice-chips">
                {milestonesOf(choice.scope).map((m) => (
                  <MilestoneChip
                    key={m}
                    state={m}
                    met={REACHED[choice.status] >= MILESTONE_RANK[m]}
                  />
                ))}
              </span>
              <span className={`board-state board-actor-${actor}`}>
                {next ? ACTOR_LABELS[next.actor] : 'Done'}
              </span>
              {next && <span className="slice-strip-wait">{next.reason}</span>}
              {next?.attentionItemId && (
                <Link
                  className="slice-strip-item"
                  route={{ name: 'inbox', workspaceId, itemId: next.attentionItemId }}
                >
                  Open in Needs you
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
