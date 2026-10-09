import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import { asWorkItemId, asWorkspaceId, type CycleView } from '@craftingtable/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SliceStrip, sliceAnchor } from './SliceStrip.js';

/**
 * R-E4: the work item page opens with a strip of its slices, each with the board's milestone
 * chips (R-E3b), who acts next and the first thing it waits on, linking to the slice below.
 */

afterEach(cleanup);

const workspaceId = asWorkspaceId('workspace-1');
const workItemId = asWorkItemId('item-1');

function choice(
  sourceId: string,
  kind: 'slice' | 'parent-acceptance',
  status: ExecutionScopeChoice['status'],
  phases: ExecutionScopeChoice['phases'] = [],
  worktreeIds: string[] = [],
): ExecutionScopeChoice {
  return {
    scope: { kind, definitionId: 'map-1', bindingRevision: 1, sourceId },
    title: `${sourceId} title`,
    description: '',
    excludes: [],
    blockers: [],
    earlyDevelopment: false,
    earlyDevelopmentAuthorized: false,
    canAuthorizeEarlyDevelopment: false,
    phases,
    status,
    worktreeIds,
  } as ExecutionScopeChoice;
}

const phase = (
  name: 'start' | 'merge' | 'verify' | 'accept',
  blockers: { kind: string; code: string; message: string }[],
) => ({ phase: name, blockers, reservations: [], resources: [] }) as never;

function strip(choices: ExecutionScopeChoice[], cycles: CycleView[] = []) {
  render(
    <SliceStrip
      workspaceId={workspaceId}
      workItemId={workItemId}
      choices={choices}
      cycles={cycles}
    />,
  );
  return screen.getByRole('region', { name: 'Slices' });
}

it('draws each slice with its milestones met or not, from the daemon’s status', () => {
  const region = strip([
    choice('wi/WI-01/implementation', 'slice', 'merged'),
    choice('wi/WI-01', 'parent-acceptance', 'not-started'),
  ]);
  const rows = within(region).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  const slice = within(rows[0]!);
  expect(slice.getByText('✓ started').textContent).toContain('(met)');
  expect(slice.getByText('✓ merged').textContent).toContain('(met)');
  expect(slice.getByText('verified').textContent).toContain('(not met)');
  const parent = within(rows[1]!);
  expect(parent.getByText('Parent acceptance')).toBeDefined();
  expect(parent.getByText('accepted').textContent).toContain('(not met)');
});

it('says who acts on the next phase, with its first wait, as the slice’s requirements group it', () => {
  const region = strip([
    // Not started: its start phase waits on the operator (an operator-owned code) and other work.
    choice('wi/WI-01/implementation', 'slice', 'not-started', [
      phase('start', [
        { kind: 'dependency', code: 'predecessor-not-accepted', message: 'Start WI-00 first.' },
        { kind: 'evidence', code: 'upstream-pin-missing', message: 'wi must use an exact pin.' },
      ]),
      phase('merge', [{ kind: 'review', code: 'reviewer-assignment', message: 'A later phase.' }]),
    ]),
    // Started: its merge phase waits only on other work.
    choice('wi/WI-01/contract', 'slice', 'started', [
      phase('start', []),
      phase('merge', [
        { kind: 'dependency', code: 'slice-requirement', message: 'Merge WI-00 first.' },
      ]),
    ]),
    choice('wi/WI-01/docs', 'slice', 'verified'),
  ]);
  const [first, second, third] = within(region).getAllByRole('listitem');
  expect(within(first!).getByText('Needs you')).toBeDefined();
  expect(within(first!).getByText('wi must use an exact pin.')).toBeDefined();
  expect(within(first!).queryByText('A later phase.')).toBeNull();
  expect(within(second!).getByText('Waiting on other work')).toBeDefined();
  expect(within(second!).getByText('Merge WI-00 first.')).toBeDefined();
  expect(within(third!).getByText('Done')).toBeDefined();
});

it('names an agent at work while a cycle runs on the slice’s worktree', () => {
  const region = strip(
    [
      choice(
        'wi/WI-01/implementation',
        'slice',
        'started',
        [
          phase('merge', [
            { kind: 'review', code: 'reviewer-assignment', message: 'Needs a review.' },
          ]),
        ],
        ['tree-1'],
      ),
    ],
    [{ cycle: { id: 'cycle-1', worktreeId: 'tree-1', status: 'running' } } as never],
  );
  expect(within(region).getByText('Agent at work')).toBeDefined();
});

it('links each slice to its place on the page, and posts nothing', () => {
  const region = strip([choice('wi/WI-01/implementation', 'slice', 'not-started')]);
  const link = within(region).getByRole('link', { name: /implementation/ });
  expect(link.getAttribute('href')).toBe(
    `/workspaces/workspace-1/work-items/item-1#${encodeURIComponent(
      sliceAnchor({ kind: 'slice', sourceId: 'wi/WI-01/implementation' }),
    )}`,
  );
  expect(within(region).queryByRole('button')).toBeNull();
});

it('draws nothing for a work item without slices', () => {
  render(<SliceStrip workspaceId={workspaceId} workItemId={workItemId} choices={[]} cycles={[]} />);
  expect(screen.queryByRole('region', { name: 'Slices' })).toBeNull();
});
