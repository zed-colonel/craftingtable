import { describe, expect, it } from 'vitest';
import {
  isWorkspaceEventKind,
  WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA,
  WORKSPACE_EVENT_KINDS,
} from './workspace-events.js';

describe('workspace event vocabulary', () => {
  it('B1-STO-010 registers the exact nine-kind schema-introduction vocabulary', () => {
    expect(WORKSPACE_EVENT_KINDS).toEqual([
      'workspace-created',
      'project-created',
      'plan-version-imported',
      'work-item-admitted',
      'repository-registered',
      'repository-status-changed',
      'repository-evidence-changed',
      'project-repository-bound',
      'project-repository-binding-retired',
    ]);
    expect(WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA).toEqual({
      'workspace-created': 1,
      'project-created': 2,
      'plan-version-imported': 2,
      'work-item-admitted': 2,
      'repository-registered': 4,
      'repository-status-changed': 4,
      'repository-evidence-changed': 4,
      'project-repository-bound': 4,
      'project-repository-binding-retired': 4,
    });
    expect(Object.keys(WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA)).toEqual(WORKSPACE_EVENT_KINDS);
  });

  it('rejects unregistered kinds', () => {
    expect(isWorkspaceEventKind('work-item-imported')).toBe(false);
    expect(isWorkspaceEventKind('run-started')).toBe(false);
    expect(isWorkspaceEventKind('')).toBe(false);
  });
});
