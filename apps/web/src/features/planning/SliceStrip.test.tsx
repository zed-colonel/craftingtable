import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import { asWorkItemId, asWorkspaceId } from '@craftingtable/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SliceStrip, sliceAnchor } from './SliceStrip.js';

/**
 * R-E4: the work item page opens with a strip of its slices, each with the board's milestone
 * chips (R-E3b) and the daemon's next actor and wait (review M1), linking to the slice below.
 */

afterEach(cleanup);

const workspaceId = asWorkspaceId('workspace-1');
const workItemId = asWorkItemId('item-1');

function choice(
  sourceId: string,
  kind: 'slice' | 'parent-acceptance',
  status: ExecutionScopeChoice['status'],
  next?: ExecutionScopeChoice['next'],
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
    phases: [],
    status,
    ...(next ? { next } : {}),
    worktreeIds: [],
  } as ExecutionScopeChoice;
}

function strip(choices: ExecutionScopeChoice[]) {
  render(<SliceStrip workspaceId={workspaceId} workItemId={workItemId} choices={choices} />);
  return screen.getByRole('region', { name: 'Slices' });
}

it('draws each slice with its milestones met or not, from the daemon’s status', () => {
  const region = strip([
    choice('wi/WI-01/implementation', 'slice', 'merged', { actor: 'controller', reason: 'x' }),
    choice('wi/WI-01', 'parent-acceptance', 'not-started', { actor: 'controller', reason: 'y' }),
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

it('says who acts next and on what, as the daemon decided it, in the board’s words', () => {
  const region = strip([
    choice('wi/WI-01/implementation', 'slice', 'not-started', {
      actor: 'operator',
      reason: 'Approve LOCAL-ADR-01.',
      attentionItemId: 'item-7',
    }),
    choice('wi/WI-01/contract', 'slice', 'started', {
      actor: 'agent',
      reason: 'Implementing.',
      cycleId: 'cycle-1',
    }),
    choice('wi/WI-01/docs', 'slice', 'merged', { actor: 'controller', reason: 'Verify next.' }),
    choice('wi/WI-01/old', 'slice', 'verified'),
  ]);
  const [held, working, waiting, done] = within(region).getAllByRole('listitem');
  expect(within(held!).getByText('Needs you')).toBeDefined();
  expect(within(held!).getByText('Approve LOCAL-ADR-01.')).toBeDefined();
  expect(within(held!).getByRole('link', { name: 'Open in Needs you' }).getAttribute('href')).toBe(
    '/workspaces/workspace-1/inbox/item-7',
  );
  expect(within(working!).getByText('Agent at work')).toBeDefined();
  expect(within(working!).queryByRole('link', { name: 'Open in Needs you' })).toBeNull();
  expect(within(waiting!).getByText('Waiting')).toBeDefined();
  expect(within(waiting!).getByText('Verify next.')).toBeDefined();
  expect(within(done!).getByText('Done')).toBeDefined();
});

it('links each slice to its place on the page, and posts nothing', () => {
  const region = strip([
    choice('wi/WI-01/implementation', 'slice', 'not-started', { actor: 'controller', reason: 'z' }),
  ]);
  const link = within(region).getByRole('link', { name: /implementation/ });
  expect(link.getAttribute('href')).toBe(
    `/workspaces/workspace-1/work-items/item-1#${encodeURIComponent(
      sliceAnchor({ kind: 'slice', sourceId: 'wi/WI-01/implementation' }),
    )}`,
  );
  expect(within(region).queryByRole('button')).toBeNull();
});

it('draws nothing for a work item without slices', () => {
  render(<SliceStrip workspaceId={workspaceId} workItemId={workItemId} choices={[]} />);
  expect(screen.queryByRole('region', { name: 'Slices' })).toBeNull();
});

it('counts a prepared worktree as not started yet', () => {
  const region = strip([
    choice('wi/WI-01/implementation', 'slice', 'prepared', { actor: 'controller', reason: 'r' }),
  ]);
  expect(within(region).getByText('started').textContent).toContain('(not met)');
});
