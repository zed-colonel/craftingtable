import { describe, expect, it } from 'vitest';
import { isWorkspaceEventKind, WORKSPACE_EVENT_KINDS } from './workspace-events.js';

describe('workspace event vocabulary', () => {
  it('contains the CT-02 kind plus the three CT-03 summary kinds', () => {
    expect(WORKSPACE_EVENT_KINDS).toEqual([
      'workspace-created',
      'project-created',
      'plan-version-imported',
      'work-item-admitted',
    ]);
  });

  it('rejects unregistered kinds', () => {
    expect(isWorkspaceEventKind('work-item-imported')).toBe(false);
    expect(isWorkspaceEventKind('run-started')).toBe(false);
    expect(isWorkspaceEventKind('')).toBe(false);
  });
});
