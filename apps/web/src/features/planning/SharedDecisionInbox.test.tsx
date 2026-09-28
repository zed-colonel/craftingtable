import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArchitectureDecisionInbox, RuntimeEvidenceView } from '@craftingtable/contracts';
import { asUserId, asWorkspaceId } from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { SharedDecisionInbox } from './SharedDecisionInbox.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
export const decisionInbox: ArchitectureDecisionInbox = {
  workspaceId: 'ws',
  definitionId: '00000000-0000-4000-8000-000000000001',
  bindingRevision: 4,
  blockers: [],
  decisions: [
    {
      checkpointId: 'LOCAL-ADR-012',
      title: 'Provider identity policy',
      requirements: ['Approve identity policy'],
      blockers: [],
      sourceReferences: 'Exact bound plan §4; source design digest retained.',
      consumers: [
        { sliceId: 'local/WI-03/domain', phase: 'merge' },
        { sliceId: 'local/WI-03/integration', phase: 'merge' },
      ],
      records: [],
      recommendation: {
        sourceRunId: '00000000-0000-4000-8000-000000000002',
        sourceReportDigest: 'a'.repeat(64),
        workItemId: 'item',
        sliceId: 'local/WI-03/domain',
        question: 'Approve provider identity policy?',
        answer: 'Recommend stable identity.',
        sources: ['plan.md §4'],
        brief: {
          checkpointId: 'LOCAL-ADR-012',
          decisionText: 'Use stable provider identities.',
          why: 'Safe replay.',
          alternatives: [
            { option: 'Ephemeral identities', tradeoff: 'Duplicate delivery on replay' },
          ],
          consequences: 'Independent tests remain required.',
          coverage: 'full',
          consumers: [],
          retainedObligations: 'Independent implementation tests remain required.',
        },
      },
    },
  ],
};
export const decisionRecord: ArchitectureDecisionInbox['decisions'][number]['records'][number] = {
  id: '00000000-0000-4000-8000-000000000003',
  applicable: true,
  issues: [],
  proposal: {
    kind: 'architecture-decision-v1',
    bindingDigest: 'b'.repeat(64),
    coverage: 'full',
    proposal: 'Use stable provider identities.',
    sourceReferences: decisionInbox.decisions[0]!.sourceReferences,
    consumers: [],
    retainedObligations: 'Independent implementation tests remain required.',
  },
};
const view = (inbox: ArchitectureDecisionInbox) =>
  ({ decisionInbox: inbox }) as RuntimeEvidenceView;
const withRecord = (record = decisionRecord): ArchitectureDecisionInbox => ({
  ...decisionInbox,
  decisions: [{ ...decisionInbox.decisions[0]!, records: [record] }],
});
it('collects references, reviews an immutable proposal, and requires explicit approval before sharing it', async () => {
  const approved = {
    ...decisionRecord,
    decision: {
      id: 'approval',
      workspaceId: asWorkspaceId('ws'),
      submissionId: decisionRecord.id,
      outcome: 'accepted' as const,
      rationale: 'Fits replay needs.',
      decidedAt: '2026-09-20T00:00:00Z',
      decidedByUserId: asUserId('owner'),
    },
  };
  vi.mocked(request)
    .mockResolvedValueOnce(view(withRecord()))
    .mockResolvedValueOnce(view(withRecord(approved)));
  function Harness() {
    const [data, setData] = useState(decisionInbox);
    return (
      <SharedDecisionInbox
        data={data}
        csrfToken="csrf"
        disabled={false}
        onChanged={(v) => setData(v.decisionInbox!)}
      />
    );
  }
  render(<Harness />);
  expect(screen.getByText('Needs your decision')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Review recommendation' }));
  expect((screen.getByLabelText('Decision to approve') as HTMLTextAreaElement).value).toBe(
    'Use stable provider identities.',
  );
  expect(screen.queryByRole('textbox', { name: /source/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save decision for approval' }));
  const approve = (await screen.findByRole('button', {
    name: 'Approve decision',
  })) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  const body = JSON.parse(vi.mocked(request).mock.calls[0]![2]!.body as string);
  expect(body).toMatchObject({
    sourceReferences: decisionInbox.decisions[0]!.sourceReferences,
    sourceReportDigest: 'a'.repeat(64),
    coverage: 'full',
    retainedObligations: 'Independent implementation tests remain required.',
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this exact decision/ }));
  fireEvent.change(screen.getByLabelText('Approval rationale'), {
    target: { value: 'Fits replay needs.' },
  });
  fireEvent.click(approve);
  await screen.findByText('Accepted · full architectural decision');
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(request).mock.calls[1]![0]).toMatch(/\/decide$/);
  expect(JSON.parse(vi.mocked(request).mock.calls[1]![2]!.body as string)).toMatchObject({
    submissionId: decisionRecord.id,
    outcome: 'accepted',
  });
});
it('offers clarification for legacy reports without guessing their complete decision', () => {
  const onClarify = vi.fn();
  const legacy = {
    ...decisionInbox,
    decisions: [
      {
        ...decisionInbox.decisions[0]!,
        recommendation: { ...decisionInbox.decisions[0]!.recommendation!, brief: undefined },
      },
    ],
  };
  render(
    <SharedDecisionInbox
      data={legacy}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
      onClarify={onClarify}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Review recommendation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Request clarification' }));
  expect(onClarify).toHaveBeenCalledWith(expect.stringContaining('LOCAL-ADR-012'));
  expect(request).not.toHaveBeenCalled();
});
it('keeps edits across refresh and failure, and requires named limited scope', async () => {
  vi.mocked(request).mockRejectedValue(new Error('Refresh the binding.'));
  const props = { data: decisionInbox, csrfToken: 'csrf', disabled: false, onChanged: vi.fn() };
  const { rerender } = render(<SharedDecisionInbox {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve a limited scope' }));
  fireEvent.change(screen.getByLabelText('Decision to approve'), {
    target: { value: 'Settle identifiers only.' },
  });
  const save = screen.getByRole('button', {
    name: 'Save decision for approval',
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Full obligations retained for later work'), {
    target: { value: 'Keep transport for integration.' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'local/WI-03/domain · before merge' }));
  fireEvent.click(save);
  await screen.findByText('Refresh the binding.');
  rerender(<SharedDecisionInbox {...props} data={{ ...decisionInbox }} />);
  expect((screen.getByLabelText('Decision to approve') as HTMLTextAreaElement).value).toBe(
    'Settle identifiers only.',
  );
  await waitFor(() => expect(save.disabled).toBe(false));
  expect(JSON.parse(vi.mocked(request).mock.calls[0]![2]!.body as string)).toMatchObject({
    coverage: 'clauses',
    consumers: [{ sliceId: 'local/WI-03/domain', phase: 'merge', replacesFullCheckpoint: true }],
    retainedObligations: 'Keep transport for integration.',
  });
});
it('shows limited approval separately and keeps live scheduling blockers beside disabled approval', () => {
  const limited = {
    ...decisionRecord,
    proposal: {
      ...decisionRecord.proposal,
      coverage: 'clauses' as const,
      consumers: [
        { sliceId: 'local/WI-03/domain', phase: 'merge' as const, replacesFullCheckpoint: true },
      ],
      retainedObligations: 'Transport remains required.',
    },
    decision: {
      id: 'approval',
      workspaceId: asWorkspaceId('ws'),
      submissionId: decisionRecord.id,
      outcome: 'accepted' as const,
      rationale: 'Identifiers only.',
      decidedAt: '2026-09-20T00:00:00Z',
      decidedByUserId: asUserId('owner'),
    },
  };
  const data = {
    ...withRecord(limited),
    blockers: ['Pause roadmap scheduling before approving decisions.'],
  };
  render(<SharedDecisionInbox data={data} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />);
  expect(screen.getByText('Accepted · limited to named slices')).toBeTruthy();
  expect(screen.getByText(/Approval unavailable: Pause roadmap/)).toBeTruthy();
});

it('keeps investigation evidence accessible when its structured recommendation is invalid', () => {
  const data: ArchitectureDecisionInbox = {
    ...decisionInbox,
    decisions: [
      {
        ...decisionInbox.decisions[0]!,
        recommendation: {
          ...decisionInbox.decisions[0]!.recommendation!,
          brief: undefined,
          investigation: true,
          classificationIssue: 'items.0.decision: invalid coverage',
        },
      },
    ],
  };
  render(<SharedDecisionInbox data={data} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />);
  expect(screen.getByText('Evidence investigation available')).toBeTruthy();
  expect(screen.getByText('Investigation results and evidence')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('invalid coverage');
  expect(screen.queryByRole('button', { name: 'Review recommendation' })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
it('approves several saved decisions in one pause, each reviewed, with one rationale (R-C3b)', async () => {
  const second: ArchitectureDecisionInbox['decisions'][number] = {
    ...decisionInbox.decisions[0]!,
    checkpointId: 'LOCAL-ADR-013',
    title: 'Retry ownership',
    records: [
      {
        ...decisionRecord,
        id: '00000000-0000-4000-8000-000000000004',
        proposal: { ...decisionRecord.proposal, proposal: 'The queue owns retries.' },
      },
    ],
  };
  const pending: ArchitectureDecisionInbox = {
    ...decisionInbox,
    decisions: [{ ...decisionInbox.decisions[0]!, records: [decisionRecord] }, second],
  };
  vi.mocked(request).mockResolvedValue(view(pending));
  const onChanged = vi.fn();
  render(
    <SharedDecisionInbox data={pending} csrfToken="csrf" disabled={false} onChanged={onChanged} />,
  );
  const batch = screen.getByRole('region', { name: 'Approve saved decisions' });
  const approve = within(batch).getByRole('button', {
    name: 'Approve reviewed decisions',
  }) as HTMLButtonElement;
  // Each decision is reviewed on its own; nothing is approved without a rationale.
  expect(approve.disabled).toBe(true);
  fireEvent.click(within(batch).getByRole('checkbox', { name: /LOCAL-ADR-012/ }));
  fireEvent.click(within(batch).getByRole('checkbox', { name: /LOCAL-ADR-013/ }));
  expect(approve.disabled).toBe(true);
  fireEvent.change(within(batch).getByLabelText('Approval rationale for the batch'), {
    target: { value: 'Both fit the plan.' },
  });
  fireEvent.click(approve);
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const decided = vi
    .mocked(request)
    .mock.calls.filter(([url]) => String(url).endsWith('/decide'))
    .map(([, , init]) => JSON.parse(String((init as RequestInit).body)));
  expect(decided).toEqual([
    { submissionId: decisionRecord.id, outcome: 'accepted', rationale: 'Both fit the plan.' },
    {
      submissionId: '00000000-0000-4000-8000-000000000004',
      outcome: 'accepted',
      rationale: 'Both fit the plan.',
    },
  ]);
});
it('offers no batch approval while scheduling runs (R-C3b)', () => {
  const blocked: ArchitectureDecisionInbox = {
    ...decisionInbox,
    blockers: ['Pause roadmap scheduling before approving decisions.'],
    decisions: [
      { ...decisionInbox.decisions[0]!, records: [decisionRecord] },
      {
        ...decisionInbox.decisions[0]!,
        checkpointId: 'LOCAL-ADR-013',
        records: [{ ...decisionRecord, id: '00000000-0000-4000-8000-000000000004' }],
      },
    ],
  };
  render(
    <SharedDecisionInbox data={blocked} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />,
  );
  const batch = screen.getByRole('region', { name: 'Approve saved decisions' });
  expect(
    (within(batch).getByRole('checkbox', { name: /LOCAL-ADR-012/ }) as HTMLInputElement).disabled,
  ).toBe(true);
});
