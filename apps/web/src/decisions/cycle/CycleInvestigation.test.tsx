import type { AgentRunSummary } from '@craftingtable/contracts';
import type { CycleAction, WorkCycle, WorktreeId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { CycleDecision } from './CycleDecision.js';
import { asyncWaitMs } from '../../test-time.js';

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
function decision(
  cycle: WorkCycle,
  actions: readonly CycleAction[],
  options: {
    liveRuns?: readonly AgentRunSummary[];
    canMutate?: boolean;
    backends?: typeof backends;
    onOpenRun?: (id: string) => void;
    onChanged?: () => void;
  } = {},
) {
  return (
    <CycleDecision
      inInbox
      cycle={{ ...cycle, actions }}
      runs={options.liveRuns ?? runs}
      readOnly={false}
      backends={options.backends ?? backends}
      csrfToken="csrf"
      canMutate={options.canMutate ?? true}
      busy={false}
      onChanged={options.onChanged ?? vi.fn()}
      onOpenRun={options.onOpenRun ?? vi.fn()}
      onOpenWorktree={vi.fn() as (id: WorktreeId) => void}
    />
  );
}
function show(cycle: WorkCycle, actions: readonly CycleAction[], liveRuns = runs) {
  const onOpenRun = vi.fn();
  render(decision(cycle, actions, { liveRuns, onOpenRun }));
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
  expect((within(form).getByLabelText('Time limit (minutes)') as HTMLInputElement).value).toBe(
    '30',
  );
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

// R-C16 16b review: the stop's answer is the operator's draft. Proposals are added to it, the
// draft survives the form being hidden while another investigation runs, and it never follows
// the operator to another cycle (H1, M1, M2, M3).
it("keeps the operator's draft, and adds each investigation's proposals to it once", () => {
  const questions = ['continue-with-guidance', 'investigate', 'stop'] as const;
  const second = {
    ...finished,
    findings: [{ ...finished.findings![0]!, answer: 'Use CSV.' }],
  } as typeof finished;
  const live = [
    ...runs,
    { id: 'inv-run', worktreeId: 'wt-1', status: 'running' },
  ] as unknown as AgentRunSummary[];
  const view = render(
    decision({ ...base, investigation: { ...record, result: finished } }, questions),
  );
  const field = () => screen.getByLabelText('Answers and recovery guidance') as HTMLTextAreaElement;
  fireEvent.change(field(), { target: { value: 'My draft.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  expect(field().value.startsWith('My draft.\n\nFrom the investigation')).toBe(true);
  expect(field().value).toContain('Use JSON lines. (Sources: docs/format.md:12)');
  expect(screen.getByText('Added to your answer below. Edit it before you send it.')).toBeTruthy();
  expect(document.activeElement).toBe(field());
  fireEvent.change(field(), { target: { value: `${field().value}\nMy edit.` } });
  const edited = field().value;
  // Another investigation runs, with the form hidden, and ends with new proposals.
  view.rerender(
    decision({ ...base, investigation: { ...record, id: 'second' } }, ['end-investigation'], {
      liveRuns: live,
    }),
  );
  expect(screen.queryByLabelText('Answers and recovery guidance')).toBeNull();
  view.rerender(
    decision({ ...base, investigation: { ...record, id: 'second', result: second } }, questions),
  );
  expect(field().value).toBe(edited);
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  expect(field().value.startsWith(edited)).toBe(true);
  expect(field().value.match(/Use CSV\./g)).toHaveLength(1);
  // Another cycle has its own answer.
  view.rerender(
    decision({ ...base, id: 'c2', investigation: { ...record, result: second } }, questions),
  );
  expect(field().value).toBe('');
  expect(vi.mocked(request)).not.toHaveBeenCalled();
});

it('offers Use proposed answers only where a form takes them, a scope review included (M4)', () => {
  const scoped = {
    ...base,
    step: 'review',
    executionScope: {
      kind: 'parent-acceptance',
      definitionId: 'd',
      bindingRevision: 1,
      sourceId: 'P',
    },
    attention: { code: 'scope-review-open-questions', owner: 'operator' },
    investigation: { ...record, result: finished },
  } as unknown as WorkCycle;
  show(scoped, ['resume', 'investigate', 'stop']);
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  expect(
    (screen.getByLabelText('Additional review guidance') as HTMLTextAreaElement).value,
  ).toContain('Use JSON lines.');
  cleanup();
  // A paused stop with no answer form: the proposals show, with nothing to fill.
  show({ ...base, status: 'paused', investigation: { ...record, result: finished } }, [
    'resume',
    'investigate',
    'stop',
  ]);
  expect(screen.getByText('Use JSON lines.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use proposed answers' })).toBeNull();
});

it('cuts proposals to what the control accepts (L1)', () => {
  const long = {
    ...finished,
    findings: Array.from({ length: 6 }, (_, i) => ({
      question: `Question ${i}?`,
      status: 'proposed' as const,
      answer: 'x'.repeat(3000),
      sources: ['a.md:1'],
    })),
  } as typeof finished;
  show({ ...base, investigation: { ...record, result: long } }, [
    'continue-with-guidance',
    'investigate',
    'stop',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  const value = (screen.getByLabelText('Answers and recovery guidance') as HTMLTextAreaElement)
    .value;
  expect(value.length).toBeLessThanOrEqual(16_000);
  expect(value.endsWith('(cut to fit; the full proposals are above)')).toBe(true);
});

it('starts from the cycle investigation profile, refuses an unavailable agent or a bad limit, and trims the prompt (M5)', () => {
  const profiled = {
    ...base,
    nextAgentSelections: {
      design: { backend: 'claude-code', model: 'design-model' },
      implement: { backend: 'claude-code' },
      review: { backend: 'claude-code' },
      remediate: { backend: 'claude-code' },
      investigation: { backend: 'claude-code', model: 'investigation-model' },
    },
  } as unknown as WorkCycle;
  show(profiled, ['continue-with-guidance', 'investigate', 'stop']);
  const form = screen.getByRole('form', { name: 'Investigate these questions' });
  expect(within(form).getByText(/Agent: Claude Code · investigation-model/)).toBeTruthy();
  const start = within(form).getByRole('button', {
    name: 'Start investigation',
  }) as HTMLButtonElement;
  fireEvent.change(within(form).getByLabelText('Time limit (minutes)'), {
    target: { value: '70' },
  });
  expect(start.disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText('Time limit (minutes)'), { target: { value: '4' } });
  expect(start.disabled).toBe(true);
  fireEvent.change(within(form).getByLabelText('Time limit (minutes)'), {
    target: { value: '30' },
  });
  fireEvent.change(within(form).getByLabelText('What to look into (optional)'), {
    target: { value: '  Check X.  ' },
  });
  fireEvent.click(start);
  expect(posted('/cycles/c1/investigation')).toEqual([
    {
      expectedVersion: 3,
      instructions: 'Check X.',
      minutes: 30,
      profile: { backend: 'claude-code', model: 'investigation-model' },
    },
  ]);
  cleanup();
  render(
    decision(base, ['continue-with-guidance', 'investigate', 'stop'], {
      backends: [
        { kind: 'claude-code', label: 'Claude Code', available: false, models: [] },
      ] as never,
    }),
  );
  expect(screen.getByText(/unavailable on this workstation/)).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Start investigation' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('retries from the last investigation, shows its outcome and deadline, and needs mutate rights (L2, M5)', async () => {
  const failed = {
    ...record,
    instructions: 'Check the format spec.',
    minutes: 20,
    result: { endedAt: finished.endedAt, outcome: 'failed', message: 'Launch failed.' },
  } as NonNullable<WorkCycle['investigation']>;
  show({ ...base, investigation: failed }, ['continue-with-guidance', 'investigate', 'stop']);
  expect(screen.getByText(/The investigation failed\. Launch failed\./)).toBeTruthy();
  const form = screen.getByRole('form', { name: 'Investigate these questions' });
  expect(
    (within(form).getByLabelText('What to look into (optional)') as HTMLTextAreaElement).value,
  ).toBe('Check the format spec.');
  expect((within(form).getByLabelText('Time limit (minutes)') as HTMLInputElement).value).toBe(
    '20',
  );
  cleanup();
  // A record still live shows End, with its deadline's date, whatever the actions.
  render(
    decision(
      { ...base, investigation: { ...record, deadlineAt: '2099-10-02T12:30:00.000Z' } },
      ['stop'],
      {
        canMutate: false,
      },
    ),
  );
  expect(screen.getByRole('status').textContent).toContain('2099');
  expect(
    (screen.getByRole('button', { name: 'End investigation' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  cleanup();
  render(
    decision(
      { ...base, investigation: { ...record, result: finished } },
      ['continue-with-guidance', 'investigate', 'stop'],
      {
        canMutate: false,
      },
    ),
  );
  expect(
    (screen.getByRole('button', { name: 'Use proposed answers' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Start investigation' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.submit(screen.getByRole('form', { name: 'Investigate these questions' }));
  expect(posted('/cycles/c1/investigation')).toEqual([]);
  cleanup();
  // A failed command is shown; a successful one refreshes.
  vi.mocked(request).mockRejectedValueOnce(new Error('Boom.'));
  const onChanged = vi.fn();
  render(decision({ ...base, investigation: record }, ['end-investigation'], { onChanged }));
  fireEvent.click(screen.getByRole('button', { name: 'End investigation' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Boom.');
  expect(onChanged).not.toHaveBeenCalled();
  vi.mocked(request).mockResolvedValueOnce({ cycle: base } as never);
  fireEvent.click(screen.getByRole('button', { name: 'End investigation' }));
  await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1), { timeout: asyncWaitMs() });
});

it('shows nothing without a record or an offer, and no form unless one is offered', () => {
  show(base, ['continue-with-guidance', 'stop']);
  expect(screen.queryByRole('region', { name: 'Investigation' })).toBeNull();
  cleanup();
  show({ ...base, investigation: { ...record, result: finished } }, [
    'continue-with-guidance',
    'stop',
  ]);
  expect(screen.getByRole('region', { name: 'Investigation' })).toBeTruthy();
  expect(screen.queryByRole('form', { name: 'Investigate these questions' })).toBeNull();
});

// R-C16 16b verification: the draft is held for the session, above the view; it is cleared
// once sent; proposals are added once per investigation; the field keeps its Tab place.
it('keeps a stop draft across leaving and coming back, and clears it once sent', async () => {
  const questions = ['continue-with-guidance', 'investigate', 'stop'] as const;
  const at = { ...base, investigation: { ...record, result: finished } };
  const view = render(decision(at, questions));
  const field = () => screen.getByLabelText('Answers and recovery guidance') as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  // Once per investigation: a second click cannot add them again.
  expect(
    (screen.getByRole('button', { name: 'Use proposed answers' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(field().value.match(/Use JSON lines\./g)).toHaveLength(1);
  expect(document.activeElement).toBe(field());
  expect(field().getAttribute('tabindex')).toBeNull();
  fireEvent.change(field(), { target: { value: `${field().value}\nMine.` } });
  const typed = field().value;
  // Opening the run and coming back mounts the decision again.
  view.unmount();
  render(decision(at, questions));
  expect(field().value).toBe(typed);
  // The status and the used state belong to that investigation.
  expect(screen.getByText('Added to your answer below. Edit it before you send it.')).toBeTruthy();
  cleanup();
  render(
    decision({ ...at, investigation: { ...record, id: 'next', result: finished } }, questions),
  );
  expect(screen.queryByText(/Added to your answer below/)).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Use proposed answers' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  // A pause taken at the stop keeps its draft; a new run at the same stop starts empty.
  cleanup();
  render(
    decision(
      {
        ...at,
        status: 'paused',
        workflow: { reassessments: 0, questions: [{ question: 'Q?', destination: 'work-item' }] },
      } as WorkCycle,
      ['resume', 'investigate', 'stop'],
    ),
  );
  expect(field().value).toBe(typed);
  cleanup();
  render(decision({ ...at, currentRunId: 'run-2' } as WorkCycle, questions));
  expect(field().value).toBe('');
  cleanup();
  // A successful answer is not offered again.
  vi.mocked(request).mockResolvedValueOnce({ cycle: base } as never);
  render(decision(at, questions));
  fireEvent.click(screen.getByRole('button', { name: 'Continue with guidance' }));
  await vi.waitFor(() => expect(field().value).toBe(''), { timeout: asyncWaitMs() });
});

it('offers no proposals to a stop that only resumes, and focuses the grant and scope review fields', () => {
  show(
    {
      ...base,
      attention: { code: 'scope-review-open-questions', owner: 'operator' },
      investigation: { ...record, result: finished },
    } as WorkCycle,
    ['resume', 'investigate', 'stop'],
  );
  expect(screen.getByRole('button', { name: 'Resume automation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use proposed answers' })).toBeNull();
  cleanup();
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
  expect(document.activeElement).toBe(
    screen.getByLabelText('Guidance for the next run (optional)'),
  );
  cleanup();
  show(
    {
      ...base,
      step: 'review',
      executionScope: {
        kind: 'parent-acceptance',
        definitionId: 'd',
        bindingRevision: 1,
        sourceId: 'P',
      },
      attention: { code: 'scope-review-open-questions', owner: 'operator' },
      investigation: { ...record, result: finished },
    } as unknown as WorkCycle,
    ['resume', 'investigate', 'stop'],
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use proposed answers' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Additional review guidance'));
});

const changed = {
  ...finished,
  outcome: 'failed',
  code: 'worktree-changed',
  worktreeChange: {
    parts: ['untracked', 'head'],
    headBefore: 'a'.repeat(40),
    headAfter: 'b'.repeat(40),
    paths: ['planted.txt'],
  },
} as NonNullable<NonNullable<WorkCycle['investigation']>['result']>;
const routed = {
  reassessments: 0,
  questions: [{ question: 'Which format should it use?', destination: 'work-item' }],
} as WorkCycle['workflow'];

it('names a worktree change, takes only its acknowledgement, and shows the proposals without Use (R-C16)', () => {
  show({ ...base, workflow: routed, investigation: { ...record, result: changed } }, [
    'acknowledge-worktree-change',
    'stop',
  ]);
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).getByRole('alert').textContent).toContain(
    'The worktree changed while the investigation ran: untracked files, its commit (HEAD aaaaaaaaaaaa → bbbbbbbbbbbb)',
  );
  expect(within(panel).getByText('planted.txt')).toBeTruthy();
  // The proposals are there to read; nothing offers them for use, and no answer form shows.
  expect(within(panel).getByText('Use JSON lines.')).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Use proposed answers' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Continue with guidance' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Investigate these questions' })).toBeNull();
  fireEvent.click(within(panel).getByRole('button', { name: 'Acknowledge the change' }));
  expect(posted('/cycles/c1/investigation/acknowledge-change')).toEqual([{ expectedVersion: 3 }]);
});

it('after an acknowledgement, answers the stop as usual but still never offers those proposals (R-C16)', () => {
  show(
    {
      ...base,
      workflow: routed,
      investigation: {
        ...record,
        result: { ...changed, acknowledgedAt: '2026-10-02T12:20:00.000Z' },
      },
    },
    ['continue-with-guidance', 'investigate', 'stop'],
  );
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).getByText(/You acknowledged the change/)).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Acknowledge the change' })).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Use proposed answers' })).toBeNull();
  expect(screen.getByRole('form', { name: 'Continue with guidance' })).toBeTruthy();
});

it('offers Acknowledge only when the daemon does, and keys the proposals on the code (R-C16 review)', () => {
  // Held by the daemon but not offered here (a stop the operator may not act on): no button.
  show({ ...base, workflow: routed, investigation: { ...record, result: changed } }, ['stop']);
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).queryByRole('button', { name: 'Acknowledge the change' })).toBeNull();
  expect(within(panel).queryByRole('button', { name: 'Use proposed answers' })).toBeNull();
});

it('says an investigation is ending once End was asked, until its process has exited (R-C16 review)', () => {
  show({ ...base, investigation: { ...record, endRequestedAt: '2026-10-02T12:05:00.000Z' } }, [
    'end-investigation',
  ]);
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(within(panel).getByRole('status').textContent).toContain(
    'Ending: the investigation run was asked to end',
  );
});

it('says when the unchanged worktree was compared partly by size and time (R-C16 review L4)', () => {
  const worktree = {
    headSha: 'a'.repeat(40),
    branch: 'item',
    fingerprint: '0'.repeat(64),
    trackedClean: true,
    untrackedDigest: '0'.repeat(64),
    ignoredDigest: '0'.repeat(64),
    gitDigest: '0'.repeat(64),
    metadataOnly: 2,
  };
  show({ ...base, investigation: { ...record, worktree, result: finished } }, [
    'continue-with-guidance',
    'investigate',
    'stop',
  ]);
  const panel = screen.getByRole('region', { name: 'Investigation' });
  expect(panel.textContent).toContain(
    '2 large files were compared by size and modification time only',
  );
});
