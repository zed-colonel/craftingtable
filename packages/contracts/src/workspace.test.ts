import { describe, expect, it } from 'vitest';
import { workspaceListResponseSchema } from './workspace.js';

describe('workspace contracts', () => {
  it('supports multiple authorized workspaces and every role', () => {
    const workspaces = ['owner', 'editor', 'viewer'].map((role, index) => ({
      id: `workspace-${index}`,
      name: `Workspace ${index}`,
      slug: `workspace-${index}`,
      status: 'active',
      role,
      projectCount: 1,
      admittedCount: 0,
      completedCount: 0,
      liveRunCount: 0,
      projects: [
        { id: 'project-1', name: 'AQ', admittedCount: 0, completedCount: 0, proposedCount: 3 },
      ],
    }));
    expect(workspaceListResponseSchema.safeParse({ workspaces }).success).toBe(true);
  });
});
