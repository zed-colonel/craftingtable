import type { AttentionItemView, RoadmapSummaries } from '@craftingtable/contracts';
import {
  DEFAULT_ROADMAP_SCHEDULING,
  type RoadmapStatus,
  type WorkspaceId,
} from '@craftingtable/domain';
import { useCallback, useState } from 'react';
import { About } from '../../components/About.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Section } from '../../components/Section.js';
import { StatusStrip } from '../../components/StatusStrip.js';
import { queryKeys } from '../../lib/event-invalidations.js';
import { useQuery } from '../../lib/query-store.js';
import { loadRoadmapSummaries } from '../../lib/roadmap-api.js';
import { ConcurrencyImports } from './ConcurrencyImports.js';
import { Link, useNavigation } from '../../lib/navigation.js';
import { ROADMAP_STATUS_LABELS as labels } from './roadmap-labels.js';
import { type Draft, RoadmapEditor } from './RoadmapEditor.js';

/** Finished roadmaps go under History on the list; the rest are active. */
const FINISHED: ReadonlySet<RoadmapStatus> = new Set(['completed', 'stopped']);

/**
 * The workspace's roadmaps. They reload when a round says they changed (roadmap, cycle,
 * evidence and merge events) and on the slow safety refresh, never on a fixed 3 s poll
 * (PERF-06). One read at a time; a round during a read is caught by the next. These are the
 * list page's light rows (R-D5): no definitions, no per-entry progress.
 */
function useRoadmapSummaries(workspaceId: WorkspaceId) {
  const query = useQuery(queryKeys.roadmapSummaries(workspaceId), () =>
    loadRoadmapSummaries(workspaceId),
  );
  const roadmaps: RoadmapSummaries['roadmaps'] = query.data?.roadmaps ?? [];
  const error =
    query.status === 'error'
      ? query.error instanceof Error
        ? query.error.message
        : 'Could not load roadmaps.'
      : undefined;
  return { roadmaps, loaded: query.data !== undefined, error };
}

/**
 * `/roadmaps`: every roadmap of the workspace, active first and finished ones under History,
 * and the imported concurrency maps (R-E2). Each roadmap has its own board, setup and history.
 */
export function RoadmapsPage({
  workspaceId,
  csrfToken,
  canMutate,
  attention = [],
}: {
  workspaceId: WorkspaceId;
  csrfToken: string;
  canMutate: boolean;
  /** The workspace's open attention items; each roadmap counts its own (R-A5). */
  attention?: readonly AttentionItemView[];
}) {
  const navigation = useNavigation();
  const { roadmaps, loaded, error } = useRoadmapSummaries(workspaceId);
  const [draft, setDraft] = useState<Draft>();
  const cancel = useCallback(() => setDraft(undefined), []);
  const active = roadmaps.filter((r) => !FINISHED.has(r.status));
  const finished = roadmaps.filter((r) => FINISHED.has(r.status));
  const row = (roadmap: RoadmapSummaries['roadmaps'][number]) => {
    const needsYou = attention.filter((item) => item.refs.roadmapId === roadmap.id).length;
    return (
      <li key={roadmap.id} className="roadmap-row">
        <Link route={{ name: 'roadmap', workspaceId, roadmapId: roadmap.id, tab: 'board' }}>
          {roadmap.name}
        </Link>
        <StatusStrip
          compact
          facts={[
            {
              label: 'Status',
              value:
                roadmap.attentionCode === 'restart-resume'
                  ? 'Resume required after restart'
                  : labels[roadmap.status],
            },
            {
              label: 'Completed',
              value: `${roadmap.completed}/${roadmap.entries}`,
              mono: true,
            },
            ...(needsYou > 0
              ? [{ label: 'Needs you', value: needsYou, accent: 'var(--color-attention)' }]
              : []),
          ]}
        />
        <p className="hint">{roadmap.reason}</p>
      </li>
    );
  };
  return (
    <div className="page">
      <PageHeader
        title="Roadmaps"
        subtitle="Delegated sequences of work items with their integration policy."
        actions={
          canMutate && !draft ? (
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                setDraft({
                  id: crypto.randomUUID(),
                  expectedVersion: 0,
                  name: '',
                  entries: [],
                  scheduling: DEFAULT_ROADMAP_SCHEDULING,
                })
              }
            >
              New roadmap
            </button>
          ) : undefined
        }
      />
      <p>
        <Link route={{ name: 'settings', workspaceId, focus: 'workspace-agent-profiles' }}>
          Workspace agent defaults
        </Link>{' '}
        · each roadmap's own agents are set in its setup.
      </p>
      <About label="About roadmaps">
        <p>
          One delegated roadmap per workspace. Sequential mode follows list order; parallel mode
          starts eligible items in priority order, subject to dependencies, capacity, and exclusion
          groups. The daemon creates each item's branch and worktree when eligible, runs its
          automated cycle, and waits for you to merge. Closing the browser leaves scheduling active.
          Restarting the daemon requires explicit resume.
        </p>
      </About>
      {error && (
        <p role="alert" className="error-state">
          {error}
        </p>
      )}
      {draft && (
        <RoadmapEditor
          workspaceId={workspaceId}
          csrfToken={csrfToken}
          draft={draft}
          setDraft={setDraft}
          current={undefined}
          onSaved={(view) => {
            setDraft(undefined);
            // A new roadmap opens on its own board, where it is started.
            if (view)
              navigation?.navigate({
                name: 'roadmap',
                workspaceId,
                roadmapId: view.roadmap.id,
                tab: 'board',
              });
          }}
          onCancel={cancel}
        />
      )}
      {!loaded && !error && <p className="empty-state">Loading roadmaps…</p>}
      {loaded && roadmaps.length === 0 && !draft && (
        <p className="empty-state">
          No roadmaps yet. Create a sequence from your imported work items.
        </p>
      )}
      {active.length > 0 && (
        <Section title="Active roadmaps" count={active.length}>
          <ul className="roadmap-list">{active.map(row)}</ul>
        </Section>
      )}
      {finished.length > 0 && (
        <Section
          title="Finished roadmaps"
          count={finished.length}
          summary="Completed and stopped roadmaps."
          collapsible
          defaultOpen={false}
        >
          <ul className="roadmap-list">{finished.map(row)}</ul>
        </Section>
      )}
      <ConcurrencyImports
        key={workspaceId}
        workspaceId={workspaceId}
        csrfToken={csrfToken}
        canMutate={canMutate}
      />
    </div>
  );
}
