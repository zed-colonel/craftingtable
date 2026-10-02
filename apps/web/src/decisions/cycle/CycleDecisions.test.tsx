import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import { cycleActions, DEFAULT_COMPLETION_POLICY, type WorkCycle } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { CycleContinuation, continuationOf } from './CycleDecisions.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
vi.mock('../../lib/execution-scope-api.js', () => ({ loadExecutionScopes: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

/** A cycle as the daemon sends it: with the actions it offers (R-A6). */
function cycle(fields: Partial<WorkCycle>): WorkCycle {
  const base = {
    id: 'c1',
    workspaceId: 'ws',
    workItemId: 'wi',
    worktreeId: 'wt',
    version: 3,
    status: 'needs-attention',
    step: 'implement',
    policy: DEFAULT_COMPLETION_POLICY,
    currentRunId: 'run-1',
    remediationRounds: 0,
    stalledReviews: 0,
    reason: 'Stopped.',
    ...fields,
  } as WorkCycle;
  return { ...base, actions: cycleActions(base) };
}
const posted = () =>
  vi.mocked(request).mock.calls.map(([url, , init]) => ({
    url: String(url),
    body: JSON.parse(String(init?.body)),
  }));

it('continues each stop the way the daemon allows (R-A6 review)', () => {
  // A transient stop: a plain resume is its only way on.
  expect(continuationOf(cycle({ attention: { code: 'step-time-limit', owner: 'operator' } }))).toBe(
    'resume',
  );
  expect(
    continuationOf(cycle({ attention: { code: 'workflow-report-invalid', owner: 'operator' } })),
  ).toBe('guidance');
  // Open questions, even on a paused step.
  expect(
    continuationOf(
      cycle({
        status: 'paused',
        workflow: {
          reassessments: 0,
          questions: [{ question: 'Which?', destination: 'work-item' }],
        },
      } as Partial<WorkCycle>),
    ),
  ).toBe('guidance');
  const exhausted = {
    step: 'review' as const,
    remediationRounds: DEFAULT_COMPLETION_POLICY.maxRemediationRounds,
    attention: { code: 'remediation-exhausted' as const, owner: 'operator' as const },
  };
  expect(continuationOf(cycle(exhausted))).toBe('remediation');
  // The daemon refuses more rounds outside a review: no form that would fail.
  expect(continuationOf(cycle({ ...exhausted, step: 'remediate' }))).toBeUndefined();
  // A parent or verification review, stopped or completed: resume, or review again.
  const parent = {
    executionScope: {
      kind: 'parent-acceptance' as const,
      definitionId: 'map',
      bindingRevision: 1,
      sourceId: 'wi/WI-01',
    },
  };
  expect(continuationOf(cycle({ ...parent, status: 'completed' }))).toBe('scope-review');
  expect(continuationOf(cycle(parent))).toBe('scope-review');
  expect(
    continuationOf(
      cycle({
        attention: { code: 'shared-decision-required', owner: 'operator' },
        unsettledDecisions: ['ADR-1'],
      }),
    ),
  ).toBeUndefined();
});

it('resumes a transient stop with the daemon command', async () => {
  vi.mocked(request).mockResolvedValue({});
  const stopped = cycle({ attention: { code: 'step-time-limit', owner: 'operator' } });
  const onChanged = vi.fn();
  render(
    <CycleContinuation cycle={stopped} csrfToken="csrf" disabled={false} onChanged={onChanged} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resume automation' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(posted()).toEqual([
    { url: '/api/workspaces/ws/cycles/c1/control', body: { action: 'resume', expectedVersion: 3 } },
  ]);
});

it('reviews a completed parent review again, with its instructions', async () => {
  vi.mocked(request).mockResolvedValue({});
  const scope = {
    kind: 'slice-verification' as const,
    definitionId: 'map',
    bindingRevision: 1,
    sourceId: 'wi/WI-01/domain',
  };
  vi.mocked(loadExecutionScopes).mockResolvedValue({
    choices: [
      // Scope choices name a verification review by its slice.
      {
        scope: { ...scope, kind: 'slice' },
        phases: [{ phase: 'verify', blockers: [] }],
      } as unknown as ExecutionScopeChoice,
    ],
  });
  render(
    <CycleContinuation
      cycle={cycle({ status: 'completed', executionScope: scope })}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByLabelText('Additional review guidance'), {
    target: { value: 'Check the new pins.' },
  });
  const again = await screen.findByRole('button', { name: 'Start fresh scope review' });
  await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(again);
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(posted()[0]?.body).toEqual({
    action: 'review-again',
    instructions: 'Check the new pins.',
    expectedVersion: 3,
  });
});
