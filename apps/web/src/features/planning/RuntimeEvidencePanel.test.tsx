import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { asWorkspaceId } from '@craftingtable/domain';
import { RuntimeEvidencePanel } from './RuntimeEvidencePanel.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const runtimeId = '12345678-1234-4234-8234-123456789abc';
const current = {
  id: runtimeId,
  generation: 1,
  pins: [],
  consumers: [],
  environments: [
    {
      id: 'kata-host',
      kind: 'external-kata',
      identityDigest: 'a'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      toolchainDigest: 'c'.repeat(64),
      authorization: 'Operator authorized.',
    },
  ],
};
const record = {
  id: 'evidence-1',
  subject: { kind: 'checkpoint', sourceId: 'QUALIFIED' },
  environmentId: 'kata-host',
  executedAt: '2026-09-16T00:00:00Z',
  executedBy: 'author',
  reviewers: [{ identity: 'reviewer', roles: ['independent-reviewer'] }],
  subjectCommit: 'd'.repeat(40),
  artifacts: [{ name: 'log', digest: 'e'.repeat(64), content: 'Actual Kata verification passed.' }],
};
/** The view lists a submission without its bodies (R-H4); the record is read on demand. */
function summary<T extends { artifacts: { name: string; digest: string; content: string }[] }>(
  full: T,
) {
  return {
    ...full,
    artifacts: full.artifacts.map(({ content, ...a }) => ({ ...a, bytes: content.length })),
  };
}
const submission = summary(record);
/** Answers each view read in turn (the last repeats), and each record read from `records`. */
function respond(views: unknown[], records: Record<string, unknown> = { [record.id]: record }) {
  vi.mocked(request).mockImplementation(async (url) => {
    const id = /\/submissions\/([^/]+)$/.exec(String(url))?.[1];
    if (id) return records[decodeURIComponent(id)];
    return views.length > 1 ? views.shift() : views[0];
  });
}
/** Opens a submission's review, as the operator's click does. */
function openReview(id: string) {
  const details = document.getElementById(`runtime-evidence-${runtimeId}-submission-${id}`);
  if (!(details instanceof HTMLDetailsElement)) throw new Error(`No review for ${id}`);
  details.open = true;
  fireEvent(details, new Event('toggle'));
}
const calls = (pattern: RegExp) =>
  vi.mocked(request).mock.calls.filter(([url]) => pattern.test(String(url)));
function view(issues: string[] = []) {
  return {
    issues: [],
    builds: [],
    bindingRevision: 1,
    current,
    history: [],
    repositories: [],
    subjects: [
      {
        subject: submission.subject,
        title: 'Qualification',
        profile: 'qualified',
        requirements: ['Tests passed'],
        reviewerRoles: ['independent-reviewer'],
        testedRepositories: ['consumer'],
        cases: [{ id: 'CASE-1', sourceRecordDigest: 'f'.repeat(64), requiresKata: true }],
        issues: [],
      },
    ],
    upstreamHistory: [],
    submissions: [{ submission, issues }],
  };
}
it('renders readable artifacts and requires a rationale before accepting evidence', async () => {
  respond([
    view(),
    {
      ...view(),
      submissions: [
        {
          submission,
          issues: [],
          decision: { outcome: 'accepted', rationale: 'Inspected independent logs.' },
        },
      ],
    },
  ]);
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  await screen.findByText('log');
  expect(screen.queryByText('Actual Kata verification passed.')).toBeNull();
  const accept = screen.getByRole('button', { name: 'Accept evidence', hidden: true });
  fireEvent.change(screen.getByLabelText('Review decision rationale'), {
    target: { value: 'Inspected independent logs.' },
  });
  // Accepting attests to the record, so it waits until the record has been shown.
  expect(accept.hasAttribute('disabled')).toBe(true);
  expect(calls(/submissions/)).toHaveLength(0);
  // Nothing loads, and nothing says so, until the review is opened.
  expect(screen.queryByText(/Loading the full record/)).toBeNull();
  openReview(record.id);
  await screen.findByText('Actual Kata verification passed.');
  expect(calls(/submissions/)[0]?.[0]).toMatch(/\/runtime\/submissions\/evidence-1$/);
  expect(accept.hasAttribute('disabled')).toBe(false);
  fireEvent.click(accept);
  await waitFor(() => expect(calls(/decide$/)).toHaveLength(1));
  const init = calls(/decide$/)[0]?.[2];
  expect(JSON.parse(String(init?.body))).toEqual({
    submissionId: 'evidence-1',
    outcome: 'accepted',
    rationale: 'Inspected independent logs.',
  });
  expect(init?.headers).toEqual({ 'x-craftingtable-csrf': 'csrf' });
});
it('attests to a plan only after its record has been shown (R-H4)', async () => {
  const plan = {
    ...record,
    id: 'plan-evidence',
    reviewers: [],
    generatedPlan: {
      kind: 'saved-plan-v1',
      roadmapId: runtimeId,
      definitionRevision: 1,
      snapshotDigest: 'a'.repeat(64),
    },
    artifacts: [{ name: 'saved-facts', digest: 'b'.repeat(64), content: 'Saved bindings.' }],
  };
  respond([{ ...view(), submissions: [{ submission: summary(plan), issues: [] }] }], {
    [plan.id]: plan,
  });
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  const reviewed = await screen.findByRole('checkbox', {
    name: /I reviewed the saved plan/,
    hidden: true,
  });
  expect(reviewed.hasAttribute('disabled')).toBe(true);
  openReview(plan.id);
  await screen.findByText('Saved bindings.');
  expect(reviewed.hasAttribute('disabled')).toBe(false);
});
it('shows stale evidence as blocked and generates a case-specific actual-Kata template', async () => {
  vi.mocked(request).mockResolvedValue(view(['The upstream pin changed.']));
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  await screen.findByText('The upstream pin changed.');
  fireEvent.change(screen.getByLabelText('Review decision rationale'), {
    target: { value: 'Still stale.' },
  });
  expect(
    screen.getByRole('button', { name: 'Accept evidence', hidden: true }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Evidence subject'), {
    target: { value: 'checkpoint:QUALIFIED' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare evidence template', hidden: true }));
  const text = screen.getByLabelText('Evidence package') as HTMLTextAreaElement;
  const template = JSON.parse(text.value);
  expect(template.runtimeId).toBe(runtimeId);
  expect(template.cases[0]).toMatchObject({ id: 'CASE-1', sourceRecordDigest: 'f'.repeat(64) });
  expect(template.kata.noNativeFallback).toBe(true);
});

it('discovers an editable draft, opens setup, and only persists after explicit save', async () => {
  const configuration = {
    bindingRevision: 1,
    expectedGeneration: 0,
    pins: [
      {
        alias: 'aq',
        ref: 'main',
        expectedCommitSha: 'd'.repeat(40),
        conformanceRevision: '16',
        packages: [{ name: 'queue', path: '' }],
      },
    ],
    consumers: [{ alias: 'wi', upstreams: ['aq'] }],
    environments: [
      {
        ...current.environments[0],
        id: 'local',
        kind: 'local-development',
        discovery: {
          kind: 'local-discovery-v1',
          environment: 'Captured workstation',
          fixtures: 'Imported sources',
          toolchains: 'Observed Rust',
        },
      },
    ],
  };
  const initial = {
    ...view(),
    current: undefined,
    submissions: [],
    repositories: [
      {
        alias: 'aq',
        role: 'implemented_upstream',
        configured: true,
        integrationBranch: 'main',
        requiredUpstreams: [],
        conformanceRevision: '16',
      },
      {
        alias: 'wi',
        role: 'planned_application',
        configured: true,
        integrationBranch: 'revision',
        requiredUpstreams: ['aq'],
      },
    ],
  };
  vi.mocked(request)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ configuration, notes: ['Review this draft.'] })
    .mockResolvedValueOnce(view());
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set up dependencies' }));
  expect(
    screen.getByText('Configure pinned dependencies and environments').closest('details')?.open,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Discover local setup' }));
  await screen.findByText('Review this draft.');
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(request).mock.calls[1]?.[0]).toMatch(/\/discover$/);
  fireEvent.click(screen.getByText('Captured local fingerprint inputs'));
  expect(screen.getByText('Captured workstation')).toBeTruthy();
  expect((screen.getByLabelText('Environment SHA-256') as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText('aq · branch or commit'), {
    target: { value: 'other-branch' },
  });
  expect(
    screen.getByRole('button', { name: 'Save dependency environment' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText('Inspect or rediscover the changed refs before saving.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('aq · branch or commit'), { target: { value: 'main' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dependency environment' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(vi.mocked(request).mock.calls[2]?.[0]).toMatch(/\/configure$/);
});

it('separates saved readiness, evidence generation and explicit independent plan acceptance', async () => {
  const saved = {
    roadmapId: runtimeId,
    name: 'Cross-project test',
    definitionRevision: 3,
    snapshotDigest: 'a'.repeat(64),
    issues: [],
    state: 'ready-to-generate',
  };
  const facts = {
    ...submission,
    id: 'generated-plan',
    subject: { kind: 'checkpoint', sourceId: 'STACK-PLAN-ACCEPTED' },
    reviewers: [],
    generatedPlan: {
      kind: 'saved-plan-v1',
      roadmapId: runtimeId,
      definitionRevision: 3,
      snapshotDigest: saved.snapshotDigest,
    },
    artifacts: [
      {
        name: 'saved-facts',
        digest: 'b'.repeat(64),
        content: 'Exact saved bindings and review settings.',
      },
    ],
  };
  const ready = {
    ...view(),
    submissions: [],
    planAcceptance: { checkpoint: 'STACK-PLAN-ACCEPTED', roadmaps: [saved] },
  };
  const pending = {
    ...ready,
    submissions: [{ submission: summary(facts), issues: [] }],
    planAcceptance: {
      ...ready.planAcceptance,
      roadmaps: [{ ...saved, state: 'awaiting-review', submissionId: facts.id }],
    },
  };
  respond(
    [
      ready,
      pending,
      {
        ...pending,
        planAcceptance: {
          ...ready.planAcceptance,
          roadmaps: [{ ...saved, state: 'accepted', submissionId: facts.id }],
        },
        submissions: [
          {
            submission: summary(facts),
            issues: [],
            decision: {
              outcome: 'accepted',
              decidedByUserId: 'operator',
              rationale: 'Reviewed saved configuration.',
            },
          },
        ],
      },
    ],
    { [facts.id]: facts },
  );
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  await screen.findByText('Saved configuration is ready to generate plan evidence.');
  fireEvent.click(screen.getByRole('button', { name: 'Generate plan-acceptance evidence' }));
  await screen.findByText('Evidence generated — awaiting your plan review.');
  expect(JSON.parse(String(vi.mocked(request).mock.calls[1]?.[2]?.body))).toEqual({
    roadmapId: runtimeId,
    definitionRevision: 3,
    snapshotDigest: saved.snapshotDigest,
  });
  expect(vi.mocked(request).mock.calls[1]?.[0]).toMatch(/generate-plan$/);
  const accept = screen.getByRole('button', { name: 'Accept evidence', hidden: true });
  fireEvent.change(screen.getByLabelText('Review decision rationale'), {
    target: { value: 'Reviewed saved configuration.' },
  });
  expect(accept.hasAttribute('disabled')).toBe(true);
  const reviewed = screen.getByRole('checkbox', {
    name: /I reviewed the saved plan/,
    hidden: true,
  });
  // Generating reveals the new submission, which reads its record for review.
  await screen.findByText('Exact saved bindings and review settings.');
  expect(calls(/submissions/)[0]?.[0]).toMatch(/\/runtime\/submissions\/generated-plan$/);
  fireEvent.click(reviewed);
  expect(accept.hasAttribute('disabled')).toBe(false);
  fireEvent.click(accept);
  await screen.findByText(/Plan evidence accepted. No further save or review/);
  expect(calls(/decide$/)).toHaveLength(1);
});

it('explains missing saved setup and disables plan evidence generation', async () => {
  vi.mocked(request).mockResolvedValue({
    ...view(),
    planAcceptance: {
      checkpoint: 'STACK-PLAN-ACCEPTED',
      roadmaps: [
        {
          roadmapId: runtimeId,
          name: 'Saved roadmap',
          definitionRevision: 1,
          snapshotDigest: 'a'.repeat(64),
          state: 'not-ready',
          issues: ['Save the pinned dependency environment first.'],
        },
      ],
    },
  });
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  await screen.findByText('Save the pinned dependency environment first.');
  expect(
    screen
      .getByRole('button', { name: 'Generate plan-acceptance evidence' })
      .hasAttribute('disabled'),
  ).toBe(true);
});

it('disables unchanged dependency saves and prevents generating plan evidence with unsaved roadmap edits', async () => {
  vi.mocked(request).mockResolvedValue({
    ...view(),
    planAcceptance: {
      checkpoint: 'STACK-PLAN-ACCEPTED',
      roadmaps: [
        {
          roadmapId: runtimeId,
          name: 'Saved',
          definitionRevision: 2,
          snapshotDigest: 'a'.repeat(64),
          state: 'ready-to-generate',
          issues: [],
        },
      ],
    },
  });
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
      roadmapSettingsDirty
    />,
  );
  await screen.findByText(/Unsaved roadmap or dependency settings/);
  expect(
    screen
      .getByRole('button', { name: 'Save dependency environment', hidden: true })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen
      .getByRole('button', { name: 'Generate plan-acceptance evidence' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps an inspected pin when a reload started before the inspection lands after it', async () => {
  // The e2e flake behind R-I5: saving plan bindings reloads this panel, and under load that
  // reload answered after the operator's Inspect and discarded the inspected dependency.
  const initial = {
    ...view(),
    current: undefined,
    submissions: [],
    subjects: [],
    repositories: [
      {
        alias: 'aq',
        role: 'implemented_upstream',
        configured: true,
        integrationBranch: 'main',
        requiredUpstreams: [],
        conformanceRevision: '16',
      },
    ],
  };
  let finishReload: (value: unknown) => void = () => undefined;
  let finishInspect: (value: unknown) => void = () => undefined;
  vi.mocked(request)
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(() => new Promise((resolve) => (finishReload = resolve)))
    .mockImplementationOnce(() => new Promise((resolve) => (finishInspect = resolve)));
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set up dependencies' }));
  act(() => {
    window.dispatchEvent(
      new CustomEvent('craftingtable:saved-plan-changed', { detail: runtimeId }),
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Inspect aq' }));
  await act(async () => {
    finishInspect({ commitSha: 'd'.repeat(40), packages: [{ name: 'aq_e2e_pin', path: '' }] });
  });
  expect(await screen.findByText('Supplied crates: aq_e2e_pin')).toBeTruthy();
  await act(async () => {
    finishReload(initial);
  });
  expect(screen.getByText('Supplied crates: aq_e2e_pin')).toBeTruthy();
});
it('labels build records the agent reported, from before the daemon recorded receipts (R-G4)', async () => {
  const build = (runId: string, receiptAuthority: 'daemon' | 'agent') => ({
    runId,
    runtimeId,
    digest: 'a'.repeat(64),
    successfulBuilds: 1,
    receiptAuthority,
  });
  vi.mocked(request).mockResolvedValue({
    ...view(),
    builds: [build('run-before', 'agent'), build('run-after', 'daemon')],
  });
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
    />,
  );
  const before = (await screen.findByText('run-before')).closest('p')!;
  const after = screen.getByText('run-after').closest('p')!;
  expect(before.textContent).toContain('agent-reported');
  expect(after.textContent).not.toContain('agent-reported');
});

it('leaves shared decisions open while roadmap settings are unsaved (UI-17, R-E2 review)', async () => {
  // Setup shows the settings form and the decisions together; an unsaved settings field must
  // not disable an unrelated approval. Plan evidence still waits for the save.
  vi.mocked(request).mockResolvedValue({
    ...view(),
    planAcceptance: {
      checkpoint: 'STACK-PLAN-ACCEPTED',
      roadmaps: [
        {
          roadmapId: runtimeId,
          name: 'Saved',
          definitionRevision: 2,
          snapshotDigest: 'a'.repeat(64),
          state: 'ready-to-generate',
          issues: [],
        },
      ],
    },
    decisionInbox: {
      workspaceId: 'workspace',
      definitionId: runtimeId,
      bindingRevision: 1,
      blockers: [],
      decisions: [
        {
          checkpointId: 'LOCAL-ADR-012',
          title: 'Provider identity policy',
          requirements: ['Approve identity policy'],
          blockers: [],
          sourceReferences: 'Exact bound plan §4.',
          consumers: [{ sliceId: 'local/WI-03/domain', phase: 'merge' }],
          records: [],
          recommendation: {
            sourceRunId: '00000000-0000-4000-8000-000000000002',
            sourceReportDigest: 'a'.repeat(64),
            question: 'Approve provider identity policy?',
            answer: 'Recommend stable identity.',
            sources: ['plan.md §4'],
          },
        },
      ],
    },
  });
  render(
    <RuntimeEvidencePanel
      workspaceId={asWorkspaceId('workspace')}
      definitionId={runtimeId}
      bindingRevision={1}
      csrfToken="csrf"
      canMutate
      roadmapSettingsDirty
    />,
  );
  const card = await screen.findByRole('region', { name: 'LOCAL-ADR-012' });
  const buttons = [...card.querySelectorAll('button')].filter((b) => b.closest('details') === null);
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b) => !b.hasAttribute('disabled'))).toBe(true);
  expect(
    screen
      .getByRole('button', { name: 'Generate plan-acceptance evidence' })
      .hasAttribute('disabled'),
  ).toBe(true);
});
