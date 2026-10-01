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
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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
  await screen.findByText('Accepted · full architectural decision');
  expect(screen.getByText(/Shared decision accepted; ready for design confirmation/)).toBeTruthy();
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
