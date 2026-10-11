import type {
  AgentProfile,
  AgentSelections,
  CycleProfiles,
  WorkspaceAgentProfile,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  type AgentContext,
  inheritanceChain,
  launchProfile,
  resolveAgent,
  resolveAgents,
  selectionSet,
} from '../../src/services/agent-resolution.js';

/** R-E5a (E5-2): the resolver's decision table, one layer against the next. */
const codex = (model: string) => ({ backend: 'codex' as const, model });
const profile = (model: string, permissionMode: AgentProfile['permissionMode']) => ({
  ...codex(model),
  permissionMode,
});
const profiles: CycleProfiles = {
  design: profile('p-design', 'unrestricted'),
  implement: profile('p-implement', 'auto'),
  review: profile('p-review', 'edit-only'),
  remediate: profile('p-remediate', 'auto'),
  investigation: codex('p-investigation'),
};
const assignment = {
  id: 'assignment',
  selections: {
    design: codex('a-design'),
    implement: { ...codex('a-implement'), reasoningEffort: 'high' },
    review: codex('a-review'),
    remediate: codex('a-remediate'),
    security: codex('a-security'),
  } satisfies AgentSelections,
};
const saved = (
  role: WorkspaceAgentProfile['role'],
  permissionMode: AgentProfile['permissionMode'] = 'auto',
): WorkspaceAgentProfile => ({ ...profile(`w-${role}`, permissionMode), role });
const fallback = { backend: 'claude-code' as const, permissionMode: 'auto' as const };
const workspace = (...roles: WorkspaceAgentProfile[]) => ({ profiles: roles, fallback });
const cycle = { layer: 'cycle-start' as const, value: profiles };
const definition = { layer: 'saved-definition' as const, value: profiles };

describe('workspace defaults, the lowest layer of a new choice', () => {
  it.each([
    ['nothing saved: the daemon default', 'design', [], fallback, { layer: 'daemon-default' }],
    [
      'a saved role',
      'design',
      [saved('design', 'edit-only')],
      profile('w-design', 'edit-only'),
      { layer: 'workspace-default', slot: 'design' },
    ],
    [
      'remediation inherits implementation',
      'remediate',
      [saved('implement')],
      profile('w-implement', 'auto'),
      { layer: 'workspace-default', slot: 'implement' },
    ],
    [
      'conflict inherits remediation',
      'conflict',
      [saved('implement'), saved('remediate', 'edit-only')],
      profile('w-remediate', 'edit-only'),
      { layer: 'workspace-default', slot: 'remediate' },
    ],
    [
      'conflict inherits implementation through remediation',
      'conflict',
      [saved('implement')],
      profile('w-implement', 'auto'),
      { layer: 'workspace-default', slot: 'implement' },
    ],
    [
      'a specialist inherits its base step only',
      'security',
      [saved('implement')],
      fallback,
      { layer: 'daemon-default' },
    ],
  ] as const)('%s', (_, purpose, rows, expected, source) => {
    const { permissionMode, ...selection } = expected;
    expect(resolveAgent({ purpose, workspace: workspace(...rows) })).toMatchObject({
      selection,
      source,
      permissionMode,
    });
  });
  it('reports the next layer down as what a saved role overrides', () => {
    expect(
      resolveAgent({
        purpose: 'remediate',
        workspace: workspace(saved('implement'), saved('remediate')),
      }).inherited,
    ).toEqual({
      selection: codex('w-implement'),
      source: { layer: 'workspace-default', slot: 'implement' },
    });
  });
});

describe('a hand-off’s continued run (R-E5b)', () => {
  const continued = { runId: 'run-1', profile: profile('continued', 'auto') };
  it('beats the daemon default, with its own permissions', () => {
    expect(resolveAgent({ purpose: 'review', workspace: workspace(), continued })).toEqual({
      selection: codex('continued'),
      source: { layer: 'continued-run', runId: 'run-1' },
      permissionMode: 'auto',
      inherited: { selection: { backend: 'claude-code' }, source: { layer: 'daemon-default' } },
    });
  });
  it('loses to a saved workspace default for the purpose or the one it inherits', () => {
    expect(
      resolveAgent({ purpose: 'remediate', workspace: workspace(saved('implement')), continued })
        .source,
    ).toEqual({ layer: 'workspace-default', slot: 'implement' });
    expect(
      resolveAgent({ purpose: 'remediate', workspace: workspace(saved('implement')), continued })
        .inherited?.source,
    ).toEqual({ layer: 'continued-run', runId: 'run-1' });
  });
});

describe('a cycle’s or a saved entry’s profiles', () => {
  it('a step: its own profile with the step’s permissions', () => {
    expect(
      resolveAgent({ purpose: 'implement', permissionMode: 'edit-only', profiles: cycle }),
    ).toEqual({
      selection: codex('p-implement'),
      source: { layer: 'cycle-start', slot: 'implement' },
      permissionMode: 'edit-only',
    });
  });
  it('a specialist it names, over the base it would inherit', () => {
    expect(
      resolveAgent({ purpose: 'investigation', profiles: definition, workspace: workspace() }),
    ).toEqual({
      selection: codex('p-investigation'),
      source: { layer: 'saved-definition', slot: 'investigation' },
      permissionMode: 'unrestricted',
      inherited: {
        selection: codex('p-design'),
        source: { layer: 'saved-definition', slot: 'design' },
      },
    });
  });
  it('a specialist it does not name inherits the base step, with the base’s permissions when no step gives them', () => {
    expect(resolveAgent({ purpose: 'security', profiles: cycle })).toEqual({
      selection: codex('p-review'),
      source: { layer: 'cycle-start', slot: 'review' },
      permissionMode: 'edit-only',
    });
    expect(
      resolveAgent({ purpose: 'security', permissionMode: 'auto', profiles: cycle }).permissionMode,
    ).toBe('auto');
  });
  it('beats the workspace defaults', () => {
    expect(
      resolveAgent({ purpose: 'design', profiles: cycle, workspace: workspace(saved('design')) })
        .source,
    ).toEqual({ layer: 'cycle-start', slot: 'design' });
  });
});

describe('a delegated integration resolution’s profile (conflict only)', () => {
  const delegated = { id: 'grant', profile: profile('d-conflict', 'edit-only') };
  it('beats the remediation profile conflict inherits', () => {
    expect(
      resolveAgent({ purpose: 'conflict', profiles: definition, delegation: delegated }),
    ).toEqual({
      selection: codex('d-conflict'),
      source: { layer: 'roadmap-delegation', delegationId: 'grant' },
      permissionMode: 'edit-only',
      inherited: {
        selection: codex('p-remediate'),
        source: { layer: 'saved-definition', slot: 'remediate' },
      },
    });
  });
  it('without a grant it is the saved definition’s automation', () => {
    expect(
      resolveAgent({
        purpose: 'conflict',
        profiles: definition,
        delegation: { profile: delegated.profile },
      }).source,
    ).toEqual({ layer: 'roadmap-automation' });
  });
  it('loses to a conflict specialist the profiles name', () => {
    const named = { ...definition, value: { ...profiles, conflict: codex('p-conflict') } };
    expect(
      resolveAgent({ purpose: 'conflict', profiles: named, delegation: delegated }).source,
    ).toEqual({ layer: 'saved-definition', slot: 'conflict' });
  });
  it('is ignored for any other purpose, a specialist that inherits included', () => {
    expect(
      resolveAgent({ purpose: 'remediate', profiles: definition, delegation: delegated }).source,
    ).toEqual({ layer: 'saved-definition', slot: 'remediate' });
    expect(
      resolveAgent({ purpose: 'security', profiles: definition, delegation: delegated }).source,
    ).toEqual({ layer: 'saved-definition', slot: 'review' });
  });
});

describe('a roadmap’s ADR-064 assignment and a service retry', () => {
  const retry = profile('retry', 'edit-only');
  it('a service retry beats the profiles, with its recorded permissions', () => {
    expect(
      resolveAgent({
        purpose: 'implement',
        permissionMode: 'auto',
        serviceRetry: retry,
        profiles: cycle,
      }),
    ).toEqual({
      selection: codex('retry'),
      source: { layer: 'service-retry' },
      permissionMode: 'edit-only',
      inherited: {
        selection: codex('p-implement'),
        source: { layer: 'cycle-start', slot: 'implement' },
      },
    });
  });
  it('the assignment beats a service retry and the profiles, with the step’s permissions', () => {
    expect(
      resolveAgent({
        purpose: 'implement',
        permissionMode: 'auto',
        assignment,
        serviceRetry: retry,
        profiles: definition,
      }),
    ).toEqual({
      selection: { ...codex('a-implement'), reasoningEffort: 'high' },
      source: { layer: 'roadmap-assignment', slot: 'implement', assignmentId: 'assignment' },
      permissionMode: 'auto',
      inherited: { selection: codex('retry'), source: { layer: 'service-retry' } },
    });
  });
  it('a specialist inherits within the assignment, never from the profiles below it', () => {
    expect(
      resolveAgent({
        purpose: 'investigation',
        permissionMode: 'edit-only',
        assignment,
        profiles: definition,
      }),
    ).toMatchObject({
      selection: codex('a-design'),
      source: { layer: 'roadmap-assignment', slot: 'design', assignmentId: 'assignment' },
    });
    expect(
      resolveAgent({
        purpose: 'security',
        permissionMode: 'edit-only',
        assignment,
        profiles: definition,
      }),
    ).toMatchObject({
      selection: codex('a-security'),
      source: { layer: 'roadmap-assignment', slot: 'security' },
      inherited: { source: { layer: 'roadmap-assignment', slot: 'review' } },
    });
  });
});

describe('per-action choices', () => {
  const resolution = profile('resolution', 'unrestricted');
  const stage = profile('stage', 'edit-only');
  const base: AgentContext = {
    purpose: 'review',
    permissionMode: 'auto',
    assignment,
    profiles: definition,
    workspace: workspace(saved('review')),
  };
  it('an integration resolution’s recorded profile beats the assignment, with its own permissions', () => {
    expect(resolveAgent({ ...base, integrationResolution: resolution })).toMatchObject({
      selection: codex('resolution'),
      source: { layer: 'integration-resolution' },
      permissionMode: 'unrestricted',
    });
  });
  it('a finalization stage’s profile beats a resolution; the next layer down is what it overrides (E5-3)', () => {
    const finalization = { stage, slot: 'review' as const, stageIndex: 2 };
    expect(
      resolveAgent({ purpose: 'review', finalization, workspace: workspace(saved('review')) }),
    ).toEqual({
      selection: codex('stage'),
      source: { layer: 'finalization-stage', slot: 'review', stageIndex: 2 },
      permissionMode: 'edit-only',
      inherited: {
        selection: codex('w-review'),
        source: { layer: 'workspace-default', slot: 'review' },
      },
    });
    expect(
      resolveAgent({ ...base, integrationResolution: resolution, finalization }).source.layer,
    ).toBe('finalization-stage');
  });
  it('finalization’s recovery agent beats its stage, with the stage’s permissions; null restores the stage (ADR-040)', () => {
    const finalization = {
      stage,
      slot: 'implement' as const,
      stageIndex: 1,
      recovery: codex('switched'),
    };
    expect(resolveAgent({ purpose: 'remediate', finalization })).toEqual({
      selection: codex('switched'),
      source: { layer: 'finalization-recovery', slot: 'implement', stageIndex: 1 },
      permissionMode: 'edit-only',
      inherited: {
        selection: codex('stage'),
        source: { layer: 'finalization-stage', slot: 'implement', stageIndex: 1 },
      },
    });
    expect(
      resolveAgent({ purpose: 'remediate', finalization: { ...finalization, recovery: null } })
        .source.layer,
    ).toBe('finalization-stage');
    // The legacy final reviewer has no stage index.
    expect(
      resolveAgent({ purpose: 'review', finalization: { stage, slot: 'review' } }).source,
    ).toEqual({
      layer: 'finalization-stage',
      slot: 'review',
    });
  });
  it.each([
    'design-recovery',
    'investigation',
    'decision-preparation',
    'integration-resolution',
  ] as const)(
    'the command’s own %s choice beats every recorded layer, with the step’s permissions unless it names its own',
    (layer) => {
      const finalization = { stage, slot: 'review' as const, stageIndex: 0, recovery: codex('x') };
      const context = {
        ...base,
        integrationResolution: resolution,
        finalization,
        action: { layer, selection: { ...codex('chosen'), reasoningEffort: 'low' as const } },
      };
      expect(resolveAgent(context)).toMatchObject({
        selection: { ...codex('chosen'), reasoningEffort: 'low' },
        source: { layer },
        permissionMode: 'auto',
        inherited: { source: { layer: 'finalization-recovery' } },
      });
      expect(
        resolveAgent({ ...context, action: { ...context.action, permissionMode: 'edit-only' } })
          .permissionMode,
      ).toBe('edit-only');
    },
  );
  it('a resumed session keeps its run’s agent over everything', () => {
    expect(
      resolveAgent({
        ...base,
        action: { layer: 'design-recovery', selection: codex('chosen') },
        resumed: profile('resumed', 'unrestricted'),
      }),
    ).toMatchObject({
      selection: codex('resumed'),
      source: { layer: 'resumed-session' },
      permissionMode: 'unrestricted',
      inherited: { source: { layer: 'design-recovery' } },
    });
  });
});

describe('the resolver’s helpers', () => {
  it('needs at least one layer', () => {
    expect(() => resolveAgent({ purpose: 'design' })).toThrow();
  });
  it('a selection set has every step and only the specialists the winning layer names', () => {
    expect(selectionSet(resolveAgents({ profiles: cycle }))).toEqual({
      design: codex('p-design'),
      implement: codex('p-implement'),
      review: codex('p-review'),
      remediate: codex('p-remediate'),
      investigation: codex('p-investigation'),
    });
    expect(selectionSet(resolveAgents({ assignment, profiles: definition }))).toEqual(
      assignment.selections,
    );
  });
  it('launches with permissions only when the place has them', () => {
    expect(
      launchProfile(resolveAgent({ purpose: 'design', permissionMode: 'auto', profiles: cycle })),
    ).toEqual(profile('p-design', 'auto'));
    expect(() => launchProfile(resolveAgent({ purpose: 'design', assignment }))).toThrow();
  });
  it('inherits nearest first', () => {
    expect(inheritanceChain('conflict')).toEqual(['conflict', 'remediate', 'implement']);
    expect(inheritanceChain('acceptance')).toEqual(['acceptance', 'review']);
    expect(inheritanceChain('design')).toEqual(['design']);
  });
});
