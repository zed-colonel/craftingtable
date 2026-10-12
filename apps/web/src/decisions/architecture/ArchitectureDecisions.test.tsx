import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArchitectureDecisionInbox, RuntimeEvidenceView } from '@craftingtable/contracts';
import {
  asCheckpointId,
  asEvidenceSubmissionId,
  asSliceId,
  asUserId,
  asWorkspaceId,
} from '@craftingtable/domain';
import { request } from '../../lib/api-client.js';
import { ArchitectureDecisions } from './ArchitectureDecisions.js';

/** The setup step's list over one decision inbox, as the trio's tests rendered it (R-A6 rest). */
function SharedDecisions({
  data,
  preparation,
  ...rest
}: {
  data: ArchitectureDecisionInbox;
  csrfToken: string;
  disabled: boolean;
  onChanged: (view: RuntimeEvidenceView) => void | Promise<void>;
  preparation?: { readonly workspaceId: string; readonly roadmapId: string };
}) {
  return (
    <ArchitectureDecisions
      workspaceId={asWorkspaceId(data.workspaceId)}
      definitionId={data.definitionId}
      view={{ decisionInbox: data, bindingRevision: data.bindingRevision } as RuntimeEvidenceView}
      roadmapId={preparation?.roadmapId}
      {...rest}
    />
  );
}
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
          checkpointId: asCheckpointId('LOCAL-ADR-012'),
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
      submissionId: asEvidenceSubmissionId(decisionRecord.id),
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
      <SharedDecisions
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
  // Source references are collected for the operator, editable only inside a closed disclosure.
  const references = screen.getByRole('textbox', {
    name: 'Source clauses and affected schemas or protocols',
  }) as HTMLTextAreaElement;
  expect(references.value).toBe(decisionInbox.decisions[0]!.sourceReferences);
  expect(references.closest('details')?.open).toBe(false);
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
  const legacy = {
    ...decisionInbox,
    decisions: [
      {
        ...decisionInbox.decisions[0]!,
        recommendation: { ...decisionInbox.decisions[0]!.recommendation!, brief: undefined },
      },
    ],
  };
  render(<SharedDecisions data={legacy} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Review recommendation' })).toBeNull();
  // Clarification is asked for in the design's own recovery, where its guidance is drafted.
  expect(
    screen
      .getByRole('link', { name: 'Request clarification in design recovery' })
      .getAttribute('href'),
  ).toBe('/workspaces/ws/work-items/item#clarify-architecture-LOCAL-ADR-012');
  expect(request).not.toHaveBeenCalled();
});
it('keeps edits across refresh and failure, and requires named limited scope', async () => {
  vi.mocked(request).mockRejectedValue(new Error('Refresh the binding.'));
  const props = { data: decisionInbox, csrfToken: 'csrf', disabled: false, onChanged: vi.fn() };
  const { rerender } = render(<SharedDecisions {...props} />);
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
  rerender(<SharedDecisions {...props} data={{ ...decisionInbox }} />);
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
        {
          sliceId: asSliceId('local/WI-03/domain'),
          phase: 'merge' as const,
          replacesFullCheckpoint: true,
        },
      ],
      retainedObligations: 'Transport remains required.',
    },
    decision: {
      id: 'approval',
      workspaceId: asWorkspaceId('ws'),
      submissionId: asEvidenceSubmissionId(decisionRecord.id),
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
  render(<SharedDecisions data={data} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />);
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
  render(<SharedDecisions data={data} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />);
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
    <SharedDecisions data={pending} csrfToken="csrf" disabled={false} onChanged={onChanged} />,
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
  render(<SharedDecisions data={blocked} csrfToken="csrf" disabled={false} onChanged={vi.fn()} />);
  const batch = screen.getByRole('region', { name: 'Approve saved decisions' });
  expect(
    (within(batch).getByRole('checkbox', { name: /LOCAL-ADR-012/ }) as HTMLInputElement).disabled,
  ).toBe(true);
});
it('approves only the proposals ticked as reviewed, lists none with issues, and stops at a refusal (R-C3b review)', async () => {
  const record = (id: string, proposal: string) => ({
    ...decisionRecord,
    id,
    proposal: { ...decisionRecord.proposal, proposal },
  });
  const card = (
    checkpointId: string,
    records: ArchitectureDecisionInbox['decisions'][number]['records'],
  ) => ({
    ...decisionInbox.decisions[0]!,
    checkpointId,
    records,
  });
  const inbox: ArchitectureDecisionInbox = {
    ...decisionInbox,
    decisions: [
      card('LOCAL-ADR-012', [record('00000000-0000-4000-8000-000000000011', 'First.')]),
      card('LOCAL-ADR-013', [record('00000000-0000-4000-8000-000000000012', 'Second.')]),
      card('LOCAL-ADR-014', [record('00000000-0000-4000-8000-000000000013', 'Third.')]),
      card('LOCAL-ADR-015', [
        { ...record('00000000-0000-4000-8000-000000000014', 'Flawed.'), issues: ['Stale digest'] },
      ]),
    ],
  };
  vi.mocked(request)
    .mockResolvedValueOnce(view(inbox))
    .mockRejectedValueOnce(new Error('Pause roadmap scheduling before approving.'));
  const onChanged = vi.fn();
  render(<SharedDecisions data={inbox} csrfToken="csrf" disabled={false} onChanged={onChanged} />);
  const batch = screen.getByRole('region', { name: 'Approve saved decisions' });
  expect(within(batch).queryByRole('checkbox', { name: /LOCAL-ADR-015/ })).toBeNull();
  fireEvent.click(within(batch).getByRole('checkbox', { name: /LOCAL-ADR-012/ }));
  fireEvent.click(within(batch).getByRole('checkbox', { name: /LOCAL-ADR-014/ }));
  fireEvent.change(within(batch).getByLabelText('Approval rationale for the batch'), {
    target: { value: 'Reviewed.' },
  });
  fireEvent.click(within(batch).getByRole('button', { name: 'Approve reviewed decisions' }));
  await within(batch).findByText(/Approved LOCAL-ADR-012; stopped: Pause roadmap scheduling/);
  const sent = vi
    .mocked(request)
    .mock.calls.filter(([url]) => String(url).endsWith('/decide'))
    .map(([, , init]) => JSON.parse(String((init as RequestInit).body)).submissionId);
  // LOCAL-ADR-013 was not ticked; LOCAL-ADR-014 was refused, so nothing after it runs.
  expect(sent).toEqual([
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000013',
  ]);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it('gives a decision a stopped slice waits on a card and a one-step brief before any exists (LIVE-18)', async () => {
  const card = {
    ...decisionInbox.decisions[0]!,
    checkpointId: 'EXO-ADR-022',
    title: 'External persona',
    stoppedSlices: ['exo/EXO-18/instance-design'],
  };
  delete (card as { recommendation?: unknown }).recommendation;
  vi.mocked(request).mockImplementation(
    async (path: string, _schema: unknown, init?: RequestInit) => {
      if (path.endsWith('/decision-preparations'))
        return {
          version: 7,
          status: 'paused',
          decisions: [
            {
              id: 'EXO-ADR-022',
              title: 'External persona',
              profile: { backend: 'codex', model: 'gpt-6-sol' },
            },
          ],
        };
      if (path.endsWith('/prepare-decision')) return JSON.parse(String(init?.body));
      throw new Error(`unexpected ${path}`);
    },
  );
  render(
    <SharedDecisions
      data={{ ...decisionInbox, decisions: [card] }}
      csrfToken="csrf"
      disabled={false}
      onChanged={() => undefined}
      preparation={{ workspaceId: asWorkspaceId('ws'), roadmapId: 'roadmap-1' }}
    />,
  );
  const region = screen.getByRole('region', { name: 'EXO-ADR-022' });
  expect(within(region).getByText('Needed now by exo/EXO-18/instance-design.')).toBeTruthy();
  const prepare = within(region).getByRole('button', { name: 'Prepare decision brief' });
  await waitFor(() => expect((prepare as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(prepare);
  await waitFor(() =>
    expect(vi.mocked(request)).toHaveBeenCalledWith(
      '/api/workspaces/ws/roadmaps/roadmap-1/prepare-decision',
      expect.anything(),
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const call = vi
    .mocked(request)
    .mock.calls.find(([path]) => String(path).endsWith('/prepare-decision'))!;
  expect(JSON.parse(String(call[2]?.body))).toEqual({
    expectedVersion: 7,
    checkpointId: 'EXO-ADR-022',
    profile: { backend: 'codex', model: 'gpt-6-sol' },
    minutes: 30,
    instructions: '',
  });
});

const accepted = (record: typeof decisionRecord) => ({
  ...record,
  decision: {
    id: 'approval',
    workspaceId: asWorkspaceId('ws'),
    submissionId: asEvidenceSubmissionId(record.id),
    outcome: 'accepted' as const,
    rationale: 'Approved.',
    decidedAt: '2026-09-20T00:00:00Z',
    decidedByUserId: asUserId('owner'),
  },
});
const preparations = (version: () => number, status?: string) =>
  vi.mocked(request).mockImplementation(async (path: string, _s: unknown, init?: RequestInit) => {
    if (path.endsWith('/decision-preparations'))
      return {
        version: version(),
        status: 'paused',
        decisions: [
          {
            id: 'EXO-ADR-037',
            title: 'Instance design',
            profile: { backend: 'codex' },
            ...(status
              ? {
                  latest: {
                    runId: '00000000-0000-4000-8000-00000000000a',
                    status,
                    summary: '',
                    createdAt: '2026-09-29T00:00:00Z',
                  },
                }
              : {}),
          },
        ],
      };
    if (path.endsWith('/prepare-decision')) {
      const body = JSON.parse(String(init?.body));
      if (body.expectedVersion !== version())
        throw new Error('Roadmap changed. Refresh before preparing a decision.');
      return body;
    }
    throw new Error(`unexpected ${path}`);
  });
const stoppedCard = (records: (typeof decisionRecord)[], withRecommendation = false) => {
  const card = {
    ...decisionInbox.decisions[0]!,
    checkpointId: 'EXO-ADR-037',
    title: 'Instance design',
    stoppedSlices: ['exo/EXO-18/instance-design'],
    records,
  };
  if (!withRecommendation) delete (card as { recommendation?: unknown }).recommendation;
  else card.recommendation = { ...card.recommendation!, brief: undefined } as never;
  return { ...decisionInbox, decisions: [card] };
};
const renderStopped = (data: ArchitectureDecisionInbox) =>
  render(
    <SharedDecisions
      data={data}
      csrfToken="csrf"
      disabled={false}
      onChanged={() => undefined}
      preparation={{ workspaceId: asWorkspaceId('ws'), roadmapId: 'roadmap-1' }}
    />,
  );

it('does not call a decision settled for a stopped slice by another slice’s clause approval (LIVE-18 review)', async () => {
  preparations(() => 3);
  const otherSlice = accepted({
    ...decisionRecord,
    proposal: {
      ...decisionRecord.proposal,
      coverage: 'clauses',
      consumers: [
        { sliceId: asSliceId('exo/EXO-03/domain'), phase: 'merge', replacesFullCheckpoint: true },
      ],
    },
  });
  renderStopped(stoppedCard([otherSlice]));
  const region = screen.getByRole('region', { name: 'EXO-ADR-037' });
  expect(within(region).getByText('Needed now by exo/EXO-18/instance-design.')).toBeTruthy();
  expect(within(region).queryByText(/^Accepted/)).toBeNull();
  expect(within(region).getByRole('button', { name: 'Prepare decision brief' })).toBeTruthy();
});

it('offers a brief when a reviewer asked for the decision but none was written (LIVE-18 review)', () => {
  preparations(() => 3);
  renderStopped(stoppedCard([], true));
  expect(screen.getByRole('button', { name: 'Prepare decision brief' })).toBeTruthy();
});

it('prepares against the roadmap as it is when clicked, and waits while one is in flight (LIVE-18 review)', async () => {
  // Another card's preparation moved the roadmap's version after this card loaded.
  let version = 3;
  preparations(() => version);
  renderStopped(stoppedCard([]));
  const prepare = screen.getByRole('button', { name: 'Prepare decision brief' });
  await waitFor(() => expect((prepare as HTMLButtonElement).disabled).toBe(false));
  version = 4;
  fireEvent.click(prepare);
  await waitFor(() => expect(screen.getByText(/Preparation started/)).toBeTruthy());
  cleanup();
  preparations(() => 4, 'running');
  renderStopped(stoppedCard([]));
  await screen.findByText('Preparing · running');
  expect(
    (screen.getByRole('button', { name: 'Prepare decision brief' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('says which slices a clause approval settles a decision for and which still need it (LIVE-22)', async () => {
  preparations(() => 3);
  const settled = ['exo/EXO-03/domain', 'exo/EXO-18/instance-design'];
  const still = [
    'exo/EXO-03/integration',
    'exo/EXO-18/domain',
    'exo/EXO-18/instance-qualification',
    'exo/EXO-18/integration',
  ];
  const clauses = accepted({
    ...decisionRecord,
    proposal: {
      ...decisionRecord.proposal,
      coverage: 'clauses',
      consumers: settled.map((sliceId) => ({
        sliceId: asSliceId(sliceId),
        phase: 'merge' as const,
        replacesFullCheckpoint: true,
      })),
    },
  });
  const data = stoppedCard([clauses]);
  const card = data.decisions[0]!;
  delete (card as { stoppedSlices?: unknown }).stoppedSlices;
  renderStopped({ ...data, decisions: [{ ...card, settledFor: settled, stillNeededBy: still }] });
  const region = screen.getByRole('region', { name: 'EXO-ADR-037' });
  expect(within(region).getByText('Accepted for 2 named slices · still needed by 4')).toBeTruthy();
  expect(within(region).getByText(`Settled for: ${settled.join(', ')}.`)).toBeTruthy();
  expect(within(region).getByText(`Still needed by: ${still.join(', ')}.`)).toBeTruthy();
  // The remaining slices need a decision, so a brief can be prepared for them.
  expect(within(region).getByRole('button', { name: 'Prepare decision brief' })).toBeTruthy();
});

it('offers a new brief when the only brief was limited to the slices already settled, and nothing more once accepted in full (LIVE-22 review)', async () => {
  preparations(() => 3);
  const settled = ['exo/EXO-18/instance-design'];
  const still = ['exo/EXO-18/domain'];
  const limited = {
    ...decisionRecord.proposal,
    coverage: 'clauses' as const,
    consumers: settled.map((sliceId) => ({
      sliceId: asSliceId(sliceId),
      phase: 'merge' as const,
      replacesFullCheckpoint: true,
    })),
  };
  const data = stoppedCard([accepted({ ...decisionRecord, proposal: limited })], true);
  const card = data.decisions[0]!;
  delete (card as { stoppedSlices?: unknown }).stoppedSlices;
  const recommendation = {
    ...card.recommendation!,
    brief: {
      checkpointId: asCheckpointId('EXO-ADR-037'),
      decisionText: 'Limited to the instance design.',
      why: 'Only that slice asked.',
      alternatives: [],
      consequences: 'None yet.',
      coverage: 'clauses' as const,
      consumers: limited.consumers,
      retainedObligations: '',
    },
  };
  const { unmount } = renderStopped({
    ...data,
    decisions: [{ ...card, recommendation, settledFor: settled, stillNeededBy: still }],
  });
  let region = screen.getByRole('region', { name: 'EXO-ADR-037' });
  expect(within(region).getByText('Accepted for 1 named slice · still needed by 1')).toBeTruthy();
  expect(within(region).getByRole('button', { name: 'Prepare decision brief' })).toBeTruthy();
  unmount();
  // Accepted in full: nothing is still needed, whatever the card carried.
  renderStopped({
    ...data,
    decisions: [
      {
        ...card,
        records: [accepted(decisionRecord)],
        settledFor: settled,
        stillNeededBy: still,
      },
    ],
  });
  region = screen.getByRole('region', { name: 'EXO-ADR-037' });
  expect(within(region).getByText('Accepted · full architectural decision')).toBeTruthy();
  expect(within(region).queryByText(/Still needed by/)).toBeNull();
  expect(within(region).queryByRole('button', { name: 'Prepare decision brief' })).toBeNull();
});

// ---- Authoring folded in from the deleted advanced form (R-A6 review M5) ------------------
const reportRun = '00000000-0000-4000-8000-000000000009';
/** A view whose map declares a second decision no card lists yet, and slices beyond its own. */
const authoringView = (inbox = decisionInbox) =>
  ({
    decisionInbox: inbox,
    bindingRevision: inbox.bindingRevision,
    architectureDecisions: {
      checkpoints: [
        {
          id: 'LOCAL-ADR-012',
          title: 'Provider identity policy',
          requirements: [],
          sourceReferences: 'Exact bound plan §4; source design digest retained.',
        },
        {
          id: 'LOCAL-ADR-099',
          title: 'Unlisted transport',
          requirements: ['Choose a transport'],
          sourceReferences: '{"id":"LOCAL-ADR-099"}',
        },
      ],
      slices: [
        { id: 'local/WI-03/domain', title: 'Domain', checkpoints: ['LOCAL-ADR-012'] },
        { id: 'local/WI-04/domain', title: 'Holds it', checkpoints: ['LOCAL-ADR-012'] },
        { id: 'local/WI-05/domain', title: 'Does not', checkpoints: [] },
      ],
      designRuns: [
        {
          id: reportRun,
          checkpointIds: ['LOCAL-ADR-012'],
          title: 'Design run',
          report: 'Another report.',
        },
      ],
    },
  }) as unknown as RuntimeEvidenceView;
const proposals = () =>
  vi
    .mocked(request)
    .mock.calls.filter(([path]) => String(path).endsWith('/propose-decision'))
    .map(([, , init]) => JSON.parse(String(init?.body)));
function renderList(view = authoringView()) {
  return render(
    <ArchitectureDecisions
      workspaceId={asWorkspaceId('ws')}
      definitionId={decisionInbox.definitionId}
      view={view}
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
}

it('opens an unlisted decision by name and writes it on its own card, with its references', async () => {
  vi.mocked(request).mockResolvedValue(authoringView());
  renderList();
  const picker = screen.getByRole('combobox', { name: 'Decision' });
  // Only decisions without a card are offered.
  expect([...(picker as HTMLSelectElement).options].map((o) => o.value)).toEqual([
    '',
    'LOCAL-ADR-099',
  ]);
  expect(screen.queryByRole('region', { name: 'LOCAL-ADR-099' })).toBeNull();
  fireEvent.change(picker, { target: { value: 'LOCAL-ADR-099' } });
  const card = screen.getByRole('region', { name: 'LOCAL-ADR-099' });
  within(card).getByText('Needs your decision');
  fireEvent.click(within(card).getByRole('button', { name: 'Approve with changes' }));
  fireEvent.change(within(card).getByLabelText('Decision to approve'), {
    target: { value: 'Use a queue.' },
  });
  fireEvent.click(within(card).getByRole('button', { name: 'Save decision for approval' }));
  await waitFor(() => expect(proposals()).toHaveLength(1));
  expect(proposals()[0]).toMatchObject({
    checkpointId: 'LOCAL-ADR-099',
    coverage: 'full',
    proposal: 'Use a queue.',
    sourceReferences: '{"id":"LOCAL-ADR-099"}',
  });
  expect(proposals()[0]).not.toHaveProperty('sourceRunId');
});

it('stages clauses for any slice of the map, at the phase chosen, replacing a full requirement only where the slice holds it', async () => {
  vi.mocked(request).mockResolvedValue(authoringView());
  renderList();
  const card = screen.getByRole('region', { name: 'LOCAL-ADR-012' });
  fireEvent.click(within(card).getByRole('button', { name: 'Approve a limited scope' }));
  fireEvent.change(within(card).getByLabelText('Decision to approve'), {
    target: { value: 'Settle identifiers only.' },
  });
  fireEvent.change(within(card).getByLabelText('Full obligations retained for later work'), {
    target: { value: 'The full policy stays required.' },
  });
  const add = within(card).getByRole('combobox', { name: 'Add another slice' });
  // The decision's own consumers are listed already; the others can be added.
  expect([...(add as HTMLSelectElement).options].map((o) => o.value)).toEqual([
    '',
    'local/WI-04/domain',
    'local/WI-05/domain',
  ]);
  fireEvent.change(add, { target: { value: 'local/WI-04/domain' } });
  fireEvent.change(add, { target: { value: 'local/WI-05/domain' } });
  fireEvent.change(within(card).getByLabelText('Required before (local/WI-05/domain)'), {
    target: { value: 'start' },
  });
  fireEvent.click(within(card).getByRole('button', { name: 'Save decision for approval' }));
  await waitFor(() => expect(proposals()).toHaveLength(1));
  expect(proposals()[0].consumers).toEqual([
    { sliceId: 'local/WI-04/domain', phase: 'merge', replacesFullCheckpoint: true },
    { sliceId: 'local/WI-05/domain', phase: 'start', replacesFullCheckpoint: false },
  ]);
});

it("attaches the source report chosen: the recommendation's with its digest, another run's without one, or none", async () => {
  vi.mocked(request).mockResolvedValue(authoringView());
  renderList();
  const card = screen.getByRole('region', { name: 'LOCAL-ADR-012' });
  const save = async (value: string) => {
    const before = proposals().length;
    fireEvent.click(within(card).getByRole('button', { name: 'Approve with changes' }));
    fireEvent.change(within(card).getByLabelText('Source report'), { target: { value } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save decision for approval' }));
    await waitFor(() => expect(proposals()).toHaveLength(before + 1));
    // The mock's view records nothing, so the editor stays: close it for the next choice.
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
  };
  const recommendation = decisionInbox.decisions[0]!.recommendation!;
  await save(recommendation.sourceRunId);
  await save(reportRun);
  await save('');
  expect(proposals().map((p) => [p.sourceRunId, p.sourceReportDigest])).toEqual([
    [recommendation.sourceRunId, recommendation.sourceReportDigest],
    [reportRun, undefined],
    [undefined, undefined],
  ]);
});

it('offers a fresh preparation of a decision that already has a brief, only when asked (R-A6 review M4)', async () => {
  vi.mocked(request).mockImplementation(async (path: string) =>
    String(path).endsWith('/decision-preparations')
      ? {
          version: 3,
          status: 'paused',
          decisions: [{ id: 'LOCAL-ADR-012', title: 'Policy', profile: { backend: 'codex' } }],
        }
      : { backends: [] },
  );
  render(
    <ArchitectureDecisions
      workspaceId={asWorkspaceId('ws')}
      definitionId={decisionInbox.definitionId}
      view={authoringView()}
      roadmapId="roadmap-1"
      csrfToken="csrf"
      disabled={false}
      onChanged={vi.fn()}
    />,
  );
  const card = screen.getByRole('region', { name: 'LOCAL-ADR-012' });
  // The card has a brief, so preparation waits behind a disclosure, and reads nothing yet.
  expect(within(card).queryByRole('button', { name: 'Prepare decision brief' })).toBeNull();
  expect(request).not.toHaveBeenCalled();
  const again = within(card).getByText('Prepare another brief').closest('details')!;
  again.open = true;
  fireEvent(again, new Event('toggle'));
  const prepare = await within(card).findByRole('button', { name: 'Prepare decision brief' });
  await waitFor(() => expect((prepare as HTMLButtonElement).disabled).toBe(false));
});

it('posts the source references as edited, refuses empty ones, and shows a chosen run’s report (re-check R2)', async () => {
  vi.mocked(request).mockResolvedValue(authoringView());
  renderList();
  const card = screen.getByRole('region', { name: 'LOCAL-ADR-012' });
  fireEvent.click(within(card).getByRole('button', { name: 'Approve with changes' }));
  // Another design run, chosen as the source report, can be read before it is attached.
  expect(within(card).queryByText('Another report.')).toBeNull();
  fireEvent.change(within(card).getByLabelText('Source report'), { target: { value: reportRun } });
  within(card).getByText('Another report.');
  const references = within(card).getByLabelText(
    'Source clauses and affected schemas or protocols',
  );
  const save = within(card).getByRole('button', { name: 'Save decision for approval' });
  fireEvent.change(references, { target: { value: '   ' } });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(references, { target: { value: 'plan §4 only' } });
  fireEvent.click(save);
  await waitFor(() => expect(proposals()).toHaveLength(1));
  expect(proposals()[0].sourceReferences).toBe('plan §4 only');
});
