import { describe, expect, it } from 'vitest';
import { workspaceSnapshotResponseSchema } from './snapshot.js';

const EMPTY_RISK_COUNTS = { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 };

const snapshot = {
  workspace: {
    id: 'workspace-1',
    name: 'Default workspace',
    slug: 'default',
    status: 'active',
    role: 'owner',
  },
  asOfSequence: 0,
  statusSummary: { needsAttention: 0, active: 0, planningReady: 0, dependencyBlocked: 0 },
  planningSummary: {
    projectCount: 0,
    importAttentionCount: 0,
    proposedCount: 0,
    admittedCount: 0,
    planningReadyCount: 0,
    dependencyBlockedCount: 0,
    riskCounts: EMPTY_RISK_COUNTS,
  },
  projects: [],
  recentActivity: [],
};

describe('workspace snapshot contract', () => {
  it('uses a global nonnegative as-of cursor and strict status summary', () => {
    expect(workspaceSnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
  });

  it('names planning readiness unambiguously rather than a bare "ready"', () => {
    // CT-03 owns planning readiness only; `ready`/`blocked` would be
    // indistinguishable from executable or merge readiness (ADR-015).
    const legacy = {
      ...snapshot,
      statusSummary: { needsAttention: 0, active: 0, ready: 0, blocked: 0 },
    };
    expect(workspaceSnapshotResponseSchema.safeParse(legacy).success).toBe(false);
  });

  it('requires the planning summary and project list', () => {
    const { planningSummary: _summary, ...withoutSummary } = snapshot;
    expect(workspaceSnapshotResponseSchema.safeParse(withoutSummary).success).toBe(false);
    const { projects: _projects, ...withoutProjects } = snapshot;
    expect(workspaceSnapshotResponseSchema.safeParse(withoutProjects).success).toBe(false);
  });

  it('rejects unknown snapshot fields', () => {
    expect(workspaceSnapshotResponseSchema.safeParse({ ...snapshot, secret: 'no' }).success).toBe(
      false,
    );
  });

  it('bounds the embedded project list so the snapshot stays lightweight', () => {
    const project = {
      id: 'project-1',
      name: 'AQ',
      slug: 'aq',
      versionCount: 1,
      warningCount: 0,
      createdAt: '2026-07-24T00:00:00.000Z',
      proposedCount: 0,
      admittedCount: 0,
      planningReadyCount: 0,
      dependencyBlockedCount: 0,
      riskCounts: EMPTY_RISK_COUNTS,
    };
    expect(
      workspaceSnapshotResponseSchema.safeParse({ ...snapshot, projects: [project] }).success,
    ).toBe(true);
    expect(
      workspaceSnapshotResponseSchema.safeParse({
        ...snapshot,
        projects: Array.from({ length: 51 }, () => project),
      }).success,
    ).toBe(false);
  });
});
