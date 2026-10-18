import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentBackend, AgentLaunchRequest } from '@craftingtable/agents';
import { runProfilesResponseSchema, workCycleResponseSchema } from '@craftingtable/contracts';
import {
  type AgentBackendKind,
  type AgentRun,
  agentSelections,
  asAgentAssignmentId,
  asAgentRunId,
  asRoadmapAttemptId,
  asRoadmapEntryId,
  type CycleProfiles,
  type Roadmap,
  type WorkCycle,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cycleLaunchInput } from '../src/services/run/context/launch-input.js';
import {
  cleanupExecutionFixtures,
  commitFile,
  currentCycle,
  cycleFixture,
  cycleProfiles,
  designDone,
  entryIds,
  git,
  implementationDone,
  mutationHeaders,
  parallelFixture,
  type Ready,
  ready,
  reviewText,
  roadmapControl,
  roadmapId,
  ScriptedBackend,
  saveRoadmapRequest,
  startCycle,
  storedRoadmap,
  useIntegration,
  useStepModels,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * Characterization of today's agent selection at the daemon's service-level places (R-E5a,
 * DATA-11): which backend, model, effort and permissions each launch gets, and from where.
 * `resolveAgent` replaces each place's body; these tests stay as they are. The pure policy
 * places are pinned in `services/agent-selection-places.test.ts`.
 */

const post = (state: Ready, path: string, payload: unknown) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}${path}`,
    headers: mutationHeaders(state),
    payload: payload as Record<string, unknown>,
  });

describe('workspace defaults (GET run-profiles)', () => {
  it('an unsaved role inherits its parent’s saved profile: remediation from implementation, a specialist from its base step, conflict through remediation', async () => {
    const backends = new Map<AgentBackendKind, AgentBackend>([
      ['codex', new ScriptedBackend('codex')],
      ['claude-code', new ScriptedBackend('claude-code')],
    ]);
    const state = await ready({ backends });
    const saved = await post(state, '/run-profiles', {
      profiles: [
        { role: 'design', backend: 'codex', model: 'design', permissionMode: 'edit-only' },
        { role: 'implement', backend: 'codex', model: 'implement', permissionMode: 'auto' },
        { role: 'review', backend: 'codex', model: 'review', permissionMode: 'edit-only' },
        { role: 'checkpoint', backend: 'codex', model: 'checkpoint', permissionMode: 'auto' },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const listed = runProfilesResponseSchema.parse(saved.json()).profiles;
    const profile = (role: string) => listed.find((p) => p.role === role);
    expect(profile('remediate')).toEqual({
      role: 'remediate',
      backend: 'codex',
      model: 'implement',
      permissionMode: 'auto',
      stored: false,
    });
    expect(profile('conflict')).toEqual({ ...profile('remediate'), role: 'conflict' });
    expect(profile('security')).toEqual({
      role: 'security',
      backend: 'codex',
      model: 'review',
      permissionMode: 'edit-only',
      stored: false,
    });
    expect(profile('investigation')).toMatchObject({ model: 'design', stored: false });
    expect(profile('checkpoint')).toMatchObject({ model: 'checkpoint', stored: true });
    // A saved remediation is its own, and conflict then inherits it.
    const remediation = await post(state, '/run-profiles', {
      profiles: [
        { role: 'implement', backend: 'codex', model: 'implement', permissionMode: 'auto' },
        { role: 'remediate', backend: 'codex', model: 'remediate', permissionMode: 'edit-only' },
      ],
    });
    const after = runProfilesResponseSchema.parse(remediation.json()).profiles;
    expect(after.find((p) => p.role === 'conflict')).toEqual({
      role: 'conflict',
      backend: 'codex',
      model: 'remediate',
      permissionMode: 'edit-only',
      stored: false,
    });
    // An unsaved base step is the daemon's default backend with auto permissions.
    expect(after.find((p) => p.role === 'design')).toEqual({
      role: 'design',
      backend: 'claude-code',
      permissionMode: 'auto',
      stored: false,
    });
  });
});

describe('a cycle’s launch (startForCycle)', () => {
  /**
   * A cycle that finished its design and holds its implementation, so the stored cycle runs and
   * a finished design run with a session exists. Each case hands `startForCycle` the stored cycle
   * with one change and records what it would launch.
   */
  async function launchFixture() {
    const f = await cycleFixture([]);
    f.backend.replyForRequest = (request: AgentLaunchRequest) =>
      request.model === 'design-model'
        ? designDone
        : { resultText: 'Held.', release: new Promise<void>(() => {}) };
    const profiles: CycleProfiles = {
      ...cycleProfiles,
      review: { ...cycleProfiles.review, permissionMode: 'edit-only' },
      investigation: { backend: 'claude-code', model: 'investigation-model' },
    };
    const started = await startCycle(f.state, f.worktree.id, { profiles });
    await waitFor(
      () =>
        currentCycle(f.state, started).step === 'implement' &&
        f.state.context.storage.execution.runs.find(
          f.state.workspaceId,
          currentCycle(f.state, started).currentRunId,
        )?.status === 'running',
      'implementation held',
    );
    const stored = currentCycle(f.state, started);
    const design = f.state.context.storage.execution.runs
      .listForWorktree(f.state.workspaceId, f.worktree.id)
      .find((r) => r.role === 'design')!;
    // What a cycle's launch is given (R-B7: run-context's `cycleLaunchInput`, which
    // `startForCycle` hands the launch after its checks).
    const launch = async (changes: Partial<WorkCycle>) => {
      const { input, provenance } = cycleLaunchInput(f.state.context.storage, {
        ...stored,
        currentRunId: asAgentRunId(randomUUID()),
        ...changes,
      } as WorkCycle);
      return {
        agent: {
          backend: input.backend,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          permissionMode: input.permissionMode,
        },
        provenance,
      };
    };
    return { ...f, stored, design, launch };
  }
  const agent = (model: string, permissionMode: string, reasoningEffort?: string) => ({
    backend: 'claude-code',
    model,
    reasoningEffort,
    permissionMode,
  });

  it('a cycle no roadmap owns launches each step with its own profile and that step’s permissions', async () => {
    const { launch } = await launchFixture();
    expect(await launch({})).toEqual({
      agent: agent('implement-model', 'auto'),
      provenance: { purpose: 'implement' },
    });
    expect(await launch({ step: 'review' })).toEqual({
      agent: agent('review-model', 'edit-only'),
      provenance: { purpose: 'review' },
    });
  });

  // The rows above read `cycleLaunchInput`; this one shows `startForCycle` hands the launch
  // exactly what it gives (R-B7 increment 11a review, LOW-1).
  it('startForCycle launches with the cycle’s launch input and its provenance', async () => {
    const { state, stored } = await launchFixture();
    const runs = state.context.services.agentRunService as unknown as {
      launcher: { launch: (...args: unknown[]) => Promise<AgentRun> };
    };
    const launched = vi
      .spyOn(runs.launcher, 'launch')
      .mockImplementation(async () => ({}) as AgentRun);
    const cycle = {
      ...stored,
      currentRunId: asAgentRunId(randomUUID()),
      step: 'review',
    } as WorkCycle;
    await state.context.services.agentRunService.startForCycle(cycle);
    const { input, provenance } = cycleLaunchInput(state.context.storage, cycle);
    expect(launched).toHaveBeenCalledTimes(1);
    expect(launched.mock.calls[0]).toEqual([
      cycle.workspaceId,
      cycle.workItemId,
      input,
      { userId: cycle.createdByUserId },
      undefined,
      cycle,
      provenance,
    ]);
  });

  it('design questions: the operator’s choice, with the design step’s permissions', async () => {
    const { launch, design } = await launchFixture();
    const currentRunId = asAgentRunId(randomUUID());
    const recovery = {
      runId: currentRunId,
      sourceRunId: design.id,
      profile: { backend: 'claude-code', model: 'recovery-model', reasoningEffort: 'low' },
      instructions: '',
      attachments: [],
      snapshotDigest: 'a'.repeat(64),
      facts: [],
      sources: [],
    };
    for (const mode of ['investigate', 'continue'] as const)
      expect(
        await launch({
          step: 'design',
          currentRunId,
          designRecovery: { ...recovery, mode },
        } as unknown as Partial<WorkCycle>),
      ).toEqual({
        agent: agent('recovery-model', 'auto', 'low'),
        provenance: { purpose: mode === 'investigate' ? 'investigation' : 'design' },
      });
  });

  it('an integration resolution: its own recorded profile, permissions included', async () => {
    const { launch } = await launchFixture();
    const sha = 'b'.repeat(40);
    expect(
      await launch({
        step: 'remediate',
        integrationResolution: {
          id: randomUUID(),
          status: 'resolving',
          headSha: sha,
          targetSha: sha,
          targetBranch: 'main',
          paths: ['README.md'],
          diagnostics: '',
          createdAt: new Date().toISOString(),
          attempts: 1,
          profile: {
            backend: 'claude-code',
            model: 'resolution-model',
            permissionMode: 'unrestricted',
          },
        },
      }),
    ).toEqual({
      agent: agent('resolution-model', 'unrestricted'),
      provenance: { purpose: 'conflict' },
    });
  });

  it('a service retry keeps the retry profile it recorded', async () => {
    const { launch, design } = await launchFixture();
    expect(
      await launch({
        providerRecovery: {
          attempts: 1,
          sourceRunId: design.id,
          failure: {
            kind: 'capacity',
            message: 'Overloaded.',
            safeToRetry: true,
          },
          profile: { backend: 'claude-code', model: 'retry-model', permissionMode: 'edit-only' },
          nextRetryAt: new Date().toISOString(),
        },
      } as unknown as Partial<WorkCycle>),
    ).toEqual({
      agent: agent('retry-model', 'edit-only'),
      provenance: { purpose: 'implement' },
    });
  });

  it('a resumed session keeps the agent it was started with, whatever the profiles now say', async () => {
    const { launch, design, stored } = await launchFixture();
    expect(
      await launch({
        step: 'design',
        parentRunId: design.id,
        outputRepair: {
          attempts: 1,
          sourceRunId: design.id,
          code: 'design-report-invalid',
          issues: [],
        },
        profiles: { ...stored.profiles, design: { ...stored.profiles.design, model: 'changed' } },
      } as unknown as Partial<WorkCycle>),
    ).toEqual({
      agent: agent('design-model', 'auto'),
      provenance: { purpose: 'design' },
    });
  });

  // Operator decision 2026-10-07 (R-E5a question 2): a run names the assignment only when the
  // assignment chose its agent. Characterized before: also when another layer's equal choice ran.
  it('a roadmap’s cycle: its latest assignment beats a service retry; only the assignment’s own choice names it', async () => {
    const { state, launch, design, stored } = await launchFixture();
    const assignment = {
      id: asAgentAssignmentId(randomUUID()),
      entryIds: [asRoadmapEntryId('entry')],
      selections: {
        ...agentSelections(stored.profiles),
        implement: {
          backend: 'claude-code' as const,
          model: 'assigned-implement',
          reasoningEffort: 'high' as const,
        },
        design: { backend: 'claude-code' as const, model: 'assigned-design' },
      },
      appliedAt: new Date().toISOString(),
      appliedByUserId: state.userId,
    };
    const roadmap = {
      id: randomUUID(),
      workspaceId: state.workspaceId,
      status: 'running',
      version: 1,
      definition: { entries: [{ id: 'entry', profiles: stored.profiles }] },
      attempts: [{ id: 'attempt', entryId: 'entry', cycleId: stored.id, status: 'active' }],
      agentAssignments: [assignment],
    } as unknown as Roadmap;
    const find = state.context.storage.roadmaps.find.bind(state.context.storage.roadmaps);
    vi.spyOn(state.context.storage.roadmaps, 'find').mockImplementation((ws, id) =>
      id === roadmap.id ? roadmap : find(ws, id),
    );
    const owner = {
      roadmapId: roadmap.id,
      attemptId: asRoadmapAttemptId('attempt'),
      entryId: asRoadmapEntryId('entry'),
      definitionRevision: 1,
    };
    expect(await launch({ owner })).toEqual({
      agent: agent('assigned-implement', 'auto', 'high'),
      provenance: { purpose: 'implement', assignmentId: assignment.id },
    });
    expect(
      await launch({
        owner,
        providerRecovery: {
          attempts: 1,
          sourceRunId: design.id,
          failure: { kind: 'capacity', message: 'Overloaded.', safeToRetry: true },
          profile: { backend: 'claude-code', model: 'retry-model', permissionMode: 'edit-only' },
          nextRetryAt: new Date().toISOString(),
        },
      } as unknown as Partial<WorkCycle>),
    ).toEqual({
      agent: agent('assigned-implement', 'auto', 'high'),
      provenance: { purpose: 'implement', assignmentId: assignment.id },
    });
    const currentRunId = asAgentRunId(randomUUID());
    const recovery = (model: string) =>
      ({
        step: 'design',
        owner,
        currentRunId,
        designRecovery: {
          runId: currentRunId,
          sourceRunId: design.id,
          mode: 'continue',
          profile: { backend: 'claude-code', model },
          instructions: '',
          attachments: [],
          snapshotDigest: 'a'.repeat(64),
          facts: [],
          sources: [],
        },
      }) as unknown as Partial<WorkCycle>;
    // An equal selection the recovery chose does not name the assignment.
    expect(await launch(recovery('assigned-design'))).toEqual({
      agent: agent('assigned-design', 'auto'),
      provenance: { purpose: 'design' },
    });
    expect(await launch(recovery('other-design'))).toEqual({
      agent: agent('other-design', 'auto'),
      provenance: { purpose: 'design' },
    });
    // Nor does a resumed session whose agent the assignment would also choose, when the run it
    // continues did not name the assignment (operator decision 2026-10-07: a resume keeps the
    // attribution of the run it continues; this design run was launched before any owner).
    (roadmap.agentAssignments as unknown as (typeof assignment)[]).push({
      ...assignment,
      id: asAgentAssignmentId(randomUUID()),
      selections: {
        ...assignment.selections,
        design: { backend: 'claude-code', model: 'design-model' },
      },
    });
    expect(
      await launch({
        owner,
        step: 'design',
        parentRunId: design.id,
        outputRepair: {
          attempts: 1,
          sourceRunId: design.id,
          code: 'design-report-invalid',
          issues: [],
        },
      } as unknown as Partial<WorkCycle>),
    ).toEqual({ agent: agent('design-model', 'auto'), provenance: { purpose: 'design' } });
  });

  // Operator decisions 2026-10-07 (R-E5a review MEDIUM-1, LOW-1): a resumed session keeps the
  // assignment the run it continues named, while that assignment is still the entry's latest.
  it('a resumed session names the assignment its run named, until a newer one replaces it', async () => {
    const { state, launch, design, stored } = await launchFixture();
    const first = {
      id: asAgentAssignmentId(randomUUID()),
      entryIds: [asRoadmapEntryId('entry')],
      selections: agentSelections(stored.profiles),
      appliedAt: new Date().toISOString(),
      appliedByUserId: state.userId,
    };
    const roadmap = {
      id: randomUUID(),
      workspaceId: state.workspaceId,
      status: 'running',
      version: 1,
      definition: { entries: [{ id: 'entry', profiles: stored.profiles }] },
      attempts: [{ id: 'attempt', entryId: 'entry', cycleId: stored.id, status: 'active' }],
      agentAssignments: [first],
    } as unknown as Roadmap;
    const find = state.context.storage.roadmaps.find.bind(state.context.storage.roadmaps);
    vi.spyOn(state.context.storage.roadmaps, 'find').mockImplementation((ws, id) =>
      id === roadmap.id ? roadmap : find(ws, id),
    );
    // The design run as the assignment launched it, naming it.
    const runs = state.context.storage.execution.runs;
    const findRun = runs.find.bind(runs);
    vi.spyOn(runs, 'find').mockImplementation((ws, id) =>
      id === design.id
        ? { ...design, profileSelection: { purpose: 'design', assignmentId: first.id } }
        : findRun(ws, id),
    );
    const resume = {
      owner: {
        roadmapId: roadmap.id,
        attemptId: asRoadmapAttemptId('attempt'),
        entryId: asRoadmapEntryId('entry'),
        definitionRevision: 1,
      },
      step: 'design',
      parentRunId: design.id,
      outputRepair: {
        attempts: 1,
        sourceRunId: design.id,
        code: 'design-report-invalid',
        issues: [],
      },
    } as unknown as Partial<WorkCycle>;
    expect(await launch(resume)).toEqual({
      agent: agent('design-model', 'auto'),
      provenance: { purpose: 'design', assignmentId: first.id },
    });
    (roadmap.agentAssignments as unknown as (typeof first)[]).push({
      ...first,
      id: asAgentAssignmentId(randomUUID()),
    });
    expect(await launch(resume)).toEqual({
      agent: agent('design-model', 'auto'),
      provenance: { purpose: 'design' },
    });
  });
});

describe('a question stop’s investigation (R-C16)', () => {
  it('without a chosen profile, runs the cycle’s investigation selection, inherited from design, read-only', async () => {
    const f = await cycleFixture([]);
    let implementations = 0;
    f.backend.replyForRequest = (request: AgentLaunchRequest) =>
      request.readOnly
        ? { resultText: 'Nothing found.' }
        : request.model === 'design-model'
          ? designDone
          : implementations++ === 0
            ? { resultText: 'Partly implemented.\n\n## Open questions\n- Which format?' }
            : implementationDone;
    const cycle = await startCycle(f.state, f.worktree.id, {
      profiles: {
        ...cycleProfiles,
        design: { ...cycleProfiles.design, reasoningEffort: 'medium', permissionMode: 'edit-only' },
      },
    });
    await waitFor(
      () => currentCycle(f.state, cycle).attention?.code === 'implementation-open-questions',
      'implementation question',
    );
    const response = await post(f.state, `/cycles/${cycle.id}/investigation`, {
      action: 'start',
      expectedVersion: currentCycle(f.state, cycle).version,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(workCycleResponseSchema.parse(response.json()).cycle.investigation?.profile).toEqual({
      backend: 'claude-code',
      model: 'design-model',
      reasoningEffort: 'medium',
    });
    await waitFor(() => f.backend.launches.some((r) => r.readOnly), 'investigation launched');
    const launched = f.backend.launches.find((r) => r.readOnly)!;
    expect([launched.model, launched.reasoningEffort, launched.permissionMode]).toEqual([
      'design-model',
      'medium',
      'edit-only',
    ]);
  });
});

describe('an integration resolution the operator starts', () => {
  async function resolutionFixture() {
    const fixture = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const { state, backend, worktree, root } = fixture;
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model')
        commitFile(worktree.path, 'README.md', 'item behavior\n');
    };
    const cycle = await startCycle(state, worktree.id, {
      profiles: {
        ...cycleProfiles,
        remediate: { ...cycleProfiles.remediate, permissionMode: 'edit-only' },
        conflict: { backend: 'claude-code', model: 'conflict-model' },
      },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'approval');
    await post(state, `/cycles/${cycle.id}/control`, {
      action: 'pause',
      expectedVersion: currentCycle(state, cycle).version,
    });
    commitFile(root, 'README.md', 'integration behavior\n');
    const command = (input: Record<string, unknown>) =>
      post(state, `/cycles/${cycle.id}/integration-resolution`, {
        expectedVersion: currentCycle(state, cycle).version,
        ...input,
      });
    expect((await command({ action: 'inspect' })).statusCode).toBe(200);
    return { ...fixture, cycle, command };
  }

  // Operator decision 2026-10-07 (R-E5a question 3): the operator's start follows the delegated
  // rule. Characterized before as the remediation profile, the conflict specialist not consulted.
  it('without a chosen profile, starts with the cycle’s conflict specialist, with remediation’s permissions', async () => {
    const { state, backend, cycle, command } = await resolutionFixture();
    backend.replyForRequest = () => ({
      resultText: 'Need a semantic choice.\n\n## Resolution status\nblocked',
    });
    const started = await command({ action: 'start' });
    expect(started.statusCode, started.body).toBe(200);
    expect(currentCycle(state, cycle).integrationResolution?.profile).toEqual({
      backend: 'claude-code',
      model: 'conflict-model',
      permissionMode: 'edit-only',
    });
    await waitFor(
      () => currentCycle(state, cycle).status === 'needs-attention',
      'resolution asks question',
    );
    expect([backend.launches.at(-1)?.model, backend.launches.at(-1)?.permissionMode]).toEqual([
      'conflict-model',
      'edit-only',
    ]);
    // Resumed without a choice, it keeps the profile it recorded.
    const chosen = { backend: 'claude-code', model: 'chosen-model', permissionMode: 'auto' };
    const resumed = await command({ action: 'resume', profile: chosen });
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'second question');
    expect(backend.launches.at(-1)?.model).toBe('chosen-model');
    const again = await command({ action: 'resume' });
    expect(again.statusCode, again.body).toBe(200);
    expect(currentCycle(state, cycle).integrationResolution?.profile).toEqual(chosen);
  });
});

describe('an integration resolution the roadmap delegates', () => {
  it.each([
    [
      'the delegation’s resolution profile over the inherited remediation',
      'none',
      'resolution-auto',
    ],
    [
      'the definition’s own conflict specialist over the delegation’s profile',
      'explicit',
      'explicit-conflict',
    ],
    ['the latest assignment over both', 'assignment', 'assigned-remediate'],
  ] as const)('chooses %s', async (_, layer, expected) => {
    const fixture = await parallelFixture();
    const { state, backend, input } = fixture;
    await useIntegration(fixture);
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model')
        commitFile(request.cwd, 'README.md', `behavior ${request.cwd}\n`);
      if (request.model === expected) {
        writeFileSync(join(request.cwd, 'README.md'), 'both sibling behaviors\n');
        git(['add', 'README.md'], request.cwd);
      }
    };
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? designDone
        : request.model === expected
          ? { resultText: 'Combined checks passed.\n\n## Resolution status\nready' }
          : request.model === 'review-model'
            ? { resultText: reviewText([]) }
            : implementationDone;
    const profiles =
      layer === 'explicit'
        ? {
            ...cycleProfiles,
            conflict: { backend: 'claude-code' as const, model: 'explicit-conflict' },
          }
        : cycleProfiles;
    // A definition's own specialist is the workspace's when the entry is saved (R-E5b).
    await useStepModels(state, profiles);
    const saved = await saveRoadmapRequest(state, {
      ...input,
      automation: {
        integrationMerge: 'automatic',
        integrationConflicts: 'automatic',
        resolutionProfile: { ...cycleProfiles.remediate, model: 'resolution-auto' },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    if (layer === 'assignment') {
      const applied = await post(state, `/roadmaps/${roadmapId}/agent-profiles`, {
        expectedVersion: storedRoadmap(state).version,
        entryIds: [...entryIds, input.entries[2]!.id],
        selections: {
          ...agentSelections(cycleProfiles),
          remediate: { backend: 'claude-code', model: 'assigned-remediate' },
        },
      });
      expect(applied.statusCode, applied.body).toBe(200);
    }
    await roadmapControl(state, 'start');
    await waitFor(() => storedRoadmap(state).status === 'completed', 'delegated resolution');
    const resolved = state.context.storage.execution.cycles
      .listForWorkspace(state.workspaceId)
      .filter((c) => c.integrationResolution?.status === 'completed');
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.map((c) => c.integrationResolution?.profile?.model)).toEqual(
      resolved.map(() => expected),
    );
    expect(backend.launches.some((r) => r.model === expected)).toBe(true);
  });
});
