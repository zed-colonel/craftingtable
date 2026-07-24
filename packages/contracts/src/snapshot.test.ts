import { describe, expect, it } from 'vitest';
import { workspaceSnapshotResponseSchema } from './snapshot.js';

describe('workspace snapshot contract', () => {
  it('uses a global nonnegative as-of cursor and strict status summary', () => {
    expect(
      workspaceSnapshotResponseSchema.safeParse({
        workspace: {
          id: 'workspace-1',
          name: 'Default workspace',
          slug: 'default',
          status: 'active',
          role: 'owner',
        },
        asOfSequence: 0,
        statusSummary: { needsAttention: 0, active: 0, ready: 0, blocked: 0 },
        recentActivity: [],
      }).success,
    ).toBe(true);
  });
});
