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
    }));
    expect(workspaceListResponseSchema.safeParse({ workspaces }).success).toBe(true);
  });
});
