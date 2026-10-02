import {
  CYCLE_STEPS,
  phaseBlockerCode,
  type RoadmapAttempt,
  type RoadmapAutomation,
  type RoadmapEntry,
  type RoadmapEntryProgress,
  type RoadmapStatus,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import { memo } from 'react';
import { StatusStrip } from '../../components/StatusStrip.js';
import { Link } from '../../lib/navigation.js';
import { revealElement } from '../../lib/reveal-element.js';
import { entryStatusLabel } from './roadmap-entry-status.js';
import { ReverifyItem } from './ReverifyItem.js';

export type EntryCommand = 'pause' | 'resume' | 'reverify';

/**
 * One roadmap entry's row (R-D4 increment 4c, PERF-10). It is memoized: an entry whose own data
 * did not change is not rendered again when the roadmap is read again, so its callbacks must be
 * stable (`useStableCallback`) and its other props plain values.
 */
export const RoadmapEntryRow = memo(function RoadmapEntryRow({
  entry,
  state,
  attempt,
  workspaceId,
  roadmapId,
  roadmapStatus,
  automation,
  parallel,
  canMutate,
  busy,
  setupInline,
  runtimePanelId,
  onOpenWorkItem,
  onCommand,
}: {
  entry: RoadmapEntry;
  state: RoadmapEntryProgress | undefined;
  attempt: RoadmapAttempt | undefined;
  workspaceId: WorkspaceId;
  roadmapId: string;
  roadmapStatus: RoadmapStatus;
  /** The roadmap's default automation, which the entry's own and its progress refine. */
  automation: RoadmapAutomation | undefined;
  parallel: boolean;
  canMutate: boolean;
  busy: boolean;
  /** The setup tab is shown on this page, so its elements are revealed in place. */
  setupInline: boolean;
  runtimePanelId: string;
  onOpenWorkItem: (workItemId: WorkItemId) => void;
  onCommand: (action: EntryCommand, entryId: string) => void;
}) {
  const revealSetup = (element: string, label: string) =>
    setupInline ? (
      <button type="button" className="secondary-button" onClick={() => revealElement(element)}>
        {label}
      </button>
    ) : (
      <Link
        className="secondary-button"
        route={{ name: 'roadmap', workspaceId, roadmapId, tab: 'setup', focus: element }}
      >
        {label}
      </Link>
    );
  const effective = state?.effectiveAutomation ?? entry.automation ?? automation;
  return (
    <li id={`roadmap-entry-${roadmapId}-${entry.id}`}>
      <Link
        route={{ name: 'work-item', workspaceId, workItemId: entry.workItemId }}
        onClick={(event) => {
          event.preventDefault();
          onOpenWorkItem(entry.workItemId);
        }}
      >
        {[entry.sourceId, entry.executionScope?.kind, entry.title]
          .filter((part) => part !== undefined && part !== '')
          .join(' · ')}
      </Link>
      <p>
        <strong>{entryStatusLabel(entry, state)}</strong> · <code>{entry.integrationBranch}</code>
      </p>
      <p className="hint">{state?.reason}</p>
      {entry.executionScope &&
        state?.blockers?.some((b) =>
          ['environment-approval', 'resource-unsupported'].includes(phaseBlockerCode(b)),
        ) &&
        revealSetup(`${runtimePanelId}-native`, 'Set up verification environment')}
      {entry.executionScope &&
        state?.blockers?.some((b) => b.kind === 'review') &&
        revealSetup(
          `map-reviewers-roadmap-${roadmapId}`,
          'Assign independent reviewer responsibilities',
        )}
      {entry.executionScope && entry.executionScope.kind !== 'slice' ? (
        <p className="hint">
          Independent review records scope evidence; it does not merge a branch.
        </p>
      ) : (
        <StatusStrip
          compact
          facts={[
            {
              label: 'Integration merge',
              value:
                effective?.integrationMerge === 'automatic'
                  ? 'Automatic when reviewed and ready'
                  : 'Your approval required',
            },
            {
              label: 'Conflicts',
              value:
                effective?.integrationConflicts === 'automatic'
                  ? 'Automatic delegation'
                  : 'Ask you',
            },
            ...(entry.exclusionGroups?.length
              ? [{ label: 'Exclusion groups', value: entry.exclusionGroups.join(', ') }]
              : []),
          ]}
        />
      )}
      {canMutate && roadmapStatus === 'running' && parallel && state?.status !== 'completed' && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            onCommand(
              ['paused', 'needs-attention'].includes(state?.status ?? '') ? 'resume' : 'pause',
              entry.id,
            )
          }
        >
          {['paused', 'needs-attention'].includes(state?.status ?? '')
            ? 'Resume item'
            : 'Pause item'}
        </button>
      )}
      <ReverifyItem
        reverifiable={!!state?.reverifiable}
        canMutate={canMutate}
        busy={busy}
        onReverify={() => onCommand('reverify', entry.id)}
      />
      <details>
        <summary>Bound plan and cycle settings</summary>
        <p className="hint">
          Plan version: <code>{entry.planVersionId}</code>
          {attempt && <> · Execution revision {attempt.definitionRevision}</>}
        </p>
        <ul>
          {CYCLE_STEPS.map((step) => (
            <li key={step}>
              {step}: {entry.profiles[step].backend} ·{' '}
              <code>{entry.profiles[step].model ?? 'Backend default'}</code> ·{' '}
              {entry.profiles[step].permissionMode}
            </li>
          ))}
        </ul>
        <p>
          Zero blocking, major, or minor findings; at most {entry.policy.maxNits} nits. Up to{' '}
          {entry.policy.maxRemediationRounds} remediation rounds, {entry.policy.maxRunMinutes}{' '}
          minutes per step.
        </p>
        {entry.instructions && <pre className="roadmap-instructions">{entry.instructions}</pre>}
      </details>
    </li>
  );
});
