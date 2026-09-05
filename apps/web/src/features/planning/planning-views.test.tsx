import type { WorkItemDetailResponse, WorkItemSummary } from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusCards } from '../../components/StatusCards.js';
import { DiagnosticList } from './DiagnosticList.js';
import { SourceText } from './SourceText.js';
import { WorkItemPage } from './WorkItemPage.js';
import { WorkItemTable } from './WorkItemTable.js';

afterEach(cleanup);

function item(overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id: 'item-1' as WorkItemSummary['id'],
    sourceId: 'AQ-01',
    ordinal: 0,
    title: 'Freeze evidence and establish the development contract',
    status: 'proposed',
    risk: 'medium',
    primaryAreas: ['contract', 'conformance'],
    exitGate: 'Baseline green.',
    requiredPredecessorCount: 0,
    recommendedPredecessorCount: 0,
    blockerSourceIds: [],
    readiness: 'planning-ready',
    ...overrides,
  } as WorkItemSummary;
}

function workItemDetail(overrides: Partial<WorkItemDetailResponse> = {}): WorkItemDetailResponse {
  return {
    workItem: {
      ...item(),
      projectId: 'project-1',
      planVersionId: 'version-1',
    },
    projectName: 'ActionQueue — AQ-CONT-1',
    requiredPredecessors: [],
    recommendedPredecessors: [],
    dependents: [],
    ...overrides,
  } as WorkItemDetailResponse;
}

function renderPage(
  detail: WorkItemDetailResponse,
  options: { canMutate?: boolean; inProgress?: boolean; onAdmit?: () => void } = {},
) {
  return render(
    <WorkItemPage
      detail={detail}
      inProgress={options.inProgress ?? false}
      onAdmit={options.onAdmit ?? vi.fn()}
      onComplete={vi.fn()}
      onOpenProject={vi.fn()}
      busy={false}
      canMutate={options.canMutate ?? true}
    />,
  );
}

describe('dashboard status cards', () => {
  it('labels each card unambiguously, shows real counts, and opens the matching list', () => {
    const onOpen = vi.fn();
    render(
      <StatusCards
        summary={{
          needsAttention: 2,
          active: 1,
          planningReady: 1,
          dependencyBlocked: 13,
          completed: 4,
          liveRuns: 2,
        }}
        onOpen={onOpen}
      />,
    );
    // Never a bare "Ready" or "Blocked".
    expect(screen.getByText('Ready for admission')).toBeDefined();
    expect(screen.getByText('Dependency-blocked')).toBeDefined();
    expect(screen.getByText('Needs attention')).toBeDefined();
    expect(screen.getByText('In agenda')).toBeDefined();
    expect(screen.getByText('Live runs')).toBeDefined();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.queryByText('Blocked')).toBeNull();

    const region = screen.getByRole('region', { name: 'Work summary' });
    expect(within(region).getByText('13')).toBeDefined();
    expect(
      within(region).getByText('Proposed with every required predecessor completed'),
    ).toBeDefined();

    fireEvent.click(within(region).getByText('Dependency-blocked'));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'agenda', filter: 'dependency-blocked' });
    fireEvent.click(within(region).getByText('Live runs'));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'runs' });
  });

  it('hides the attention card when nothing needs attention', () => {
    render(
      <StatusCards
        summary={{
          needsAttention: 0,
          active: 0,
          planningReady: 0,
          dependencyBlocked: 0,
          completed: 0,
          liveRuns: 0,
        }}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByText('Needs attention')).toBeNull();
  });
});

describe('work item table', () => {
  it('shows state, predecessors, and blockers per row', () => {
    const onOpen = vi.fn();
    render(
      <WorkItemTable
        items={[
          item(),
          item({
            id: 'item-2' as WorkItemSummary['id'],
            sourceId: 'AQ-02',
            title: 'Introduce target core vocabulary',
            risk: 'high',
            requiredPredecessorCount: 1,
            blockerSourceIds: ['AQ-01'],
            readiness: 'dependency-blocked',
          }),
          item({
            id: 'item-3' as WorkItemSummary['id'],
            sourceId: 'AQ-03',
            status: 'completed',
            readiness: 'completed',
          }),
        ]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText('Ready for admission')).toBeDefined();
    expect(screen.getByText('Dependency-blocked')).toBeDefined();
    expect(screen.getByText('Completed')).toBeDefined();
    expect(screen.getByText('Waiting on AQ-01.')).toBeDefined();
    expect(screen.getByText('No unfinished required predecessors.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'AQ-02' }));
    expect(onOpen).toHaveBeenCalledWith('item-2');
  });
});

describe('work item page', () => {
  it('offers admission and explains that it is not execution readiness', () => {
    const onAdmit = vi.fn();
    renderPage(
      workItemDetail({
        workItem: {
          ...item({
            sourceId: 'AQ-14',
            readiness: 'dependency-blocked',
            blockerSourceIds: ['AQ-13'],
            requiredPredecessorCount: 1,
          }),
          projectId: 'project-1',
          planVersionId: 'version-1',
        },
        requiredPredecessors: [
          {
            workItemId: 'item-13',
            sourceId: 'AQ-13',
            title: 'Build conformance suite',
            status: 'proposed',
            risk: 'critical',
            kind: 'required',
          },
        ],
      } as never),
      { onAdmit },
    );
    expect(screen.getByText(/dependency-blocked by AQ-13/)).toBeDefined();
    expect(screen.getByText(/not .run this now./)).toBeDefined();
    // A blocked item is still admittable through explicit action.
    const button = screen.getByRole('button', { name: 'Admit into agenda' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onAdmit).toHaveBeenCalledOnce();
  });

  it('disables admission for a role that may not mutate', () => {
    renderPage(workItemDetail(), { canMutate: false });
    expect(screen.getByRole('button', { name: 'Admit into agenda' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByText(/role does not permit/)).toBeDefined();
  });

  it('shows an admitted item as in progress once a worktree exists, and offers completion', () => {
    renderPage(
      workItemDetail({
        workItem: {
          ...item({ status: 'admitted', readiness: 'active' }),
          projectId: 'project-1',
          planVersionId: 'version-1',
          admittedAt: '2026-07-24T01:00:00.000Z',
        },
      } as never),
      { inProgress: true },
    );
    expect(screen.getByText('In progress')).toBeDefined();
    expect(screen.queryByRole('button', { name: /admit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDefined();
    // The retired draft vocabulary is gone for good.
    expect(screen.queryByText(/not executable/i)).toBeNull();
  });

  it('renders a completed item read-only with its merge', () => {
    renderPage(
      workItemDetail({
        workItem: {
          ...item({ status: 'completed', readiness: 'completed' }),
          projectId: 'project-1',
          planVersionId: 'version-1',
          admittedAt: '2026-07-24T01:00:00.000Z',
          completedAt: '2026-07-25T01:00:00.000Z',
          mergeSha: 'abcdef0123456789abcdef0123456789abcdef01',
        },
      } as never),
    );
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getByText(/merged as abcdef0123/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull();
  });
});

describe('source rendering (CT03-A65)', () => {
  it('escapes markup instead of executing or rendering it', () => {
    const hostile =
      'document: "<script>window.__pwned = true</script>"\n' +
      'title: "<img src=x onerror=\\"window.__pwned = true\\">"\n';
    const { container } = render(<SourceText text={hostile} label="Source of hostile.yaml" />);

    const pre = screen.getByTestId('source-text');
    // The markup survives as *text*, and creates no elements.
    expect(pre.textContent).toBe(hostile);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    expect(pre.innerHTML).toContain('&lt;script&gt;');
  });
});

describe('diagnostics (CT03-A64)', () => {
  it('groups by severity and shows the stable machine code', () => {
    render(
      <DiagnosticList
        diagnostics={[
          {
            severity: 'error',
            code: 'required-dependency-cycle',
            message: 'Required dependency cycle: AQ-01 → AQ-02 → AQ-01',
            artifactName: 'breakdown.yaml',
          },
          {
            severity: 'warning',
            code: 'unrecognized-risk',
            message: 'Risk "apocalyptic" is not recognized',
            workItemSourceId: 'AQ-03',
          },
        ]}
      />,
    );
    expect(screen.getByText('1 error')).toBeDefined();
    expect(screen.getByText('1 warning')).toBeDefined();
    expect(screen.getByText('required-dependency-cycle')).toBeDefined();
    expect(screen.getByText('unrecognized-risk')).toBeDefined();
    expect(screen.getByText(/AQ-01 → AQ-02 → AQ-01/)).toBeDefined();
  });

  it('reports an empty diagnostic set honestly', () => {
    render(<DiagnosticList diagnostics={[]} />);
    expect(screen.getByText('No diagnostics.')).toBeDefined();
  });
});
