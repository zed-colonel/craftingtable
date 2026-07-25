import type {
  WorkContractDraftSummary,
  WorkItemDetailResponse,
  WorkItemSummary,
} from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusRegions } from '../../components/StatusRegions.js';
import { DiagnosticList } from './DiagnosticList.js';
import { SourceText } from './SourceText.js';
import { WorkContractDraftPanel } from './WorkContractDraftPanel.js';
import { WorkItemPage } from './WorkItemPage.js';
import { WorkItemTable } from './WorkItemTable.js';

/** CT03-A60, A62, A63, A64, A65. */

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

const DRAFT: WorkContractDraftSummary = {
  id: 'draft-1' as WorkContractDraftSummary['id'],
  schemaVersion: 1,
  status: 'draft',
  completeness: 'incomplete',
  createdAt: '2026-07-24T00:00:00.000Z',
  document: {
    schemaVersion: 1,
    status: 'draft',
    completeness: 'incomplete',
    source: {
      projectId: 'project-1' as never,
      planVersionId: 'version-1' as never,
      workItemId: 'item-1' as never,
      sourceWorkItemId: 'AQ-01',
    },
    objective: { title: 'Freeze evidence', exitGate: 'Baseline green.' },
    classification: { risk: 'medium', primaryAreas: ['contract'] },
    dependencies: { required: [], recommended: [] },
    repository: { status: 'unresolved' },
    baseRevision: { status: 'unresolved' },
    scope: { status: 'unresolved', writable: [], forbidden: [] },
    verification: { status: 'unresolved', checkIds: [] },
    merge: { humanAuthorizationRequired: true },
    review: {
      requiredPerspectives: ['specification', 'correctness'],
      maxRemediationGenerations: 3,
    },
    missing: [
      'registered-repository',
      'exact-base-revision',
      'path-scope',
      'verification-policy',
      'protected-acceptance-criteria',
      'agent-backend',
      'execution-environment',
    ],
  },
};

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
    draft: null,
    ...overrides,
  } as WorkItemDetailResponse;
}

describe('dashboard status regions (CT03-A60)', () => {
  it('labels each region unambiguously and shows real counts', () => {
    render(
      <StatusRegions
        summary={{ needsAttention: 2, active: 1, planningReady: 1, dependencyBlocked: 13 }}
      />,
    );
    // Never a bare "Ready": CT-03 owns planning readiness only.
    expect(screen.getByText('Ready for admission')).toBeDefined();
    expect(screen.getByText('Dependency-blocked')).toBeDefined();
    expect(screen.getByText('Needs attention')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.queryByText('Blocked')).toBeNull();

    const regions = screen.getByRole('region', { name: 'Work summary' });
    expect(within(regions).getByText('13')).toBeDefined();
    // Labels are visible text, not tooltip-only.
    expect(screen.getByText('Proposed with every required predecessor satisfied')).toBeDefined();
  });
});

describe('work item table (CT03-A62)', () => {
  it('shows readiness, predecessors, and blockers per row', () => {
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
        ]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText('Ready for admission')).toBeDefined();
    expect(screen.getByText('Dependency-blocked')).toBeDefined();
    expect(screen.getByText('Waiting on AQ-01.')).toBeDefined();
    expect(screen.getByText('No unfinished required predecessors.')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'AQ-02' }));
    expect(onOpen).toHaveBeenCalledWith('item-2');
  });
});

describe('work item page (CT03-A62, CT03-A55)', () => {
  it('offers admission and explains that it is not execution readiness', () => {
    const onAdmit = vi.fn();
    render(
      <WorkItemPage
        detail={workItemDetail({
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
        } as never)}
        onAdmit={onAdmit}
        admitting={false}
        canAdmit
      />,
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
    render(
      <WorkItemPage
        detail={workItemDetail()}
        onAdmit={vi.fn()}
        admitting={false}
        canAdmit={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Admit into agenda' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByText(/role does not permit/)).toBeDefined();
  });

  it('renders the draft after admission and no approval control (CT03-A63)', () => {
    render(
      <WorkItemPage
        detail={workItemDetail({
          workItem: {
            ...item({ status: 'admitted', readiness: 'active' }),
            projectId: 'project-1',
            planVersionId: 'version-1',
            admittedAt: '2026-07-24T01:00:00.000Z',
          },
          draft: DRAFT,
        } as never)}
        onAdmit={vi.fn()}
        admitting={false}
        canAdmit
      />,
    );
    expect(screen.getByRole('region', { name: 'Work contract draft' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /admit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});

describe('work contract draft panel (CT03-A58, CT03-A63)', () => {
  it('states that the draft is not executable and lists every missing field', () => {
    render(<WorkContractDraftPanel draft={DRAFT} />);
    expect(screen.getByText(/Draft — not executable\./)).toBeDefined();
    expect(screen.getByText('Unresolved (7)')).toBeDefined();
    for (const label of [
      'Registered repository',
      'Exact base revision',
      'Writable and forbidden path scope',
      'Verification commands',
      'Protected acceptance criteria',
      'Agent backend',
      'Execution environment',
    ]) {
      expect(screen.getByText(label), label).toBeDefined();
    }
    expect(screen.getByText('Human authorization required')).toBeDefined();
    // No control can approve, save, or run.
    expect(screen.queryByRole('button')).toBeNull();
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
