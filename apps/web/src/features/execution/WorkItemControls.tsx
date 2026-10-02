import type { AttentionItemView, WorktreeDiffResponse } from '@craftingtable/contracts';
import type { WorkCycle, WorkItemId, WorktreeId } from '@craftingtable/domain';
import { useCallback, useState } from 'react';
import { useCommands } from '../../app/commands.js';
import {
  useExecutionStatus,
  useRepositories,
  useRunProfiles,
  useWorkItemCycles,
  useWorkItemDetail,
  useWorkItemExecution,
} from '../../app/reads.js';
import {
  useAlive,
  useCycleFocus,
  useGo,
  useSession,
  useWorkspaceScope,
} from '../../app/session.js';
import { decisionsFor } from '../../decisions/registry.js';
import { ApiError } from '../../lib/api-client.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import {
  createWorktree,
  loadWorktreeDiff,
  removeWorktree,
  startRun,
} from '../../lib/execution-api.js';
import { useQueryStore } from '../../lib/query-store.js';
import { startWorkCycle } from '../../lib/work-cycle-api.js';
import { CyclePanel } from './CyclePanel.js';
import { DelegationPanel, type LaunchInput } from './DelegationPanel.js';
import { ExecutionScopesPanel } from './ExecutionScopesPanel.js';
import { type WorktreeChangesRefused, worktreeChangesRefused } from './WorktreeChangesRefusal.js';
import { WorktreeBranchPanel } from './WorktreeBranchPanel.js';

/**
 * One work item's reads and commands, shared by its page and its inbox items (R-D4 increment
 * 4b). A command refreshes the item's own keys, the workspace's cycles and attention; events
 * refresh the rest.
 */
export function useWorkItem(workItemId: WorkItemId | undefined) {
  const { workspaceId } = useWorkspaceScope();
  const store = useQueryStore();
  const alive = useAlive();
  const detail = useWorkItemDetail(workspaceId, workItemId);
  const execution = useWorkItemExecution(workspaceId, workItemId);
  const cycles = useWorkItemCycles(workspaceId, workItemId);
  const repositories = useRepositories(workspaceId);
  const status = useExecutionStatus();
  const profiles = useRunProfiles(workspaceId);
  const refresh = useCallback(
    () =>
      store.refreshNow([
        ...(workItemId === undefined ? [] : [queryKeys.workItem(workspaceId, workItemId)]),
        queryKeys.cycles(workspaceId),
        queryKeys.attention(workspaceId),
      ]),
    [store, workspaceId, workItemId],
  );
  const commands = useCommands(refresh);
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  const [removalRefused, setRemovalRefused] = useState<
    WorktreeChangesRefused & { readonly worktreeId: WorktreeId }
  >();
  const loadDiff = (worktreeId: WorktreeId): void => {
    commands.setError(undefined);
    void loadWorktreeDiff(workspaceId, worktreeId)
      .then((response) => {
        if (alive()) setDiff(response);
      })
      .catch((error: unknown) => {
        if (alive())
          commands.setError(
            error instanceof ApiError ? error.message : 'The diff could not be loaded',
          );
      });
  };
  /** After a merge or a cleanup retry: the merged worktree's diff closes and the item reloads. */
  const merged = (worktreeId: WorktreeId): void => {
    setDiff((current) => (current?.worktree.id === worktreeId ? undefined : current));
    refresh();
  };
  const own = <T extends { readonly workItemId?: unknown }>(value: T | undefined) =>
    value !== undefined && value.workItemId === workItemId ? value : undefined;
  return {
    workItemId,
    detail: detail.data?.workItem.id === workItemId ? detail.data : undefined,
    execution: own(execution.data),
    cycles: cycles.data?.cycles,
    cyclesFailed: cycles.error !== undefined,
    /** A read failed; whatever was read last stays visible. */
    refreshFailed: detail.error !== undefined || execution.error !== undefined,
    repositories: repositories.data?.repositories ?? [],
    backends: status.data?.backends ?? [],
    profiles: profiles.data?.profiles,
    refresh,
    commands,
    diff,
    setDiff,
    loadDiff,
    merged,
    removalRefused,
    setRemovalRefused,
  };
}
export type WorkItemState = ReturnType<typeof useWorkItem>;

/** The work item's automated cycle controls: its page and its inbox items host them (R-A5). */
export function CycleControls({
  item,
  worktreeId,
  attention,
  inInbox = false,
}: {
  item: WorkItemState;
  /** The worktree whose cycle to show: an inbox item's own, else the page's selection. */
  worktreeId?: WorktreeId;
  attention: readonly AttentionItemView[];
  /** In the inbox the item's own decision renders; elsewhere a stop links to its item. */
  inInbox?: boolean;
}) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const focus = useCycleFocus();
  const go = useGo();
  const { detail, execution, cycles } = item;
  if (!detail || !execution || cycles === undefined) return null;
  const selected = worktreeId ?? focus.worktreeId;
  return (
    <CyclePanel
      key={worktreeId === undefined ? detail.workItem.id : `${detail.workItem.id}:${worktreeId}`}
      {...(selected ? { selectedWorktreeId: selected } : {})}
      onSelectWorktree={focus.focus}
      cycles={cycles}
      worktrees={execution.worktrees}
      runs={execution.runs}
      backends={item.backends}
      profiles={item.profiles ?? []}
      canMutate={canMutate}
      busy={item.commands.busy}
      admitted={detail.workItem.status === 'admitted'}
      onStart={(input) =>
        item.commands.run(() => startWorkCycle(workspaceId, detail.workItem.id, input, csrfToken))
      }
      csrfToken={csrfToken}
      onChanged={item.refresh}
      {...(inInbox
        ? {}
        : {
            decisionItemFor: (cycleId: string) =>
              attention.find((entry) => entry.subjectKey === `cycle:${cycleId}`)?.id,
          })}
      onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
    />
  );
}

/** The work item's worktrees, runs and merges. */
export function DelegationControls({
  item,
  attention,
  workspaceCycles,
}: {
  item: WorkItemState;
  attention: readonly AttentionItemView[];
  /** The workspace's open cycles: delegation hides its manual controls while one runs. */
  workspaceCycles: readonly WorkCycle[];
}) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const go = useGo();
  const alive = useAlive();
  const { detail, execution, commands } = item;
  if (!detail || !execution) return null;
  const workItemId = detail.workItem.id;
  const removeTree = (worktreeId: WorktreeId, input: { readonly discardChanges?: true } = {}) =>
    commands.run(async () => {
      item.setRemovalRefused(undefined);
      try {
        await removeWorktree(workspaceId, worktreeId, csrfToken, input);
      } catch (error) {
        const refused = worktreeChangesRefused(error);
        if (refused !== undefined) item.setRemovalRefused({ ...refused, worktreeId });
        throw error;
      }
      item.setDiff((current) => (current?.worktree.id === worktreeId ? undefined : current));
    });
  return (
    <DelegationPanel
      repositories={item.repositories}
      hideCreateWorktree
      automationActive={workspaceCycles.some(
        (cycle) =>
          cycle.workItemId === workItemId && !['stopped', 'completed'].includes(cycle.status),
      )}
      renderBranchControls={(worktree) => (
        <WorktreeBranchPanel
          key={worktree.id}
          workspaceId={workspaceId}
          worktree={worktree}
          csrfToken={csrfToken}
          canMutate={canMutate}
          onChanged={item.refresh}
        />
      )}
      worktrees={execution.worktrees}
      runs={execution.runs}
      mergeGates={execution.mergeGates}
      backends={item.backends}
      itemCompleted={detail.workItem.status === 'completed'}
      canMutate={canMutate}
      busy={commands.busy}
      {...(commands.error === undefined ? {} : { error: commands.error })}
      onCreateWorktree={(repositoryId) =>
        commands.run(() => createWorktree(workspaceId, workItemId, { repositoryId }, csrfToken))
      }
      onRemoveWorktree={removeTree}
      {...(item.removalRefused === undefined ? {} : { removalRefused: item.removalRefused })}
      onKeepWorktree={() => {
        item.setRemovalRefused(undefined);
        commands.setError(undefined);
      }}
      workspaceId={workspaceId}
      csrfToken={csrfToken}
      onMerged={item.merged}
      decisionItemFor={(worktreeId) =>
        attention.find(
          (entry) =>
            entry.refs.worktreeId === worktreeId &&
            decisionsFor(entry).some((decision) => decision.kind === 'merge'),
        )?.id
      }
      onLaunch={(input: LaunchInput) =>
        commands.run(async () => {
          const response = await startRun(workspaceId, workItemId, input, csrfToken);
          if (alive()) go({ name: 'run', workspaceId, runId: response.run.id });
        })
      }
      {...(item.profiles === undefined ? {} : { profiles: item.profiles })}
      onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
      onOpenDiff={item.loadDiff}
    />
  );
}

/** The work item's execution slices: phase requirements and scope evidence. */
export function ScopeControls({
  item,
  attention,
  inInbox = false,
}: {
  item: WorkItemState;
  attention: readonly AttentionItemView[];
  /** In the inbox the item's own decision renders; elsewhere a merge links to its item. */
  inInbox?: boolean;
}) {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const focus = useCycleFocus();
  const { detail } = item;
  if (!detail) return null;
  return (
    <ExecutionScopesPanel
      key={`scopes-${workspaceId}-${detail.workItem.id}`}
      cycles={item.cycles ?? []}
      onOpenCycle={(id) => {
        focus.focus(id);
        const element = document.getElementById('automation');
        element?.scrollIntoView({ block: 'start' });
        if (element) {
          element.tabIndex = -1;
          element.focus({ preventScroll: true });
        }
      }}
      workspaceId={workspaceId}
      workItemId={detail.workItem.id}
      worktrees={item.execution?.worktrees ?? []}
      csrfToken={csrfToken}
      canMutate={canMutate}
      itemStatus={detail.workItem.status}
      onChanged={item.refresh}
      {...(inInbox
        ? {}
        : {
            decisionItemFor: (id: string) =>
              attention.find(
                (entry) =>
                  entry.refs.worktreeId === id &&
                  decisionsFor(entry).some((d) => d.kind === 'checkpoint-preparation'),
              )?.id,
          })}
    />
  );
}
