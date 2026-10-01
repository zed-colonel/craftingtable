import type { FinalizationView } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { FinalizationStep } from './FinalizationStep.js';
import { FinalPromotion } from './FinalPromotion.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const view = (actions: FinalizationView['actions'], extra: Partial<FinalizationView> = {}) =>
  ({
    finalization: {
      id: 'fin-1',
      version: 5,
      targetBranch: 'main',
      integrationBranch: 'aq-cont-1',
      policy: { maxRemediationRounds: 3 },
      stages: [
        {
          kind: 'simplification',
          implement: { backend: 'codex', permissionMode: 'auto' },
          review: { backend: 'codex', permissionMode: 'auto' },
        },
      ],
      finalReview: { backend: 'codex', permissionMode: 'auto' },
    },
    cycle: {
      version: 38,
      currentRunId: 'run-9',
      status: 'needs-attention',
      policy: { maxRemediationRounds: 3 },
      remediationRounds: 1,
      finalizationProgress: { stageIndex: 0, stages: [{ status: 'reviewing' }], obligations: [] },
    },
    runs: [
      { id: 'run-9', reviewBranchContext: { headSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) } },
    ],
    actions,
    mergeRecoveryPending: false,
    checkpointFindings: [],
    canAuthorizeRemediation: false,
    ...extra,
  }) as unknown as FinalizationView;

it('offers only the decisions the daemon returned, and posts them itself (R-A6 2b)', async () => {
  vi.mocked(request).mockResolvedValue({});
  const onDone = vi.fn();
  const { rerender, container } = render(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view([])}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={onDone}
    />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view(['resume'])}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={onDone}
    />,
  );
  const options = [...screen.getByLabelText('Next action').querySelectorAll('option')].map(
    (o) => o.value,
  );
  expect(options).toEqual(['resume']);
  fireEvent.click(screen.getByRole('button', { name: 'Resume finalization' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const [url, , init] = vi.mocked(request).mock.calls[0]!;
  expect(url).toBe('/api/workspaces/ws/finalizations/fin-1/control');
  expect(JSON.parse(String(init!.body))).toMatchObject({
    action: 'resume',
    expectedVersion: 5,
    expectedCycleVersion: 38,
  });
});

it('approves the promotion only when the daemon offers it, naming the commits the review saw (R-A6 2b)', async () => {
  vi.mocked(request).mockResolvedValue({});
  const onDone = vi.fn();
  const { container, rerender } = render(
    <FinalPromotion
      workspaceId={asWorkspaceId('ws')}
      view={view(['resume'])}
      csrfToken="csrf"
      disabled={false}
      onDone={onDone}
    />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <FinalPromotion
      workspaceId={asWorkspaceId('ws')}
      view={view(['merge'], {
        cycle: { ...view([]).cycle!, status: 'awaiting-merge', version: 39 },
      })}
      csrfToken="csrf"
      disabled={false}
      onDone={onDone}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review final merge approval' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Remove local integration branch/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Approve merge into main' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(JSON.parse(String(vi.mocked(request).mock.calls[0]![2]!.body))).toEqual({
    action: 'merge',
    expectedVersion: 5,
    expectedCycleVersion: 39,
    expectedHeadSha: 'a'.repeat(40),
    expectedTargetSha: 'b'.repeat(40),
    removeIntegrationBranch: true,
  });
});

it("offers a stage's batch without a resume the daemon does not offer", () => {
  render(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view(['select-stage-findings'], {
        cycle: {
          ...view([]).cycle!,
          finalizationProgress: {
            stageIndex: 0,
            stages: [{ status: 'selecting' }],
            obligations: [],
          },
        } as never,
        checkpointFindings: [],
      })}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={vi.fn()}
    />,
  );
  expect(
    [...screen.getByLabelText('Next action').querySelectorAll('option')].map((o) => o.value),
  ).toEqual(['select-stage-findings']);
});

const selecting = (obligations: object[]) =>
  ({
    ...view([]).cycle!,
    currentRunId: 'run-9',
    finalizationProgress: { stageIndex: 0, stages: [{ status: 'selecting' }], obligations },
  }) as never;
const proposal = (runId: string) => ({
  id: 'OB-1',
  status: 'change-requested',
  requirement: 'Adopted requirement.',
  proposedRequirement: 'Narrower requirement.',
  runId,
});
const options = () =>
  [...screen.getByLabelText('Next action').querySelectorAll('option')].map((o) => o.value);

it("offers an earlier review's leftover proposal for nothing: the stage's batch instead (R-A6 2b review)", () => {
  render(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view(['select-stage-findings', 'resume'], {
        cycle: selecting([proposal('run-1')]),
      })}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={vi.fn()}
    />,
  );
  expect(options()).toEqual(['select-stage-findings', 'resume']);
});

it("offers the current review's proposal only when the daemon does", () => {
  const { rerender } = render(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view(['approve-plan-change', 'resume'], { cycle: selecting([proposal('run-9')]) })}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={vi.fn()}
    />,
  );
  expect(options()).toEqual(['approve-plan-change', 'resume']);
  rerender(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view(['resume'], { cycle: selecting([proposal('run-9')]) })}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={vi.fn()}
    />,
  );
  expect(options()).toEqual(['resume']);
  // At the stage form, a proposal the daemon does not offer for approval is not offered.
  rerender(
    <FinalizationStep
      workspaceId={asWorkspaceId('ws')}
      view={view(['select-stage-findings', 'resume'], { cycle: selecting([proposal('run-9')]) })}
      csrfToken="csrf"
      disabled={false}
      backends={[]}
      onDone={vi.fn()}
    />,
  );
  expect(options()).not.toContain('approve-plan-change');
});
