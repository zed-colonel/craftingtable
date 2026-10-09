import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import {
  type CycleView,
  type ExecutionScope,
  PHASE_BLOCKERS,
  phaseBlockerCode,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { MilestoneChip } from '../../components/MilestoneChip.js';
import {
  type Reason,
  RESOLVER_LABELS,
  RESOLVER_ORDER,
  resolverOf,
} from '../../components/Reasons.js';
import { Link } from '../../lib/navigation.js';

/**
 * The work item's slices at a glance, at the top of its page (R-E4): per slice, the board's
 * milestone chips (R-E3b), who acts on its next phase and the first thing that phase waits on,
 * linking to the slice's requirements and controls below. Everything shown is the daemon's: the
 * slice's status and its phases' typed blockers, grouped by the rule the requirements use
 * (`Reasons`). It posts nothing.
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

/** Who acts next on a slice, and the first thing its next phase waits on. */
function headline(
  choice: ExecutionScopeChoice,
  cycles: readonly CycleView[],
): {
  readonly actor: 'operator' | 'agent' | 'controller' | 'done';
  readonly label: string;
  readonly wait?: string;
} {
  const next = nextPhaseOf(choice);
  if (next === undefined) return { actor: 'done', label: 'Done' };
  if (
    cycles.some(
      (view) =>
        choice.worktreeIds.includes(view.cycle.worktreeId) && view.cycle.status === 'running',
    )
  )
    return { actor: 'agent', label: 'Agent at work' };
  const reasons: Reason[] = (choice.phases.find((p) => p.phase === next)?.blockers ?? []).map(
    (b) => ({
      kind: b.kind,
      text: b.message,
      owner: PHASE_BLOCKERS[phaseBlockerCode(b)].owner,
    }),
  );
  for (const resolver of RESOLVER_ORDER) {
    const first = reasons.find((reason) => resolverOf(reason) === resolver);
    if (first)
      return {
        actor: resolver === 'you' ? 'operator' : 'controller',
        label: RESOLVER_LABELS[resolver],
        wait: first.text,
      };
  }
  return { actor: 'controller', label: 'Nothing waiting' };
}

export function SliceStrip({
  workspaceId,
  workItemId,
  choices,
  cycles,
}: {
  workspaceId: WorkspaceId;
  workItemId: WorkItemId;
  /** The item's slices and parent acceptance, read with its page region (R-D5). */
  choices: readonly ExecutionScopeChoice[];
  /** The item's cycles, to name an agent at work on a slice. */
  cycles: readonly CycleView[];
}) {
  if (choices.length === 0) return null;
  return (
    <section aria-label="Slices" className="slice-strip">
      <ul className="board-slices">
        {choices.map((choice) => {
          const head = headline(choice, cycles);
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
              <span className={`board-state board-actor-${head.actor}`}>{head.label}</span>
              {head.wait !== undefined && <span className="slice-strip-wait">{head.wait}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
