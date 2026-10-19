import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import {
  type AgentSelections,
  asConcurrencyDefinitionId,
  type CycleProjection,
  type CycleView,
  cycleActions,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
  type CycleAttention,
  stopRecord,
} from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { useStopDraft } from './answer-draft.js';
import { CycleContinuation, continuationOf } from './CycleDecisions.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
vi.mock('../../lib/execution-scope-api.js', () => ({ loadExecutionScopes: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

/** A cycle as the daemon sends it: beside its projection, with the actions it offers (R-A6). */
/** A cycle view; `attention` is the stop it is at, as the daemon stores it (R-B4b). */
function cycle(
  { attention, ...fields }: Partial<WorkCycle> & { readonly attention?: CycleAttention },
  projected: Partial<CycleProjection> = {},
): CycleView {
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
    ...(attention ? { stop: stopRecord(attention, '2026-09-20T12:00:00.000Z') } : {}),
  } as WorkCycle;
  return {
    cycle: base,
    projection: {
      nextAgentSelections: {} as AgentSelections,
      actions: cycleActions({ ...base, ...projected }),
      ...projected,
    },
  };
}
const continuation = (view: CycleView) => continuationOf(view.cycle, view.projection);
const posted = () =>
  vi.mocked(request).mock.calls.map(([url, , init]) => ({
    url: String(url),
    body: JSON.parse(String(init?.body)),
  }));

it('continues each stop the way the daemon allows (R-A6 review)', () => {
  // A transient stop: a plain resume is its only way on.
  expect(continuation(cycle({ attention: { code: 'step-time-limit', owner: 'operator' } }))).toBe(
    'resume',
  );
  expect(
    continuation(cycle({ attention: { code: 'workflow-report-invalid', owner: 'operator' } })),
  ).toBe('guidance');
  // Open questions, even on a paused step.
  expect(
    continuation(
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
  expect(continuation(cycle(exhausted))).toBe('remediation');
  // Housekeeping's limit stop at an implement or remediate step takes the grant too (R-B4,
  // decision 4); another stop there has no more rounds to grant.
  expect(continuation(cycle({ ...exhausted, step: 'remediate' }))).toBe('remediation');
  expect(continuation(cycle({ ...exhausted, step: 'implement' }))).toBe('remediation');
  expect(
    continuation(
      cycle({
        ...exhausted,
        step: 'remediate',
        attention: { code: 'step-incomplete' as const, owner: 'operator' as const },
      }),
    ),
  ).not.toBe('remediation');
  // A parent or verification review, stopped or completed: resume, or review again.
  const parent = {
    executionScope: {
      kind: 'parent-acceptance' as const,
      definitionId: asConcurrencyDefinitionId('map'),
      bindingRevision: 1,
      sourceId: 'wi/WI-01',
    },
  };
  expect(continuation(cycle({ ...parent, status: 'completed' }))).toBe('scope-review');
  expect(continuation(cycle(parent))).toBe('scope-review');
  expect(
    continuation(
      cycle(
        { attention: { code: 'shared-decision-required', owner: 'operator' } },
        { unsettledDecisions: ['ADR-1'] },
      ),
    ),
  ).toBeUndefined();
});

it('resumes a transient stop with the daemon command', async () => {
  vi.mocked(request).mockResolvedValue({});
  const stopped = cycle({ attention: { code: 'step-time-limit', owner: 'operator' } });
  const onChanged = vi.fn();
  render(
    <CycleContinuation
      cycle={stopped.cycle}
      projection={stopped.projection}
      csrfToken="csrf"
      disabled={false}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resume automation' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(posted()).toEqual([
    { url: '/api/workspaces/ws/cycles/c1/control', body: { action: 'resume', expectedVersion: 3 } },
  ]);
});

// R-C17 part 4, decisions 1 and 2: where the daemon offers Continue with guidance beside Resume,
// one form takes either: empty, its submit resumes; with guidance, it continues with it.
it('resumes the time-limit stop, or continues it with guidance, from one form (R-C17 part 4)', async () => {
  vi.mocked(request).mockResolvedValue({});
  const guided = { actions: ['resume', 'continue-with-guidance', 'stop'] as const };
  const stopped = cycle(
    { attention: { code: 'step-time-limit', owner: 'operator' } },
    { actions: [...guided.actions] },
  );
  expect(continuation(stopped)).toBe('guidance');
  const onChanged = vi.fn();
  const view = render(
    <CycleContinuation
      cycle={stopped.cycle}
      projection={stopped.projection}
      csrfToken="csrf"
      disabled={false}
      onChanged={onChanged}
    />,
  );
  const field = screen.getByLabelText('Answers and recovery guidance') as HTMLTextAreaElement;
  expect(field.required).toBe(false);
  expect(screen.queryByRole('button', { name: 'Continue with guidance' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Resume automation' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  fireEvent.change(field, { target: { value: '  Run the slow test alone first.  ' } });
  expect(screen.queryByRole('button', { name: 'Resume automation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with guidance' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  expect(posted()).toEqual([
    { url: '/api/workspaces/ws/cycles/c1/control', body: { action: 'resume', expectedVersion: 3 } },
    {
      url: '/api/workspaces/ws/cycles/c1/control',
      body: {
        action: 'resume',
        expectedVersion: 3,
        instructions: 'Run the slow test alone first.',
      },
    },
  ]);
  view.unmount();
});

it('keeps guidance required where it is the only way on, or questions wait for answers (R-C17 part 4)', () => {
  for (const view of [
    // A redirect: Continue with guidance replaces Resume.
    cycle({ attention: { code: 'implementation-open-questions', owner: 'operator' } }),
    // Questions to answer, though Resume is offered too.
    cycle(
      {
        attention: { code: 'work-item-questions', owner: 'operator' },
        workflow: { questions: ['Which queue?'] } as unknown as WorkCycle['workflow'],
      },
      { actions: ['resume', 'continue-with-guidance', 'stop'] },
    ),
  ]) {
    const rendered = render(
      <CycleContinuation
        cycle={view.cycle}
        projection={view.projection}
        csrfToken="csrf"
        disabled={false}
        onChanged={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText('Answers and recovery guidance') as HTMLTextAreaElement).required,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Continue with guidance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Resume automation' })).toBeNull();
    rendered.unmount();
  }
});

it('reviews a completed parent review again, with its instructions', async () => {
  vi.mocked(request).mockResolvedValue({});
  const scope = {
    kind: 'slice-verification' as const,
    definitionId: asConcurrencyDefinitionId('map'),
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
      {...cycle({ status: 'completed', executionScope: scope })}
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

// TS-M8 (R-C16 16b, which lost answers twice in review): only a sent answer is cleared. A
// refused command (the cycle moved on while the operator wrote) keeps the operator's draft, in
// the field and in the stop's session draft, for each continuation that takes one.
const parentScope = {
  kind: 'parent-acceptance' as const,
  definitionId: asConcurrencyDefinitionId('map'),
  bindingRevision: 1,
  sourceId: 'wi/WI-01',
};
it.each([
  {
    form: 'guidance',
    stopped: cycle({ attention: { code: 'implementation-open-questions', owner: 'operator' } }),
    field: 'Answers and recovery guidance',
    submit: 'Continue with guidance',
    body: { action: 'resume', instructions: 'Use JSON lines.' },
  },
  {
    form: 'remediation grant',
    stopped: cycle({
      step: 'review',
      remediationRounds: DEFAULT_COMPLETION_POLICY.maxRemediationRounds,
      attention: { code: 'remediation-exhausted', owner: 'operator' },
    }),
    field: 'Guidance for the next run (optional)',
    submit: 'Authorize more remediation',
    body: { action: 'authorize-remediation', additionalRounds: 1, instructions: 'Use JSON lines.' },
  },
  {
    form: 'scope review',
    stopped: cycle({ step: 'review', executionScope: parentScope }),
    field: 'Additional review guidance',
    submit: 'Resume scope review',
    body: { action: 'resume', instructions: 'Use JSON lines.' },
  },
])(
  'keeps the $form draft when its command is refused, and clears it once sent',
  async ({ stopped, field, submit, body }) => {
    vi.mocked(loadExecutionScopes).mockResolvedValue({
      choices: [
        {
          scope: parentScope,
          phases: [{ phase: 'accept', blockers: [] }],
        } as unknown as ExecutionScopeChoice,
      ],
    });
    const onChanged = vi.fn();
    // The stop's decision holds its answer for the session, as `CycleDecision` does.
    function Decision() {
      const answer = useStopDraft(`${stopped.cycle.id}:${stopped.cycle.currentRunId}:stop`);
      return (
        <CycleContinuation
          cycle={stopped.cycle}
          projection={stopped.projection}
          csrfToken="csrf"
          disabled={false}
          onChanged={onChanged}
          answer={answer}
        />
      );
    }
    const text = () => (screen.getByLabelText(field) as HTMLTextAreaElement).value;
    const send = async () => {
      const button = screen.getByRole('button', { name: submit }) as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(false));
      fireEvent.click(button);
    };
    const view = render(<Decision />);
    fireEvent.change(screen.getByLabelText(field), { target: { value: 'Use JSON lines.' } });
    vi.mocked(request).mockRejectedValueOnce(new Error('Cycle changed; refresh and try again.'));
    await send();
    await screen.findByText('Cycle changed; refresh and try again.');
    expect(posted()).toEqual([
      { url: '/api/workspaces/ws/cycles/c1/control', body: { ...body, expectedVersion: 3 } },
    ]);
    expect(text()).toBe('Use JSON lines.');
    expect(onChanged).not.toHaveBeenCalled();
    // Coming back to the stop (another page, the inbox) still shows it.
    view.unmount();
    render(<Decision />);
    expect(text()).toBe('Use JSON lines.');
    // Sent: the stop's answer is not offered again.
    vi.mocked(request).mockResolvedValueOnce({});
    await send();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(text()).toBe('');
  },
);

// Increment 1 re-check RN-1: a plain pause with no questions has no continuation here; its Resume
// is the cycle panel's manual control.
it('gives a plain pause no continuation', () =>
  expect(
    continuation(cycle({ status: 'paused' }, { actions: ['resume', 'stop'] })),
  ).toBeUndefined());
