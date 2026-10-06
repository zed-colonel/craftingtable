import type { AttentionItemView } from '@craftingtable/contracts';
import type { SourceRepositoryId, WorkCycle, WorkItemId } from '@craftingtable/domain';
import { DiffView } from '../../features/execution/DiffView.js';
import { PlanBranchPanel } from '../../features/execution/PlanBranchPanel.js';
import {
  CycleControls,
  DelegationControls,
  ScopeControls,
  useWorkItem,
} from '../../features/execution/WorkItemControls.js';
import { WorkItemPage } from '../../features/planning/WorkItemPage.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { createWorktree } from '../../lib/execution-api.js';
import { isLiveStatus } from '../../lib/execution-labels.js';
import { admitWorkItem, completeWorkItem, removeFromAgenda } from '../../lib/planning-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { useCommands } from '../commands.js';
import { RefreshFailed } from '../RefreshFailed.js';
import { useGo, useSession, useWorkspaceScope } from '../session.js';

/** One work item: its plan entry, branches, automation, delegation and execution slices. */
export function WorkItemRoute({
  workItemId,
  attention,
  cycles,
  workspaceCyclesFailed,
}: {
  workItemId: WorkItemId;
  attention: readonly AttentionItemView[];
  cycles: readonly WorkCycle[];
  /** The shell already says the workspace's cycles could not be read. */
  workspaceCyclesFailed: boolean;
}) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const store = useQueryStore();
  const go = useGo();
  const item = useWorkItem(workItemId);
  // Admission, completion and agenda removal also change the workspace's summaries and agenda.
  const lifecycle = useCommands(() =>
    store.refreshNow([
      queryKeys.workItem(workspaceId, workItemId),
      queryKeys.snapshot(workspaceId),
      ['agenda', workspaceId],
      queryKeys.cycles(workspaceId),
    ]),
  );
  const { detail, execution, diff } = item;
  if (detail === undefined) return <RefreshFailed failed={item.refreshFailed} />;
  const inProgress =
    execution !== undefined &&
    (execution.worktrees.some((worktree) => worktree.status === 'active') ||
      execution.runs.some((entry) => isLiveStatus(entry.status)));
  const diffShown =
    diff !== undefined && execution?.worktrees.some((worktree) => worktree.id === diff.worktree.id);
  const version = detail.agendaRemoval?.expectedVersion;
  return (
    <div className="page">
      <RefreshFailed failed={item.refreshFailed} />
      {item.cyclesFailed && !workspaceCyclesFailed && (
        <p className="warning-state" role="alert">
          Cycle status could not be loaded. Refresh before controlling automation.
        </p>
      )}
      <WorkItemPage
        detail={detail}
        inProgress={inProgress}
        sections={[
          { id: 'overview', label: 'Overview' },
          { id: 'branches', label: 'Branches' },
          ...(execution !== undefined
            ? [
                { id: 'automation', label: 'Automation' },
                { id: 'delegation', label: 'Delegation', count: execution.runs.length },
              ]
            : []),
          ...(diffShown ? [{ id: 'diff', label: 'Diff' }] : []),
        ]}
        onAdmit={() =>
          lifecycle.run(() => admitWorkItem(workspaceId, workItemId, csrfToken), 'Admission failed')
        }
        onRemoveFromAgenda={() => {
          if (version !== undefined)
            lifecycle.run(
              () => removeFromAgenda(workspaceId, workItemId, version, csrfToken),
              'Agenda removal failed',
            );
        }}
        onComplete={() =>
          lifecycle.run(
            () => completeWorkItem(workspaceId, workItemId, csrfToken),
            'Completion failed',
          )
        }
        onOpenProject={() =>
          go({ name: 'project', workspaceId, projectId: detail.workItem.projectId })
        }
        busy={lifecycle.busy}
        canMutate={canMutate}
        {...(lifecycle.error === undefined ? {} : { error: lifecycle.error })}
      />
      <PlanBranchPanel
        key={detail.workItem.planVersionId}
        workspaceId={workspaceId}
        planVersionId={detail.workItem.planVersionId}
        csrfToken={csrfToken}
        editable={false}
        repositories={item.repositories}
        onChanged={item.refresh}
        collapsible
        defaultOpen={!inProgress && detail.workItem.status !== 'completed'}
        {...(canMutate &&
        detail.workItem.status !== 'completed' &&
        !execution?.worktrees.some((t) => t.executionScope)
          ? {
              onCreateWorktree: (repositoryId: SourceRepositoryId) =>
                item.commands.run(() =>
                  createWorktree(workspaceId, workItemId, { repositoryId }, csrfToken),
                ),
            }
          : {})}
        creating={item.commands.busy}
        onOpenSettings={() =>
          go({
            name: 'plan-version',
            workspaceId,
            projectId: detail.workItem.projectId,
            planVersionId: detail.workItem.planVersionId,
          })
        }
      />
      <CycleControls item={item} attention={attention} />
      <DelegationControls item={item} attention={attention} workspaceCycles={cycles} />
      <ScopeControls item={item} attention={attention} />
      {diffShown && (
        <div id="diff">
          <DiffView diff={diff} onClose={() => item.setDiff(undefined)} />
        </div>
      )}
    </div>
  );
}
