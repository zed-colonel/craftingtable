import {
  effectiveRoadmapAttention,
  phaseBlockerCode,
  type Roadmap,
  type RoadmapEntryProgress,
  SETUP_BLOCKER_CODES,
  type WorkspaceId,
} from '@craftingtable/domain';
import { revealElement } from '../../lib/reveal-element.js';
import { buildPath } from '../../lib/route.js';
export function roadmapStatusLabel(roadmap: Roadmap, fallback: string) {
  return effectiveRoadmapAttention(roadmap)?.code === 'restart-resume'
    ? 'Resume required after restart'
    : fallback;
}
export function RoadmapAttention({
  roadmap,
  progress,
  workspaceId,
}: {
  roadmap: Roadmap;
  progress: readonly RoadmapEntryProgress[];
  workspaceId: WorkspaceId;
}) {
  const recovery = progress.filter(
    (p) =>
      ['needs-attention', 'awaiting-merge', 'paused'].includes(p.status) && !p.blockers?.length,
  );
  const setup = progress.filter(
    (p) =>
      p.blockers?.length && p.blockers.every((b) => SETUP_BLOCKER_CODES.has(phaseBlockerCode(b))),
  );
  const restart = effectiveRoadmapAttention(roadmap)?.code === 'restart-resume';
  return (
    <section aria-label="Next roadmap actions" className="roadmap-next-actions">
      <h4>Next roadmap actions</h4>
      <p role="status">
        <strong>Scheduler: </strong>
        <span>
          {restart
            ? 'Stopped after the daemon restart. Your plan acceptance does not resume scheduling. Use Resume roadmap when ready.'
            : roadmap.reason}
        </span>
      </p>
      {recovery.length > 0 && (
        <>
          <p>
            <strong>
              {recovery.length} work {recovery.length === 1 ? 'step needs' : 'steps need'} a
              separate decision.
            </strong>{' '}
            Resuming scheduling does not add remediation attempts or resolve these checkpoints.
          </p>
          <ul>
            {recovery.map((p) => {
              const e = roadmap.definition.entries.find((e) => e.id === p.entryId);
              return (
                e && (
                  <li key={p.entryId}>
                    <p>
                      <strong>{e.executionScope?.sourceId ?? e.sourceId}</strong>: {p.reason}
                    </p>
                    <a
                      href={buildPath({ name: 'work-item', workspaceId, workItemId: e.workItemId })}
                    >
                      Open work item recovery
                    </a>{' '}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => revealElement(`roadmap-entry-${roadmap.id}-${e.id}`)}
                    >
                      Show this roadmap step
                    </button>
                  </li>
                )
              );
            })}
          </ul>
        </>
      )}
      {setup.length > 0 && (
        <>
          <p>
            <strong>Verification setup still needed</strong> for otherwise eligible steps:
          </p>
          <ul>
            {setup.map((p) => {
              const e = roadmap.definition.entries.find((e) => e.id === p.entryId);
              return (
                <li key={p.entryId}>
                  <strong>{e?.executionScope?.sourceId ?? e?.sourceId}</strong>
                  {p.blockers?.map((b) => (
                    <p key={b.message}>{b.message}</p>
                  ))}
                  {p.blockers?.some((b) => b.kind === 'review') && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => revealElement(`map-reviewers-roadmap-${roadmap.id}`)}
                    >
                      Assign independent reviewer responsibilities
                    </button>
                  )}
                  {p.blockers?.some((b) => b.kind === 'authorization') && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => revealElement(`runtime-evidence-roadmap-${roadmap.id}-native`)}
                    >
                      Set up verification environment
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
