import type { ScopeRepairPreview } from '@craftingtable/contracts';
import { asAgentRunId, cycleAttention, type WorkCycle } from '@craftingtable/domain';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { delegateScopeRepair, previewScopeRepair } from './scope-repair-api.js';
import { ScopeRepair } from './ScopeRepair.js';
vi.mock('./scope-repair-api.js', () => ({
  delegateScopeRepair: vi.fn(),
  previewScopeRepair: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const scope = {
  kind: 'slice' as const,
  definitionId: 'map',
  bindingRevision: 4,
  sourceId: 'exo/EXO-01/domain',
};
const cycle = {
  id: 'review',
  version: 5,
  status: 'needs-attention',
  reason: 'Scope review requires recovery: a finding is open.',
  workspaceId: 'ws',
  workItemId: 'exo',
  executionScope: { ...scope, kind: 'slice-verification' },
} as WorkCycle;
const profile = { backend: 'codex' as const, permissionMode: 'edit-only' as const };
const preview: ScopeRepairPreview = {
  cycleVersion: 5,
  snapshotDigest: 'a'.repeat(64),
  candidates: [
    {
      scope,
      title: 'Domain',
      blockers: [],
      profiles: { design: profile, implement: profile, review: profile, remediate: profile },
    },
  ],
  sources: [
    {
      runId: asAgentRunId('verify'),
      sequence: 4,
      label: 'R1',
      scope: cycle.executionScope!,
      findings: [
        {
          id: 'R1.F-003',
          originalId: 'F-003',
          title: 'Contribution guidance',
          severity: 'major',
          status: 'open',
          explanation: 'Wrong target.',
          recommendation: 'Use integration.',
        },
      ],
    },
    {
      runId: asAgentRunId('parent'),
      sequence: 4,
      label: 'R2',
      scope: { ...scope, kind: 'parent-acceptance' },
      findings: [
        {
          id: 'R2.F-003',
          originalId: 'F-003',
          title: 'Semantic inventory',
          severity: 'major',
          status: 'open',
          explanation: 'Wrong classification.',
          recommendation: 'Correct ownership.',
        },
      ],
    },
  ],
};
function panel() {
  const onStarted = vi.fn(),
    onOpen = vi.fn();
  render(
    <ScopeRepair
      cycle={cycle}
      disabled={false}
      csrfToken="csrf"
      refreshToken={0}
      onStarted={onStarted}
      onOpen={onOpen}
    />,
  );
  return { onStarted, onOpen };
}
it('shows both colliding findings and preserves guidance across a stale-preview recovery', async () => {
  vi.mocked(previewScopeRepair).mockResolvedValue(preview);
  vi.mocked(delegateScopeRepair)
    .mockRejectedValueOnce(new Error('Recovery inputs changed; refresh the preview.'))
    .mockResolvedValueOnce({
      cycle: structuredClone({ ...cycle, id: 'repair' }) as Awaited<
        ReturnType<typeof delegateScopeRepair>
      >['cycle'],
    });
  const { onStarted } = panel();
  await screen.findByText('R1.F-003 · major · Contribution guidance');
  expect(screen.getByText('R2.F-003 · major · Semantic inventory')).toBeDefined();
  fireEvent.change(screen.getByLabelText('Additional repair guidance'), {
    target: { value: 'Preserve the frozen baseline.' },
  });
  fireEvent.change(screen.getByLabelText('Follow-up remediation rounds'), {
    target: { value: '4' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Delegate fixes to owning slice' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('form', { name: 'Delegate source fixes' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh source recovery' }));
  await screen.findByRole('button', { name: 'Delegate fixes to owning slice' });
  expect((screen.getByLabelText('Additional repair guidance') as HTMLTextAreaElement).value).toBe(
    'Preserve the frozen baseline.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delegate fixes to owning slice' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(delegateScopeRepair).toHaveBeenLastCalledWith(
    cycle,
    {
      expectedVersion: 5,
      snapshotDigest: preview.snapshotDigest,
      sourceId: scope.sourceId,
      instructions: 'Preserve the frozen baseline.',
      maxRemediationRounds: 4,
    },
    'csrf',
  );
});
it('opens an existing repair instead of offering duplicate delegation', async () => {
  vi.mocked(previewScopeRepair).mockResolvedValue({
    ...preview,
    candidates: [{ ...preview.candidates[0]!, cycleId: 'repair', worktreeId: 'tree' as never }],
  });
  const { onOpen } = panel();
  fireEvent.click(await screen.findByRole('button', { name: 'Open existing slice repair cycle' }));
  expect(onOpen).toHaveBeenCalledWith('tree');
  expect(screen.queryByRole('button', { name: 'Delegate fixes to owning slice' })).toBeNull();
});
it('offers retry when preview loading fails and blocks delegation on current phase requirements', async () => {
  vi.mocked(previewScopeRepair)
    .mockRejectedValueOnce(new Error('Could not load'))
    .mockResolvedValueOnce({
      ...preview,
      candidates: [{ ...preview.candidates[0]!, blockers: ['Wait for the running review.'] }],
    });
  panel();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh source recovery' }));
  await screen.findByText('Wait for the running review.');
  expect(
    (screen.getByRole('button', { name: 'Delegate fixes to owning slice' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.submit(screen.getByRole('form', { name: 'Delegate source fixes' }));
  expect(delegateScopeRepair).not.toHaveBeenCalled();
});
// Whether a claimed stop needs the operator is the daemon's attention items (R-A5); the
// server's notification tests cover that a claimed stop opens no item.
it('keeps a claimed stop\u2019s historical reason unchanged', () => {
  // The daemon declares that prerequisite work claims this stop (R-A3).
  const waiting = {
    ...cycle,
    id: 'parent',
    reason: 'Old policy question',
    scopeReviewWait: 'Waiting for prerequisite work: verify repaired slice.',
    attention: cycleAttention('scope-review-recovery', undefined, {
      claim: 'prerequisite-work',
      detail: 'Waiting for prerequisite work: verify repaired slice.',
    }),
  };
  expect(waiting.attention.owner).toBe('controller');
  expect(waiting.reason).toBe('Old policy question');
});

it('preserves expanded findings and draft guidance through slow, failed and newer background previews', async () => {
  vi.mocked(previewScopeRepair).mockResolvedValue(preview);
  const props = {
    cycle,
    disabled: false,
    csrfToken: 'csrf',
    refreshToken: 0,
    onStarted: vi.fn(),
    onOpen: vi.fn(),
  };
  const { rerender } = render(<ScopeRepair {...props} />);
  const finding = await screen.findByText('R2.F-003 · major · Semantic inventory');
  const disclosure = finding.closest('details')!;
  disclosure.open = true;
  fireEvent.change(screen.getByLabelText('Additional repair guidance'), {
    target: { value: 'Keep this draft.' },
  });
  let reject!: (e: Error) => void;
  vi.mocked(previewScopeRepair).mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  rerender(<ScopeRepair {...props} refreshToken={1} cycle={{ ...cycle, version: 6 }} />);
  await screen.findByText('Refreshing source recovery… Existing findings remain visible.');
  expect(screen.getByText('R2.F-003 · major · Semantic inventory').closest('details')).toBe(
    disclosure,
  );
  expect(disclosure.open).toBe(true);
  fireEvent.submit(screen.getByRole('form', { name: 'Delegate source fixes' }));
  expect(delegateScopeRepair).not.toHaveBeenCalled();
  await act(async () => reject(new Error('Temporary refresh failure')));
  await screen.findByRole('alert');
  expect(disclosure.open).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Delegate fixes to owning slice' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  vi.mocked(previewScopeRepair).mockResolvedValue({ ...preview, cycleVersion: 6 });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh source recovery' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Delegate fixes to owning slice' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(screen.getByText('R2.F-003 · major · Semantic inventory').closest('details')).toBe(
    disclosure,
  );
  expect(disclosure.open).toBe(true);
  expect((screen.getByLabelText('Additional repair guidance') as HTMLTextAreaElement).value).toBe(
    'Keep this draft.',
  );
});
