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

const FIXTURE = [
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
    },
  },
  {
    ...base,
    id: 'event-5',
    kind: 'source-repository-registered',
    payload: {
      sourceRepositoryId: 'source-repository-1',
      displayName: 'Repository',
      rootPath: '/src/repository',
      defaultBranch: 'main',
    },
  },
] as unknown as readonly WorkspaceEventEnvelope[];

afterEach(cleanup);

describe('ActivityPanel events', () => {
  it('B1-STO-010/B1-UI-009 describes every kind', () => {
    const descriptions = FIXTURE.map(describeEvent);
    expect(descriptions).toHaveLength(5);
    for (const description of descriptions) {
      expect(description.length).toBeGreaterThan(0);
    }
    expect(descriptions[4]).toBe('Repository registered: Repository (/src/repository)');
  });

  it('B1-A-03 leaves a legacy import description unbounded', () => {
    const imported = FIXTURE[2];
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
      ...FIXTURE[4],
      payload: {
        ...FIXTURE[4]?.payload,
        displayName: hostile,
      },
    } as WorkspaceEventEnvelope;
    const rendered = render(
      <ActivityPanel
        events={[repositoryEvent]}
        invalidPayloadCount={0}
        foreignWorkspaceEventCount={0}
      />,
    );
    expect(
      screen.getByText(`Repository registered: ${hostile} (/src/repository)`).textContent,
    ).toBe(`Repository registered: ${hostile} (/src/repository)`);
    expect(rendered.container.querySelector('img')).toBeNull();
    expect((globalThis as { __activityInjected?: boolean }).__activityInjected).toBeUndefined();
  });
});
