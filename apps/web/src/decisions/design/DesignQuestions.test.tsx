import type { DesignRecoveryPreview } from '@craftingtable/contracts';
import {
  asUserId,
  asWorkspaceId,
  CYCLE_STEPS,
  DEFAULT_COMPLETION_POLICY,
  type WorkCycle,
} from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { previewDesignRecovery, recoverDesign } from './design-api.js';
import { DesignQuestions } from './DesignQuestions.js';

vi.mock('./design-api.js', () => ({
  previewDesignRecovery: vi.fn(),
  recoverDesign: vi.fn(),
}));
/** The inbox's open items, as the workspace's attention read returns them. */
let attention: {
  id: string;
  code: string;
  checkpointId?: string;
  refs?: { roadmapId?: string };
}[] = [];
vi.mock('../../app/reads.js', () => ({ useAttention: () => ({ data: { items: attention } }) }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  attention = [];
});
const cycle = {
  id: 'cycle',
  workspaceId: 'ws',
  workItemId: 'item',
  worktreeId: 'tree',
  currentRunId: 'design',
  version: 2,
  step: 'design',
  status: 'needs-attention',
  policy: DEFAULT_COMPLETION_POLICY,
  profiles: Object.fromEntries(
    CYCLE_STEPS.map((step) => [
      step,
      { backend: 'claude-code', permissionMode: 'auto', model: 'prior-model' },
    ]),
  ),
} as unknown as WorkCycle;
const preview: DesignRecoveryPreview = {
  expectedVersion: 2,
  sourceRunId: cycle.currentRunId,
  questions: 'Who owns this decision?',
  facts: 'Saved facts',
  snapshotDigest: 'a'.repeat(64),
  sources: [],
  notices: [],
};
const backends = [
  {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    executable: 'claude',
    models: [],
    catalog: { source: 'catalog' as const },
  },
];
it('only discovers on request, defaults to bounded investigation, and retains guidance after a failed submission', async () => {
  vi.mocked(previewDesignRecovery).mockResolvedValue(preview);
  vi.mocked(recoverDesign).mockRejectedValue(new Error('Evidence changed; refresh.'));
  const onChanged = vi.fn();
  render(
    <DesignQuestions cycle={cycle} backends={backends} csrfToken="csrf" onChanged={onChanged} />,
  );
  expect(previewDesignRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resolve design questions' }));
  expect(await screen.findByText('Who owns this decision?')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Answers and guidance'), {
    target: { value: 'I own the decision.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start bounded investigation' }));
  await screen.findByRole('alert');
  expect(recoverDesign).toHaveBeenCalledWith(
    cycle,
    expect.objectContaining({
      mode: 'investigate',
      expectedVersion: 2,
      snapshotDigest: preview.snapshotDigest,
      instructions: 'I own the decision.',
      profile: { backend: 'claude-code', model: 'prior-model' },
    }),
    'csrf',
  );
  expect((screen.getByLabelText('Answers and guidance') as HTMLTextAreaElement).value).toBe(
    'I own the decision.',
  );
  expect(onChanged).not.toHaveBeenCalled();
  vi.mocked(recoverDesign).mockResolvedValue({ cycle } as Awaited<
    ReturnType<typeof recoverDesign>
  >);
  fireEvent.change(screen.getByRole('combobox', { name: 'Next action' }), {
    target: { value: 'continue' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue design with evidence' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(vi.mocked(recoverDesign).mock.calls[1]?.[1].mode).toBe('continue');
});
it('disables a preview when the cycle changes until discovery is refreshed', async () => {
  vi.mocked(previewDesignRecovery).mockResolvedValue(preview);
  const view = render(
    <DesignQuestions cycle={cycle} backends={backends} csrfToken="csrf" onChanged={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resolve design questions' }));
  await screen.findByText('Who owns this decision?');
  view.rerender(
    <DesignQuestions
      cycle={{ ...cycle, version: 3 }}
      backends={backends}
      csrfToken="csrf"
      onChanged={vi.fn()}
    />,
  );
  expect(
    (screen.getByRole('button', { name: 'Start bounded investigation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('cycle changed');
  expect(recoverDesign).not.toHaveBeenCalled();
});
it('shows accepted shared decisions after discovery without resuming or requiring a repeated answer', async () => {
  const question = 'Approve WI-ADR-012?';
  vi.mocked(previewDesignRecovery).mockResolvedValue({
    ...preview,
    classifications: {
      version: 1,
      items: [
        {
          kind: 'operator-decision',
          question,
          answer: 'Approval pending in the original report.',
          sources: ['plan §4'],
        },
      ],
    },
    decisionInbox: {
      workspaceId: 'ws',
      definitionId: '00000000-0000-4000-8000-000000000001',
      bindingRevision: 4,
      blockers: [],
      decisions: [
        {
          checkpointId: 'WI-ADR-012',
          title: 'Ingress policy',
          requirements: [],
          blockers: [],
          sourceReferences: 'plan §4',
          consumers: [{ sliceId: 'wi/WI-03/domain', phase: 'merge' }],
          recommendation: {
            sourceRunId: 'run',
            sourceReportDigest: 'a'.repeat(64),
            sliceId: 'wi/WI-03/domain',
            question,
            answer: 'Original recommendation',
            sources: ['plan §4'],
          },
          records: [
            {
              id: 'proposal',
              applicable: true,
              issues: [],
              proposal: {
                kind: 'architecture-decision-v1',
                bindingDigest: 'b'.repeat(64),
                coverage: 'full',
                proposal: 'Use stable identities.',
                sourceReferences: 'plan §4',
                consumers: [],
                retainedObligations: '',
              },
              decision: {
                id: 'approval',
                workspaceId: asWorkspaceId('ws'),
                submissionId: 'proposal',
                outcome: 'accepted',
                rationale: 'Meets my requirements.',
                decidedAt: '2026-09-20T00:00:00Z',
                decidedByUserId: asUserId('owner'),
              },
            },
          ],
        },
      ],
    },
  });
  render(
    <DesignQuestions cycle={cycle} backends={backends} csrfToken="csrf" onChanged={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resolve design questions' }));
  await screen.findByText(/Shared decision accepted; ready for design confirmation/);
  // An accepted decision waits on nothing: it is not listed as one the design waits on.
  expect(
    screen.queryByRole('region', { name: 'Shared decisions this design waits on' }),
  ).toBeNull();
  expect(screen.queryByText('Approval pending in the original report.')).toBeNull();
  expect(recoverDesign).not.toHaveBeenCalled();
});

it('surfaces a completed investigation without requiring evidence rediscovery', () => {
  render(
    <DesignQuestions
      cycle={{
        ...cycle,
        designRecovery: {
          runId: cycle.currentRunId,
          mode: 'investigate',
          profile: cycle.profiles.design,
          attachments: [],
        } as unknown as WorkCycle['designRecovery'],
      }}
      backends={backends}
      csrfToken="csrf"
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText('Investigation results and evidence')).toBeTruthy();
  expect(previewDesignRecovery).not.toHaveBeenCalled();
  expect(recoverDesign).not.toHaveBeenCalled();
});

it('links each decision the design waits on to its own item, else to the shared decisions, and clarifies here (R-A6 rest, A3)', async () => {
  const card = (checkpointId: string, title: string) => ({
    checkpointId,
    title,
    requirements: [],
    blockers: [],
    sourceReferences: 'plan §4',
    consumers: [],
    records: [],
  });
  vi.mocked(previewDesignRecovery).mockResolvedValue({
    ...preview,
    decisionInbox: {
      workspaceId: 'ws',
      definitionId: '00000000-0000-4000-8000-000000000001',
      bindingRevision: 4,
      blockers: [],
      decisions: [card('WI-ADR-012', 'Ingress policy'), card('WI-ADR-013', 'Egress policy')],
    },
  });
  // The checkpoint's own item wins over a preparation of it; another decision has none.
  // Another roadmap's item for a decision of the same id is not this design's (review L5).
  attention = [
    {
      id: 'other-roadmap',
      code: 'architecture-decision',
      checkpointId: 'WI-ADR-013',
      refs: { roadmapId: 'roadmap-2' },
    },
    {
      id: 'prep-item',
      code: 'decision-preparation-questions',
      checkpointId: 'WI-ADR-012',
      refs: { roadmapId: 'roadmap-1' },
    },
    {
      id: 'decision-item',
      code: 'architecture-decision',
      checkpointId: 'WI-ADR-012',
      refs: { roadmapId: 'roadmap-1' },
    },
  ];
  render(
    <DesignQuestions
      cycle={
        { ...cycle, owner: { kind: 'roadmap', roadmapId: 'roadmap-1' } } as unknown as WorkCycle
      }
      backends={backends}
      csrfToken="csrf"
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resolve design questions' }));
  const own = await screen.findByRole('link', { name: 'Decide WI-ADR-012 in Needs you' });
  expect(own.getAttribute('href')).toBe('/workspaces/ws/inbox/decision-item');
  expect(
    screen
      .getByRole('link', { name: 'Decide WI-ADR-013 with the shared decisions' })
      .getAttribute('href'),
  ).toMatch(/^\/workspaces\/ws\/roadmaps\/roadmap-1\/setup/);
  // No decision card, and nothing to approve, is embedded here.
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Request clarification' })[1]!);
  const guidance = (await screen.findByLabelText(/guidance/i)) as HTMLTextAreaElement;
  expect(guidance.value).toMatch(/^Clarify WI-ADR-013 for operator review\./);
  expect(recoverDesign).not.toHaveBeenCalled();
});
