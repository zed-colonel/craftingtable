import type { WorkspaceEventKind } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  projectRepositoryBindingRetiredEventSchema,
  repositoryStatusChangedEventSchema,
  workspaceEventEnvelopeSchema,
} from './workspace-event.js';

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
      workContractDraftId: 'draft-1',
    },
  },
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
} as const satisfies Readonly<Record<WorkspaceEventKind, object>>;

function cloneEvent(kind: WorkspaceEventKind): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validEvents[kind])) as Record<string, unknown>;
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
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

  it('B1-CON-001 accepts repository-registered', () => {
    expect(
      workspaceEventEnvelopeSchema.safeParse(validEvents['repository-registered']).success,
    ).toBe(true);
  });

  it('B1-CON-002 accepts repository-status-changed with an inspection', () => {
    expect(
      workspaceEventEnvelopeSchema.safeParse(validEvents['repository-status-changed']).success,
    ).toBe(true);
  });

  it('B1-CON-003 accepts operator retirement without an inspection', () => {
    const event = cloneEvent('repository-status-changed');
    delete event.repositoryInspectionId;
    Object.assign(payloadOf(event), {
      fromStatus: 'active',
      toStatus: 'retired',
      statusReason: 'operator-retired',
      priorVersion: 3,
      resultingVersion: 4,
    });
    delete payloadOf(event).inspectionId;

    expect(repositoryStatusChangedEventSchema.safeParse(event).success).toBe(true);
  });

  it('B1-CON-004 accepts repository-evidence-changed and its post-transaction version', () => {
    expect(
      workspaceEventEnvelopeSchema.safeParse(validEvents['repository-evidence-changed']).success,
    ).toBe(true);
  });

  it('B1-CON-005 accepts project binding creation and retirement', () => {
    expect(
      workspaceEventEnvelopeSchema.safeParse(validEvents['project-repository-bound']).success,
    ).toBe(true);
    expect(
      workspaceEventEnvelopeSchema.safeParse(validEvents['project-repository-binding-retired'])
        .success,
    ).toBe(true);
  });

  it('B1-CON-006 and A2B-JRN-011 strictly reject readiness, authority, environment, and raw Git fields', () => {
    const forbiddenFields = [
      'ready',
      'readiness',
      'executable',
      'approved',
      'verified',
      'reviewed',
      'mergeable',
      'command',
      'argv',
      'cwd',
      'environment',
      'requestedPath',
      'canonicalTopLevel',
      'canonicalGitDirectory',
      'canonicalCommonGitDirectory',
      'observation',
      'observationJson',
      'errorEvidence',
      'stdout',
      'stderr',
      'gitExecutable',
      'ref',
      'branch',
      'worktree',
      'remote',
    ];

    for (const field of forbiddenFields) {
      const event = cloneEvent('repository-registered');
      payloadOf(event)[field] = 'forbidden';
      expect(workspaceEventEnvelopeSchema.safeParse(event).success, field).toBe(false);
    }
  });

  it('B1-CON-007 rejects status versions other than prior plus one', () => {
    for (const resultingVersion of [2, 4]) {
      const event = cloneEvent('repository-status-changed');
      payloadOf(event).resultingVersion = resultingVersion;
      expect(repositoryStatusChangedEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('B1-CON-008 rejects binding retirement versions other than prior plus one', () => {
    for (const resultingVersion of [1, 3]) {
      const event = cloneEvent('project-repository-binding-retired');
      payloadOf(event).resultingVersion = resultingVersion;
      expect(projectRepositoryBindingRetiredEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('B1-CON-009 rejects display-name control and oversize content', () => {
    for (const displayName of ['unsafe\u0000name', 'x'.repeat(121)]) {
      const event = cloneEvent('repository-registered');
      payloadOf(event).displayName = displayName;
      expect(workspaceEventEnvelopeSchema.safeParse(event).success).toBe(false);
    }
  });

  it('B1-CON-010 rejects wrong status/reason and retirement/inspection relationships', () => {
    const wrongReason = cloneEvent('repository-status-changed');
    payloadOf(wrongReason).statusReason = 'path-unavailable';
    expect(repositoryStatusChangedEventSchema.safeParse(wrongReason).success).toBe(false);

    const sameStatus = cloneEvent('repository-status-changed');
    payloadOf(sameStatus).fromStatus = 'active';
    expect(repositoryStatusChangedEventSchema.safeParse(sameStatus).success).toBe(false);

    const retirementWithInspection = cloneEvent('repository-status-changed');
    Object.assign(payloadOf(retirementWithInspection), {
      fromStatus: 'active',
      toStatus: 'retired',
      statusReason: 'operator-retired',
    });
    expect(repositoryStatusChangedEventSchema.safeParse(retirementWithInspection).success).toBe(
      false,
    );

    const nonRetirementWithoutInspection = cloneEvent('repository-status-changed');
    delete nonRetirementWithoutInspection.repositoryInspectionId;
    delete payloadOf(nonRetirementWithoutInspection).inspectionId;
    expect(
      repositoryStatusChangedEventSchema.safeParse(nonRetirementWithoutInspection).success,
    ).toBe(false);
  });

  it('B1-CON-011 rejects every repository correlation an exact variant does not carry', () => {
    const correlations = [
      ['repositoryId', 'repository-extra'],
      ['repositoryInspectionId', 'inspection-extra'],
      ['repositoryBindingId', 'binding-extra'],
    ] as const;
    const permitted = {
      'workspace-created': [],
      'project-created': [],
      'plan-version-imported': [],
      'work-item-admitted': [],
      'repository-registered': ['repositoryId', 'repositoryInspectionId'],
      'repository-status-changed': ['repositoryId', 'repositoryInspectionId'],
      'repository-evidence-changed': ['repositoryId', 'repositoryInspectionId'],
      'project-repository-bound': ['repositoryId', 'repositoryBindingId'],
      'project-repository-binding-retired': ['repositoryId', 'repositoryBindingId'],
    } as const satisfies Readonly<Record<WorkspaceEventKind, readonly string[]>>;

    for (const kind of Object.keys(validEvents) as WorkspaceEventKind[]) {
      for (const [correlation, value] of correlations) {
        if (permitted[kind].includes(correlation as never)) {
          continue;
        }
        const event = cloneEvent(kind);
        event[correlation] = value;
        expect(
          workspaceEventEnvelopeSchema.safeParse(event).success,
          `${kind} must reject ${correlation}`,
        ).toBe(false);
      }
    }
  });

  it('B1-CON-012 and B1-COR-013 require payload and structural IDs to agree per kind and dimension', () => {
    const cases = [
      ['repository-registered', 'repositoryId', 'repositoryId'],
      ['repository-registered', 'repositoryInspectionId', 'inspectionId'],
      ['repository-status-changed', 'repositoryId', 'repositoryId'],
      ['repository-status-changed', 'repositoryInspectionId', 'inspectionId'],
      ['repository-evidence-changed', 'repositoryId', 'repositoryId'],
      ['repository-evidence-changed', 'repositoryInspectionId', 'inspectionId'],
      ['project-repository-bound', 'projectId', 'projectId'],
      ['project-repository-bound', 'repositoryId', 'repositoryId'],
      ['project-repository-bound', 'repositoryBindingId', 'bindingId'],
      ['project-repository-binding-retired', 'projectId', 'projectId'],
      ['project-repository-binding-retired', 'repositoryId', 'repositoryId'],
      ['project-repository-binding-retired', 'repositoryBindingId', 'bindingId'],
    ] as const satisfies readonly [WorkspaceEventKind, string, string][];

    for (const [kind, structuralKey, payloadKey] of cases) {
      const disagreement = cloneEvent(kind);
      payloadOf(disagreement)[payloadKey] = `${payloadKey}-different`;
      expect(
        workspaceEventEnvelopeSchema.safeParse(disagreement).success,
        `${kind} must reject disagreeing ${structuralKey}/${payloadKey}`,
      ).toBe(false);

      const absent = cloneEvent(kind);
      delete payloadOf(absent)[payloadKey];
      expect(
        workspaceEventEnvelopeSchema.safeParse(absent).success,
        `${kind} must reject absent ${payloadKey}`,
      ).toBe(false);

      const jsonNull = cloneEvent(kind);
      payloadOf(jsonNull)[payloadKey] = null;
      expect(
        workspaceEventEnvelopeSchema.safeParse(jsonNull).success,
        `${kind} must reject null ${payloadKey}`,
      ).toBe(false);

      const misspelled = cloneEvent(kind);
      delete payloadOf(misspelled)[payloadKey];
      payloadOf(misspelled)[`${payloadKey}Misspelled`] = disagreement[structuralKey];
      expect(
        workspaceEventEnvelopeSchema.safeParse(misspelled).success,
        `${kind} must reject misspelled ${payloadKey}`,
      ).toBe(false);
    }
  });

  it('B1-COR-012 rejects project, work-item, run, and inspection dimensions on wrong kinds', () => {
    const registeredWithProject = cloneEvent('repository-registered');
    registeredWithProject.projectId = 'project-1';
    expect(workspaceEventEnvelopeSchema.safeParse(registeredWithProject).success).toBe(false);

    for (const field of ['workItemId', 'runId', 'repositoryInspectionId'] as const) {
      const binding = cloneEvent('project-repository-bound');
      binding[field] = `${field}-extra`;
      expect(workspaceEventEnvelopeSchema.safeParse(binding).success, field).toBe(false);
    }
  });
});
