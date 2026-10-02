import type { CrossProjectView } from '@craftingtable/contracts';
import type { WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { memo } from 'react';
import { ActionBar } from '../../components/ActionBar.js';
import { distinct } from '../../lib/distinct.js';
import { Link } from '../../lib/navigation.js';
import { revealElement } from '../../lib/reveal-element.js';
import { phaseLabel } from './DependencyRequirements.js';

/**
 * One milestone of a cross-project map (R-D4 increment 4c, PERF-10). Memoized: a node whose own
 * data did not change is not rendered again when the map is read again; `onTrace` must be stable.
 */
export const MapNodeCard = memo(function MapNodeCard({
  node,
  prioritized,
  workspaceId,
  panelKey,
  runtimePanelId,
  onTrace,
}: {
  node: CrossProjectView['nodes'][number];
  /** The selection prioritizes the full map, so a target's priority is named. */
  prioritized: boolean;
  workspaceId: WorkspaceId;
  panelKey: string;
  runtimePanelId: string;
  onTrace: (key: string) => void;
}) {
  return (
    <article className="cross-map-node">
      <p>
        <strong>
          {node.sourceId} · required state: {node.state}
        </strong>
        <br />
        {node.title}
      </p>
      <p>{phaseLabel(node)}</p>
      <p>
        {node.status}
        {node.priority && prioritized ? ' · Target priority' : ''}
      </p>
      {node.decisionCoverage?.map((coverage) => (
        <p key={coverage.submissionId}>
          {coverage.checkpoint}: approved early clauses satisfy this slice’s {coverage.phase} gate.
          Full ADR obligations remain with later work.{' '}
          <button
            type="button"
            onClick={() => revealElement(`${runtimePanelId}-submission-${coverage.submissionId}`)}
          >
            Review clause approval
          </button>
        </p>
      ))}
      {node.originalRequirements && (
        <details>
          <summary>Original imported prerequisites · preserved for audit</summary>
          <ul>
            {distinct(node.originalRequirements).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <ActionBar label="Milestone actions">
        <button type="button" className="secondary-button" onClick={() => onTrace(node.key)}>
          Trace requirements
        </button>
        {node.workItemId && (
          <Link
            route={{ name: 'work-item', workspaceId, workItemId: node.workItemId as WorkItemId }}
          >
            Open work item / advance scope
          </Link>
        )}
        {node.action === 'evidence' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => revealElement(`${runtimePanelId}-evidence`)}
          >
            Submit or review checkpoint evidence
          </button>
        )}
        {node.action === 'adopt' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => revealElement(`map-adoption-${panelKey}`)}
          >
            Review scheduling proposals
          </button>
        )}
      </ActionBar>
      {node.blockers.length > 0 && (
        <details>
          <summary>{node.blockers.length} waiting requirements</summary>
          <ul>
            {distinct(node.blockers).map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
});
