import { RunsPage } from '../../features/execution/RunsPage.js';
import { AgendaPage } from '../../features/planning/AgendaPage.js';
import type { AgendaFilter } from '../../lib/route.js';
import { useAgenda, useRuns } from '../reads.js';
import { useGo, useWorkspaceScope } from '../session.js';

/** The workspace's recent runs. */
export function RunsRoute() {
  const { workspaceId } = useWorkspaceScope();
  const go = useGo();
  const recent = useRuns(workspaceId, 'recent').data;
  return (
    <RunsPage
      runs={recent?.runs ?? []}
      liveCount={recent?.liveCount ?? 0}
      onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
      onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
    />
  );
}

/** The agenda under one filter. */
export function AgendaRoute({ filter }: { filter: AgendaFilter }) {
  const { workspaceId } = useWorkspaceScope();
  const go = useGo();
  const listing = useAgenda(workspaceId, filter).data;
  return (
    <AgendaPage
      filter={filter}
      {...(listing === undefined ? {} : { listing })}
      onSelectFilter={(next) => go({ name: 'agenda', workspaceId, filter: next })}
      onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
      onOpenProject={(projectId) => go({ name: 'project', workspaceId, projectId })}
    />
  );
}
