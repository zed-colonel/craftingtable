import type { RuntimeEvidenceView } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { PlanAcceptance } from './PlanAcceptance.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const definitionId = '12345678-1234-4234-8234-123456789abc';
const base = `/api/workspaces/ws/concurrency-definitions/${definitionId}/runtime`;
const plan = {
  id: 'plan-1',
  subject: { kind: 'checkpoint', sourceId: 'PLAN-OK' },
  environmentId: 'local',
  executedAt: '2026-10-08T00:00:00Z',
  executedBy: 'CraftingTable',
  reviewers: [],
  generatedPlan: {
    kind: 'saved-plan-v2',
    roadmapId: 'roadmap-1',
    definitionRevision: 5,
    inputsDigest: 'a'.repeat(64),
    changedInputs: [],
  },
  artifacts: [{ name: 'plan-review-guide', digest: 'b'.repeat(64), bytes: 6 }],
};
function view(
  state: 'ready-to-generate' | 'awaiting-review' | 'accepted',
  carried?: { reviewedAt: string; changedInputs: string[] },
) {
  return {
    issues: [],
    builds: [],
    bindingRevision: 1,
    history: [],
    repositories: [],
    upstreamHistory: [],
    subjects: [
      {
        subject: plan.subject,
        title: 'Plan accepted',
        profile: 'plan-approval',
        requirements: ['Saved plan reviewed'],
        reviewerRoles: ['plan-owner'],
        testedRepositories: [],
        cases: [],
        issues: [],
      },
    ],
    submissions: state === 'ready-to-generate' ? [] : [{ submission: plan, issues: [] }],
    planAcceptance: {
      checkpoint: 'PLAN-OK',
      roadmaps: [
        {
          roadmapId: 'roadmap-1',
          name: 'Cross-project test',
          definitionRevision: 5,
          snapshotDigest: 'c'.repeat(64),
          issues: [],
          state,
          ...(state === 'ready-to-generate' ? {} : { submissionId: plan.id }),
          ...(carried ? { carried } : {}),
        },
        {
          roadmapId: 'roadmap-2',
          name: 'Another roadmap',
          definitionRevision: 1,
          snapshotDigest: 'd'.repeat(64),
          issues: [],
          state: 'ready-to-generate',
        },
      ],
    },
  } as unknown as RuntimeEvidenceView;
}
const props = {
  workspaceId: asWorkspaceId('ws'),
  definitionId,
  base,
  roadmapId: 'roadmap-1',
  csrfToken: 'csrf',
  disabled: false,
  panelId: 'item',
};

it("keeps R-C6's carried acceptance text, for the item's roadmap alone", () => {
  render(
    <PlanAcceptance
      {...props}
      view={view('accepted', {
        reviewedAt: '2026-10-01T21:26:54.681Z',
        changedInputs: ['stagedDecisions', 'reviewerRoles'],
      })}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByRole('status').textContent).toMatch(
    /^Accepted, carried from your review of .*2026.*; changed: staged decision clauses, reviewer roles\. Start or Resume remains your action\.$/,
  );
  expect(screen.queryByText('Another roadmap')).toBeNull();
});

it('generates plan evidence for the saved revision and digest shown', async () => {
  const next = view('awaiting-review');
  vi.mocked(request).mockResolvedValue(next);
  const onChanged = vi.fn();
  render(<PlanAcceptance {...props} view={view('ready-to-generate')} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate plan-acceptance evidence' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(next));
  const [url, , init] = vi.mocked(request).mock.calls[0]!;
  expect(url).toBe(`${base}/generate-plan`);
  expect(JSON.parse(String(init?.body))).toEqual({
    roadmapId: 'roadmap-1',
    definitionRevision: 5,
    snapshotDigest: 'c'.repeat(64),
  });
});

it('holds generation while settings beside it are unsaved', () => {
  render(
    <PlanAcceptance {...props} view={view('ready-to-generate')} unsaved onChanged={vi.fn()} />,
  );
  expect(
    (
      screen.getByRole('button', {
        name: 'Generate plan-acceptance evidence',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  screen.getByText(/Unsaved roadmap or dependency settings/);
});

it('reviews the generated plan in place in its item, its record read at once', async () => {
  vi.mocked(request).mockResolvedValue({
    ...plan,
    artifacts: [{ name: 'plan-review-guide', digest: 'b'.repeat(64), content: 'Guide.' }],
  });
  render(<PlanAcceptance {...props} view={view('awaiting-review')} inline onChanged={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Review generated plan evidence' })).toBeNull();
  await screen.findByText('Guide.');
  expect(vi.mocked(request).mock.calls[0]![0]).toBe(`${base}/submissions/plan-1`);
  screen.getByRole('button', { name: 'Accept evidence' });
});

it('in setup, opens the review in the evidence list instead', () => {
  render(<PlanAcceptance {...props} view={view('awaiting-review')} onChanged={vi.fn()} />);
  screen.getByRole('button', { name: 'Review generated plan evidence' });
  expect(screen.queryByRole('button', { name: 'Accept evidence' })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
