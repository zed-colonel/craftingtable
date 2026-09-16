import { describe, expect, it } from 'vitest';
import {
  isWorkspaceEventKind,
  WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA,
  WORKSPACE_EVENT_KINDS,
} from './workspace-events.js';

describe('workspace event vocabulary', () => {
  it('registers the exact schema-introduction vocabulary', () => {
    expect(WORKSPACE_EVENT_KINDS).toEqual([
      'workspace-created',
      'project-created',
      'plan-version-imported',
      'work-item-admitted',
      'work-item-removed-from-agenda',
      'repository-registered',
      'repository-status-changed',
      'repository-evidence-changed',
      'project-repository-bound',
      'project-repository-binding-retired',
      'source-repository-registered',
      'worktree-created',
      'worktree-removed',
      'agent-run-started',
      'agent-run-status-changed',
      'workspace-updated',
      'work-item-completed',
      'worktree-merged',
      'work-cycle-changed',
      'branches-changed',
      'notifications-changed',
      'roadmap-changed',
    ]);
    expect(WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA).toEqual({
      'workspace-created': 1,
      'project-created': 2,
      'plan-version-imported': 2,
      'work-item-admitted': 2,
      'work-item-removed-from-agenda': 17,
      'repository-registered': 4,
      'repository-status-changed': 4,
      'repository-evidence-changed': 4,
      'project-repository-bound': 4,
      'project-repository-binding-retired': 4,
      'source-repository-registered': 5,
      'worktree-created': 5,
      'worktree-removed': 5,
      'agent-run-started': 5,
      'agent-run-status-changed': 5,
      'workspace-updated': 6,
      'work-item-completed': 6,
      'worktree-merged': 6,
      'work-cycle-changed': 9,
      'branches-changed': 10,
      'notifications-changed': 11,
      'roadmap-changed': 12,
    });
    expect(Object.keys(WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA)).toEqual(WORKSPACE_EVENT_KINDS);
  });

  it('rejects unregistered kinds', () => {
    expect(isWorkspaceEventKind('work-item-imported')).toBe(false);
    expect(isWorkspaceEventKind('run-started')).toBe(false);
    expect(isWorkspaceEventKind('')).toBe(false);
  });
});
