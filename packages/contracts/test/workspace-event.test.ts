import type { WorkspaceEventKind } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import { workspaceEventEnvelopeSchema } from '../src/workspace-event.js';

const base = {
  id: 'event-1',
  sequence: 1,
  occurredAt: '2026-07-24T00:00:00.000Z',
  workspaceId: 'workspace-1',
  actorUserId: 'user-1',
  schemaVersion: 1,
} as const;

const validEvents = {
  'workspace-created': {
    ...base,
    kind: 'workspace-created',
    payload: { name: 'Default workspace', slug: 'default' },
  },
  'project-created': {
    ...base,
    projectId: 'project-1',
    kind: 'project-created',
    payload: { projectId: 'project-1', name: 'Project one' },
  },
  'plan-version-imported': {
    ...base,
    projectId: 'project-1',
    kind: 'plan-version-imported',
    payload: {
      projectId: 'project-1',
      planVersionId: 'plan-version-1',
      versionNumber: 1,
      document: 'plan.md',
      itemCount: 1,
      requiredDependencyCount: 0,
      warningCount: 0,
    },
  },
  'work-item-admitted': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'work-item-admitted',
    payload: {
      projectId: 'project-1',
      planVersionId: 'plan-version-1',
      workItemId: 'work-item-1',
      sourceWorkItemId: 'SOURCE-1',
    },
  },
  'work-item-removed-from-agenda': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'work-item-removed-from-agenda',
    payload: {
      projectId: 'project-1',
      planVersionId: 'plan-version-1',
      workItemId: 'work-item-1',
      sourceWorkItemId: 'SOURCE-1',
    },
  },
  'source-repository-registered': {
    ...base,
    kind: 'source-repository-registered',
    payload: {
      sourceRepositoryId: 'source-repository-1',
      displayName: 'craftingtable',
      rootPath: '/home/user/src/craftingtable',
      defaultBranch: 'main',
    },
  },
  'worktree-created': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'worktree-created',
    payload: {
      worktreeId: 'worktree-1',
      sourceRepositoryId: 'source-repository-1',
      workItemId: 'work-item-1',
      branchName: 'ct/aq-01-abc123',
      baseSha: '0123456789abcdef0123456789abcdef01234567',
    },
  },
  'worktree-removed': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'worktree-removed',
    payload: {
      worktreeId: 'worktree-1',
      workItemId: 'work-item-1',
      branchName: 'ct/aq-01-abc123',
    },
  },
  'agent-run-started': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    runId: 'run-1',
    kind: 'agent-run-started',
    payload: {
      runId: 'run-1',
      worktreeId: 'worktree-1',
      workItemId: 'work-item-1',
      backend: 'claude-code',
      role: 'implement',
    },
  },
  'agent-run-status-changed': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    runId: 'run-1',
    kind: 'agent-run-status-changed',
    payload: {
      runId: 'run-1',
      workItemId: 'work-item-1',
      fromStatus: 'running',
      toStatus: 'waiting',
    },
  },
  'workspace-updated': {
    ...base,
    kind: 'workspace-updated',
    payload: { name: 'Renamed workspace', priorVersion: 1, resultingVersion: 2 },
  },
  'work-item-completed': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'work-item-completed',
    payload: {
      projectId: 'project-1',
      workItemId: 'work-item-1',
      sourceWorkItemId: 'SOURCE-1',
      worktreeId: 'worktree-1',
      mergeSha: '0123456789abcdef0123456789abcdef01234567',
    },
  },
  'branches-changed': {
    ...base,
    kind: 'branches-changed',
    projectId: 'project-1',
    payload: { planVersionId: 'plan-version-1', action: 'configured' },
  },
  'work-cycle-changed': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'work-cycle-changed',
    payload: {
      cycleId: 'aab388ca-d51a-41c9-9da6-e12a21c5fb25',
      status: 'running',
      step: 'design',
      reason: 'Starting design.',
    },
  },
  'runtime-evidence-changed': {
    ...base,
    kind: 'runtime-evidence-changed',
    payload: {
      definitionId: '12345678-1234-4234-8234-123456789abc',
      message: 'Environment configured.',
    },
  },
  'scope-scheduling-authorized': {
    ...base,
    kind: 'scope-scheduling-authorized',
    payload: { workItemId: 'item-1', sourceId: 'SLICE-1' },
  },
  'scope-evidence-recorded': {
    ...base,
    kind: 'scope-evidence-recorded',
    payload: {
      workItemId: 'item-1',
      worktreeId: 'tree-1',
      sourceId: 'SLICE-1',
      parentAccepted: false,
    },
  },
  'roadmap-changed': {
    ...base,
    kind: 'roadmap-changed',
    payload: {
      roadmapId: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      reason: 'Scheduling enabled.',
    },
  },
  'notifications-changed': {
    ...base,
    kind: 'notifications-changed',
    payload: { action: 'settings' },
  },
  'attention-changed': {
    ...base,
    kind: 'attention-changed',
    payload: { open: 2 },
  },
  'plan-version-retired': {
    ...base,
    kind: 'plan-version-retired',
    projectId: 'project-1',
    payload: {
      planVersionId: 'plan-version-1',
      roadmapId: '9e4b1a32-4a59-4a8b-a8a0-0f2c3c1b7d11',
      disposition: 'parked',
    },
  },
  'repository-cleanup-changed': {
    ...base,
    kind: 'repository-cleanup-changed',
    payload: {
      roadmapId: '9e4b1a32-4a59-4a8b-a8a0-0f2c3c1b7d11',
      cleanupId: '2a6f0c51-7a5e-4f4b-9d1d-5e0d8f2c6b10',
      status: 'running',
    },
  },
  'worktree-merged': {
    ...base,
    projectId: 'project-1',
    workItemId: 'work-item-1',
    kind: 'worktree-merged',
    payload: {
      worktreeId: 'worktree-1',
      workItemId: 'work-item-1',
      branchName: 'ct/source-1-abcd1234',
      targetBranch: 'main',
      mergeSha: '0123456789abcdef0123456789abcdef01234567',
    },
  },
} as const satisfies Readonly<Record<WorkspaceEventKind, object>>;

/**
 * The retired CT-04A2 registry's events, as the contract accepted them until R-H6. Their kinds stay
 * in the journal's append-only catalog, but no stored row uses them and none is readable.
 */
const retiredEvents = {
  'repository-registered': {
    ...base,
    repositoryId: 'repository-1',
    repositoryInspectionId: 'inspection-1',
    kind: 'repository-registered',
    payload: {
      repositoryId: 'repository-1',
      inspectionId: 'inspection-1',
      displayName: 'Repository one',
      status: 'active',
      statusReason: 'registration-accepted',
      version: 1,
    },
  },
  'repository-status-changed': {
    ...base,
    repositoryId: 'repository-1',
    repositoryInspectionId: 'inspection-2',
    kind: 'repository-status-changed',
    payload: {
      repositoryId: 'repository-1',
      inspectionId: 'inspection-2',
      displayName: 'Repository one',
      fromStatus: 'unavailable',
      toStatus: 'active',
      statusReason: 'evidence-matches',
      priorVersion: 2,
      resultingVersion: 3,
    },
  },
  'repository-evidence-changed': {
    ...base,
    repositoryId: 'repository-1',
    repositoryInspectionId: 'inspection-2',
    kind: 'repository-evidence-changed',
    payload: {
      repositoryId: 'repository-1',
      inspectionId: 'inspection-2',
      displayName: 'Repository one',
      evidenceClass: 'risk-scan',
      repositoryVersion: 3,
    },
  },
  'project-repository-bound': {
    ...base,
    projectId: 'project-1',
    repositoryId: 'repository-1',
    repositoryBindingId: 'binding-1',
    kind: 'project-repository-bound',
    payload: {
      projectId: 'project-1',
      repositoryId: 'repository-1',
      bindingId: 'binding-1',
      repositoryDisplayName: 'Repository one',
      bindingVersion: 1,
    },
  },
  'project-repository-binding-retired': {
    ...base,
    projectId: 'project-1',
    repositoryId: 'repository-1',
    repositoryBindingId: 'binding-1',
    kind: 'project-repository-binding-retired',
    payload: {
      projectId: 'project-1',
      repositoryId: 'repository-1',
      bindingId: 'binding-1',
      repositoryDisplayName: 'Repository one',
      priorVersion: 1,
      resultingVersion: 2,
    },
  },
} as const;

function cloneEvent(kind: WorkspaceEventKind): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validEvents[kind])) as Record<string, unknown>;
}

describe('WorkspaceEventEnvelope', () => {
  it('accepts the exact CT-02 workspace-created envelope', () => {
    expect(workspaceEventEnvelopeSchema.safeParse(validEvents['workspace-created']).success).toBe(
      true,
    );
  });

  it('rejects cross-kind, malformed cursor, and unknown data', () => {
    const event = validEvents['workspace-created'];
    expect(workspaceEventEnvelopeSchema.safeParse({ ...event, kind: 'run-started' }).success).toBe(
      false,
    );
    expect(workspaceEventEnvelopeSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
    expect(workspaceEventEnvelopeSchema.safeParse({ ...event, secret: 'no' }).success).toBe(false);
  });

  it('rejects the retired registry kinds and their correlation fields on every kind (R-H6)', () => {
    for (const [kind, event] of Object.entries(retiredEvents))
      expect(workspaceEventEnvelopeSchema.safeParse(event).success, kind).toBe(false);
    for (const kind of Object.keys(validEvents) as WorkspaceEventKind[])
      for (const correlation of ['repositoryId', 'repositoryInspectionId', 'repositoryBindingId']) {
        const event = cloneEvent(kind);
        event[correlation] = `${correlation}-extra`;
        expect(
          workspaceEventEnvelopeSchema.safeParse(event).success,
          `${kind} must reject ${correlation}`,
        ).toBe(false);
      }
  });
});
