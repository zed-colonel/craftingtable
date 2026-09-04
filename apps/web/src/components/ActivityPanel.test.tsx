import type { WorkspaceEventEnvelope } from '@craftingtable/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityPanel, describeEvent } from './ActivityPanel.js';

const base = {
  id: 'event-1',
  sequence: 1,
  occurredAt: '2026-07-29T00:00:00.000Z',
  workspaceId: 'workspace-1',
  schemaVersion: 1,
};

const NINE_KIND_FIXTURE = [
  {
    ...base,
    kind: 'workspace-created',
    payload: { name: 'Workspace', slug: 'workspace' },
  },
  {
    ...base,
    id: 'event-2',
    kind: 'project-created',
    projectId: 'project-1',
    payload: { projectId: 'project-1', name: 'Project' },
  },
  {
    ...base,
    id: 'event-3',
    kind: 'plan-version-imported',
    projectId: 'project-1',
    payload: {
      projectId: 'project-1',
      planVersionId: 'plan-version-1',
      versionNumber: 1,
      document: 'Plan',
      itemCount: 2,
      requiredDependencyCount: 1,
      warningCount: 0,
    },
  },
  {
    ...base,
    id: 'event-4',
    kind: 'work-item-admitted',
    projectId: 'project-1',
    workItemId: 'work-item-1',
    payload: {
      projectId: 'project-1',
      planVersionId: 'plan-version-1',
      workItemId: 'work-item-1',
      sourceWorkItemId: 'CT-01',
      workContractDraftId: 'draft-1',
    },
  },
  {
    ...base,
    id: 'event-5',
    kind: 'repository-registered',
    repositoryId: 'repository-1',
    repositoryInspectionId: 'inspection-1',
    payload: {
      repositoryId: 'repository-1',
      inspectionId: 'inspection-1',
      displayName: 'Repository',
      status: 'active',
      statusReason: 'registration-accepted',
      version: 1,
    },
  },
  {
    ...base,
    id: 'event-6',
    kind: 'repository-status-changed',
    repositoryId: 'repository-1',
    repositoryInspectionId: 'inspection-2',
    payload: {
      repositoryId: 'repository-1',
      inspectionId: 'inspection-2',
      displayName: 'Repository',
      fromStatus: 'attention',
      toStatus: 'active',
      statusReason: 'verification-restored',
      priorVersion: 1,
      resultingVersion: 2,
    },
  },
  {
    ...base,
    id: 'event-7',
    kind: 'repository-evidence-changed',
    repositoryId: 'repository-1',
    repositoryInspectionId: 'inspection-3',
    payload: {
      repositoryId: 'repository-1',
      inspectionId: 'inspection-3',
      displayName: 'Repository',
      evidenceClass: 'risk-scan',
      repositoryVersion: 2,
    },
  },
  {
    ...base,
    id: 'event-8',
    kind: 'project-repository-bound',
    projectId: 'project-1',
    repositoryId: 'repository-1',
    repositoryBindingId: 'binding-1',
    payload: {
      projectId: 'project-1',
      repositoryId: 'repository-1',
      bindingId: 'binding-1',
      repositoryDisplayName: 'Repository',
      bindingVersion: 1,
    },
  },
  {
    ...base,
    id: 'event-9',
    kind: 'project-repository-binding-retired',
    projectId: 'project-1',
    repositoryId: 'repository-1',
    repositoryBindingId: 'binding-1',
    payload: {
      projectId: 'project-1',
      repositoryId: 'repository-1',
      bindingId: 'binding-1',
      repositoryDisplayName: 'Repository',
      priorVersion: 1,
      resultingVersion: 2,
    },
  },
] as unknown as readonly WorkspaceEventEnvelope[];

afterEach(cleanup);

describe('ActivityPanel repository events', () => {
  it('B1-STO-010/B1-UI-009/B1-UI-010 describes every kind and bounds repository descriptions', () => {
    const descriptions = NINE_KIND_FIXTURE.map(describeEvent);
    expect(descriptions).toHaveLength(9);
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThan(0);
    }
    expect(descriptions.slice(4)).toEqual([
      'Repository registered: Repository',
      'Repository status changed from attention to active: Repository',
      'Repository risk evidence changed: Repository',
      'Repository bound to project: Repository',
      'Repository binding retired: Repository',
    ]);
    expect(descriptions.slice(4).join(' ').toLowerCase()).not.toMatch(
      /\b(ready|verified|reviewed|approved|executable|mergeable)\b/,
    );

    const maximumDisplayName = 'R'.repeat(120);
    const maximumRepositoryDescriptions = NINE_KIND_FIXTURE.slice(4).map((repositoryEvent) => {
      const displayNameKey = repositoryEvent.kind.startsWith('project-')
        ? 'repositoryDisplayName'
        : 'displayName';
      return describeEvent({
        ...repositoryEvent,
        payload: {
          ...repositoryEvent.payload,
          [displayNameKey]: maximumDisplayName,
        },
      } as WorkspaceEventEnvelope);
    });
    for (const description of maximumRepositoryDescriptions) {
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it('B1-A-03 does not claim the repository description bound for legacy imports', () => {
    const imported = NINE_KIND_FIXTURE[2];
    if (imported?.kind !== 'plan-version-imported') {
      throw new Error('Expected plan-version-imported fixture');
    }
    expect(
      describeEvent({
        ...imported,
        payload: { ...imported.payload, document: 'D'.repeat(300) },
      } as WorkspaceEventEnvelope).length,
    ).toBeGreaterThan(256);
  });

  it('B1-UI-008 renders a hostile display name literally without injected elements', () => {
    const hostile = '<img src=x onerror="globalThis.__activityInjected=true">';
    const repositoryEvent = {
      ...NINE_KIND_FIXTURE[4],
      payload: {
        ...NINE_KIND_FIXTURE[4]?.payload,
        displayName: hostile,
      },
    } as WorkspaceEventEnvelope;
    const rendered = render(
      <ActivityPanel
        connection="open"
        events={[repositoryEvent]}
        invalidPayloadCount={0}
        foreignWorkspaceEventCount={0}
      />,
    );
    expect(screen.getByText(`Repository registered: ${hostile}`).textContent).toBe(
      `Repository registered: ${hostile}`,
    );
    expect(rendered.container.querySelector('img')).toBeNull();
    expect((globalThis as { __activityInjected?: boolean }).__activityInjected).toBeUndefined();
  });
});
