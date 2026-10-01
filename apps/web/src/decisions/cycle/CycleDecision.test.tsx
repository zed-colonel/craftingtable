import type { AgentRunSummary } from '@craftingtable/contracts';
import { cycleActions, type WorkCycle, type WorktreeId } from '@craftingtable/domain';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CycleDecision } from './CycleDecision.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn(() => new Promise(() => {})) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = {
  id: 'c1',
  workspaceId: 'ws',
  workItemId: 'wi',
  worktreeId: 'wt-1',
  version: 3,
  status: 'needs-attention',
  step: 'implement',
  currentRunId: 'run-1',
  reason: 'Stopped.',
  remediationRounds: 0,
  policy: { maxNits: 0, maxRemediationRounds: 3, maxRunMinutes: 60 },
  profiles: Object.fromEntries(
    ['design', 'implement', 'review', 'remediate'].map((step) => [
      step,
      { backend: 'claude-code', permissionMode: 'auto' },
    ]),
  ),
} as unknown as WorkCycle;
const withActions = (cycle: WorkCycle) => ({ ...cycle, actions: cycleActions(cycle) });
const run = { id: 'run-1', worktreeId: 'wt-1', status: 'finished' } as AgentRunSummary;
function show(cycle: WorkCycle, readOnly = false, inInbox = false) {
  render(
    <CycleDecision
      inInbox={inInbox}
      cycle={withActions(cycle)}
      runs={[run]}
      readOnly={readOnly}
      backends={[]}
      csrfToken="csrf"
      canMutate
      busy={false}
      refreshToken={0}
      onChanged={vi.fn()}
      onOpenRun={vi.fn()}
      onOpenWorktree={vi.fn() as (id: WorktreeId) => void}
    />,
  );
}
const requested = (path: string) =>
  vi.mocked(request).mock.calls.some(([url]) => String(url).endsWith(path));

it("renders a design stop's questions, and no scope repair (R-A6 increment 2a)", async () => {
  show({
    ...base,
    step: 'design',
    attention: { code: 'design-open-questions', owner: 'operator' },
  } as WorkCycle);
  expect(screen.getByRole('region', { name: 'Resolve design questions' })).toBeDefined();
  expect(requested('/cycles/c1/scope-repair')).toBe(false);
});

it("renders a scope review's repair, and no integration conflict", async () => {
  show(
    {
      ...base,
      step: 'review',
      executionScope: {
        kind: 'slice-verification',
        definitionId: 'm',
        bindingRevision: 1,
        sourceId: 's',
      },
      attention: { code: 'scope-review-recovery', owner: 'operator' },
    } as WorkCycle,
    true,
  );
  await waitFor(() => expect(requested('/cycles/c1/scope-repair')).toBe(true));
  expect(screen.queryByRole('button', { name: 'Inspect integration conflicts' })).toBeNull();
});

it('renders an integration conflict, and no design questions', () => {
  show({ ...base, attention: { code: 'integration-conflict', owner: 'operator' } } as WorkCycle);
  expect(screen.getByRole('region', { name: 'Integration conflicts' })).toBeDefined();
  expect(screen.queryByRole('region', { name: 'Resolve design questions' })).toBeNull();
});

it("in the inbox, shows the cycle's questions, its run and its shared decisions, and no idle inspection (R-A6 review M2, M3)", () => {
  const onOpenRun = vi.fn();
  render(
    <CycleDecision
      inInbox
      cycle={
        {
          ...withActions({
            ...base,
            attention: { code: 'shared-decision-required', owner: 'operator' },
            workflow: { questions: [{ destination: 'local', question: 'Which queue backs it?' }] },
          } as unknown as WorkCycle),
          actions: ['open-shared-decisions'],
          unsettledDecisions: [{ checkpointId: 'ADR-1' }],
          executionScope: { kind: 'slice', definitionId: 'm', bindingRevision: 1, sourceId: 's' },
        } as unknown as WorkCycle
      }
      runs={[run]}
      readOnly={false}
      backends={[]}
      csrfToken="csrf"
      canMutate
      busy={false}
      refreshToken={0}
      onChanged={vi.fn()}
      onOpenRun={onOpenRun}
      onOpenWorktree={vi.fn() as (id: WorktreeId) => void}
    />,
  );
  expect(screen.getByText('Which queue backs it?')).toBeDefined();
  expect(screen.getByRole('link', { name: 'Open shared decisions (1)' })).toBeDefined();
  screen.getByRole('button', { name: 'Open current run' }).click();
  expect(onOpenRun).toHaveBeenCalledWith('run-1');
  expect(screen.queryByRole('button', { name: 'Inspect integration conflicts' })).toBeNull();
});
