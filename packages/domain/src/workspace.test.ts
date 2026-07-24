import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_STATUSES, WORKSPACE_ROLES, WORKSPACE_STATUSES } from './workspace.js';

describe('workspace vocabulary', () => {
  it('defines the foundational multi-user roles without activating them', () => {
    expect(WORKSPACE_ROLES).toEqual(['owner', 'editor', 'viewer']);
    expect(WORKSPACE_STATUSES).toEqual(['active', 'archived']);
    expect(MEMBERSHIP_STATUSES).toEqual(['active', 'revoked']);
  });
});
