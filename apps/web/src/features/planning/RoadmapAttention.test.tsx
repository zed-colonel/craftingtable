import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { asWorkspaceId, type Roadmap, type RoadmapEntryProgress } from '@craftingtable/domain';
import { RoadmapAttention, roadmapStatusLabel } from './RoadmapAttention.js';
afterEach(cleanup);
it('separates restart resumption from item recovery and hides future dependency waits', () => {
  const roadmap = {
    id: 'roadmap',
    status: 'needs-attention',
    reason: 'Daemon restarted. Inspect the current item and explicitly resume the roadmap.',
    definition: { entries: [{ id: 'exo', sourceId: 'EXO-01', workItemId: 'item' }] },
  } as unknown as Roadmap;
  const progress = [
    {
      entryId: 'exo',
      status: 'needs-attention',
      reason: 'Remediation limit reached; one major finding.',
    },
    {
      entryId: 'wi',
      status: 'needs-attention',
      reason: 'Reviewer missing',
      blockers: [{ kind: 'review', message: 'Assign repository-maintainer.' }],
    },
    {
      entryId: 'future',
      status: 'needs-attention',
      reason: 'Later work',
      blockers: [
        { kind: 'review', message: 'Future responsibility.' },
        { kind: 'dependency', message: 'WI-02 must merge.' },
      ],
    },
  ] as RoadmapEntryProgress[];
  render(
    <>
      <RoadmapAttention roadmap={roadmap} progress={progress} workspaceId={asWorkspaceId('ws')} />
      <details>
        <summary>Settings</summary>
        <div id="map-reviewers-roadmap-roadmap">Reviewer controls</div>
      </details>
    </>,
  );
  expect(roadmapStatusLabel(roadmap, 'Needs attention')).toBe('Resume required after restart');
  expect(screen.getByText(/Your plan acceptance does not resume scheduling/)).toBeTruthy();
  expect(screen.getByText(/Remediation limit reached/)).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Open work item recovery' }).getAttribute('href'),
  ).toContain('/work-items/item');
  expect(screen.queryByText('Future responsibility.')).toBeNull();
  expect(screen.getByText('1 work step needs a separate decision.')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Assign independent reviewer responsibilities' }),
  );
  expect(document.activeElement?.id).toBe('map-reviewers-roadmap-roadmap');
});
