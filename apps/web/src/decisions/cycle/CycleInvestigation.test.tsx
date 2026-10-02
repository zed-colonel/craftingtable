import type { AgentRunSummary } from '@craftingtable/contracts';
import type { CycleAction, WorkCycle, WorktreeId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CycleDecision } from './CycleDecision.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn(() => new Promise(() => {})) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** R-C16 16b: a question stop's read-only investigation, in the stop's decision. */
const base = {
  id: 'c1',
  workspaceId: 'ws',
  workItemId: 'wi',
  worktreeId: 'wt-1',
  version: 3,
  status: 'needs-attention',
  step: 'implement',
  currentRunId: 'run-1',
  reason: 'Partly implemented.',
  remediationRounds: 0,
  attention: { code: 'implementation-open-questions', owner: 'operator' },
  policy: { maxNits: 0, maxRemediationRounds: 3, maxRunMinutes: 60 },
  profiles: Object.fromEntries(
    ['design', 'implement', 'review', 'remediate'].map((step) => [
      step,
      { backend: 'claude-code', model: `${step}-model`, permissionMode: 'auto' },
    ]),
  ),
} as unknown as WorkCycle;
const record = {
  id: '11111111-1111-4111-8111-111111111111',
  runId: 'inv-run',
  sourceRunId: 'run-1',
  code: 'implementation-open-questions',
  questionsDigest: '0'.repeat(64),
  profile: { backend: 'claude-code', model: 'design-model' },
  instructions: '',
  minutes: 30,
  deadlineAt: '2026-10-02T12:30:00.000Z',
  startedAt: '2026-10-02T12:00:00.000Z',
  startedByUserId: 'u1',
} as NonNullable<WorkCycle['investigation']>;
const finished = {
  endedAt: '2026-10-02T12:10:00.000Z',
  outcome: 'finished',
  findings: [
    {
      question: 'Which format should it use?',
      status: 'proposed',
      answer: 'Use JSON lines.',
      sources: ['docs/format.md:12'],
    },
    {
      question: 'Which release carries it?',
      status: 'open',
      answer: '',
      sources: [],
      reason: 'Nothing in the sources names a release.',
    },
  ],
} as NonNullable<NonNullable<WorkCycle['investigation']>['result']>;
const runs = [
  { id: 'run-1', worktreeId: 'wt-1', status: 'finished' },
] as unknown as AgentRunSummary[];
const backends = [
  { kind: 'claude-code', label: 'Claude Code', available: true, models: [] },
] as never;
function show(cycle: WorkCycle, actions: readonly CycleAction[], liveRuns = runs) {
  const onOpenRun = vi.fn();
  render(
    <CycleDecision
      inInbox
      cycle={{ ...cycle, actions }}
      runs={liveRuns}
      readOnly={false}
      backends={backends}
      csrfToken="csrf"
      canMutate
      busy={false}
      onChanged={vi.fn()}
      onOpenRun={onOpenRun}
      onOpenWorktree={vi.fn() as (id: WorktreeId) => void}
    />,
  );
  return { onOpenRun };
}
const posted = (path: string) =>
  vi
    .mocked(request)
    .mock.calls.filter(([url]) => String(url).endsWith(path))
    .map(([, , init]) => JSON.parse(String((init as RequestInit).body)));

it("offers Investigate beside the stop's own control, and starts it with a prompt and a limit", () => {
  show(base, ['continue-with-guidance', 'investigate', 'stop']);
  expect(screen.getByRole('form', { name: 'Continue with guidance' })).toBeTruthy();
  const form = screen.getByRole('form', { name: 'Investigate these questions' });
  fireEvent.change(within(form).getByLabelText('What to look into (optional)'), {
    target: { value: 'Check the format spec.' },
  });
  fireEvent.change(within(form).getByLabelText('Time limit (minutes)'), {
    target: { value: '20' },
  });
  fireEvent.click(within(form).getByRole('button', { name: 'Start investigation' }));
  expect(posted('/cycles/c1/investigation')).toEqual([
    {
      expectedVersion: 3,
      instructions: 'Check the format spec.',
      minutes: 20,
      profile: { backend: 'claude-code', model: 'design-model' },
    },
  ]);
});

it('shows a live investigation with only End, and no answer form while it runs', () => {
  const live = [
    ...runs,
    { id: 'inv-run', worktreeId: 'wt-1', status: 'running' },
  ] as unknown as AgentRunSummary[];
  // A routed question would otherwise show Continue with guidance.
  const workflow = {
    reassessments: 0,
    questions: [{ question: 'Which format should it use?', destination: 'work-item' }],
  } as WorkCycle['workflow'];
  const { onOpenRun } = show(
    { ...base, workflow, investigation: record },
    ['end-investigation'],
    live,
  );
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).getByText(/Investigating/)).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Continue with guidance' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Investigate these questions' })).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'Open investigation run' }));
  expect(onOpenRun).toHaveBeenCalledWith('inv-run');
  fireEvent.click(within(panel).getByRole('button', { name: 'End investigation' }));
  expect(posted('/cycles/c1/investigation/end')).toEqual([{ expectedVersion: 3 }]);
});

it("shows the proposals, and Use proposed answers fills the stop's own answer", () => {
  show({ ...base, investigation: { ...record, result: finished } }, [
    'continue-with-guidance',
    'investigate',
    'stop',
  ]);
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).getByText('Use JSON lines.')).toBeTruthy();
  expect(within(panel).getByText('docs/format.md:12')).toBeTruthy();
  expect(within(panel).getByText('Nothing in the sources names a release.')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Use proposed answers' }));
  const answer = within(
    screen.getByRole('form', { name: 'Continue with guidance' }),
  ).getByLabelText('Answers and recovery guidance') as HTMLTextAreaElement;
  expect(answer.value).toContain('Which format should it use?');
  expect(answer.value).toContain('Use JSON lines.');
  expect(answer.value).toContain('Which release carries it?');
  expect(answer.value).toContain('Still open');
  // Nothing is sent until the operator submits the stop's own control.
  expect(vi.mocked(request)).not.toHaveBeenCalled();
});

it('fills the remediation grant at the round limit, and shows a failure with another try', () => {
  show(
    {
      ...base,
      step: 'review',
      remediationRounds: 3,
      attention: { code: 'review-open-questions-at-limit', owner: 'operator' },
      investigation: { ...record, result: finished },
    } as WorkCycle,
    ['authorize-remediation', 'investigate', 'stop'],
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  const guidance = within(
    screen.getByRole('form', { name: 'Remediation recovery' }),
  ).getByLabelText('Guidance for the next run (optional)') as HTMLTextAreaElement;
  expect(guidance.value).toContain('Use JSON lines.');
  cleanup();

  show(
    {
      ...base,
      investigation: {
        ...record,
        result: {
          endedAt: finished.endedAt,
          outcome: 'failed',
          message: 'The investigation reached its time limit.',
        },
      },
    },
    ['continue-with-guidance', 'investigate', 'stop'],
  );
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).getByText(/reached its time limit/)).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Use proposed answers' })).toBeNull();
  expect(screen.getByRole('form', { name: 'Investigate these questions' })).toBeTruthy();
});
