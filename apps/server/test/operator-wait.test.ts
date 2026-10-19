import { randomUUID } from 'node:crypto';
import { operatorWaitReportSchema } from '@craftingtable/contracts';
import type { Roadmap, WorkCycle } from '@craftingtable/domain';
import { asRoadmapEntryId, asRoadmapId, asWorkCycleId, heldStop } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createCycleFixture, storedCycle } from './cycle-test-support.js';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  designDone,
  implementationDone,
  mergeRoadmapAttempt,
  mutationHeaders,
  openQuestions,
  parallelFixture,
  present,
  reviewText,
  roadmapControl,
  roadmapId,
  saveRoadmapRequest,
  startCycle,
  stepDaemon,
  storedRoadmap,
} from './execution-test-support.js';
import {
  OperatorWaitService,
  operatorWaitReport,
  roadmapWaitAudit,
} from '../src/services/operator-wait-service.js';

/** R-C1: operator wait is measured from the cycle audit trail and shown on the dashboard. */

afterEach(cleanupExecutionFixtures);

describe('operator wait (R-C1)', () => {
  it('records the stop code with each transition and reports it by kind', async () => {
    const f = await createCycleFixture();
    const started = await startCycle(f, f.worktreeId);
    await stepDaemon(f.services);
    f.backend.latest.release(openQuestions);
    await stepDaemon(f.services, 3);
    expect(heldStop(storedCycle(f, started.id))?.code).toBe('design-open-questions');

    const recorded = f.context.storage.audit
      .listCycleTransitions(
        f.workspaceId,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      )
      .at(-1);
    expect(recorded?.metadata).toMatchObject({
      status: 'needs-attention',
      attention: { code: 'design-open-questions', owner: 'operator' },
    });

    const url = `/api/workspaces/${f.workspaceId}/operator-wait`;
    const response = await f.context.app.inject({ method: 'GET', url, headers: f.headers });
    expect(response.statusCode, response.body).toBe(200);
    const report = operatorWaitReportSchema.parse(response.json());
    expect(report.kinds).toEqual([
      expect.objectContaining({ kind: 'design-open-questions', stops: 1 }),
    ]);
    expect(Date.parse(report.to) - Date.parse(report.from)).toBe(7 * 86_400_000);

    expect(
      (await f.context.app.inject({ method: 'GET', url: `${url}?days=31`, headers: f.headers }))
        .statusCode,
    ).toBe(400);
    expect((await f.context.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('reports a window of exactly the requested days, from one reading of the clock', async () => {
    const f = await createCycleFixture();
    // A clock that moves on every reading, as a busy host's does between two calls.
    let ms = Date.parse('2026-09-20T00:00:00.000Z');
    const service = new OperatorWaitService(
      f.context.storage,
      f.context.services.workspaceService,
      () => new Date(ms++),
    );
    const auth = f.context.services.authService.authenticate(f.headers.cookie!.split('=')[1]!)!;
    const report = service.report(auth, f.workspaceId, 7);
    expect(Date.parse(report.to) - Date.parse(report.from)).toBe(7 * 86_400_000);
  });

  it('reads the state each cycle was in at the window start, and nothing older', async () => {
    const f = await createCycleFixture();
    const append = (cycleId: string, occurredAt: string, status: string) =>
      f.context.storage.audit.append({
        id: randomUUID(),
        occurredAt,
        actorKind: 'system',
        workspaceId: f.workspaceId,
        action: 'work-cycle.updated',
        targetType: 'work-cycle',
        targetId: cycleId,
        outcome: 'succeeded',
        metadata: { status },
      });
    append('a', '2026-09-01T00:00:00.000Z', 'running');
    append('a', '2026-09-02T00:00:00.000Z', 'paused');
    append('b', '2026-09-03T00:00:00.000Z', 'running');
    append('b', '2026-09-10T12:00:00.000Z', 'completed');
    append('a', '2026-09-11T00:00:00.000Z', 'completed');
    const rows = f.context.storage.audit.listCycleTransitions(
      f.workspaceId,
      '2026-09-10T00:00:00.000Z',
      '2026-09-12T00:00:00.000Z',
    );
    expect(rows.map((row) => [row.cycleId, row.metadata.status])).toEqual([
      ['a', 'paused'],
      ['b', 'running'],
      ['b', 'completed'],
      ['a', 'completed'],
    ]);
    const report = operatorWaitReport(f.context.storage, f.workspaceId, {
      from: new Date('2026-09-10T00:00:00.000Z'),
      to: new Date('2026-09-12T00:00:00.000Z'),
    });
    // Paused since before the window: 24 h inside it, and no stop that began inside it.
    expect(report.waitingHours).toBe(24);
    expect(report.kinds).toEqual([{ kind: 'paused', stops: 0, cycleHours: 24 }]);
  });

  it('recovers the kind of an older awaiting-merge record from the cycle it belongs to', () => {
    const cycles: Record<string, Partial<WorkCycle>> = {
      scope: {
        id: asWorkCycleId('scope'),
        executionScope: { kind: 'slice-verification' } as never,
      },
      final: { id: asWorkCycleId('final'), finalizationId: 'f-1' as never },
      item: { id: asWorkCycleId('item') },
    };
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour)).toISOString();
    const storage = {
      roadmaps: { list: () => [] },
      audit: {
        listRoadmapTransitions: () => [],
        listCycleTransitions: () =>
          Object.keys(cycles).flatMap((cycleId) => [
            {
              cycleId,
              occurredAt: at(1),
              metadata: { status: 'awaiting-merge', reason: 'Ready.' },
            },
            { cycleId, occurredAt: at(3), metadata: { status: 'completed' } },
          ]),
      },
      execution: {
        cycles: { listForWorkspace: () => Object.values(cycles) },
        runs: { activityBetween: () => [] },
      },
    } as unknown as CraftingTableStorage;
    const report = operatorWaitReport(storage, 'w' as never, {
      from: new Date(at(0)),
      to: new Date(at(24)),
    });
    expect(report.kinds.map((kind) => kind.kind).toSorted()).toEqual([
      'final-promotion',
      'merge-approval',
      'record-scope-evidence',
    ]);
  });

  it("records a roadmap write's stop and holds, and counts an item pause beside its cycle's stop (R-C10)", async () => {
    const { state, backend, input } = await parallelFixture();
    backend.replyForRequest = (request) =>
      request.model === 'design-model'
        ? request.cwd.includes('aq-02')
          ? { resultText: '## Open questions\nWhich API?' }
          : designDone
        : request.model === 'review-model'
          ? { resultText: reviewText([]) }
          : implementationDone;
    await saveRoadmapRequest(state, input);
    await roadmapControl(state, 'start');
    await mergeRoadmapAttempt(state, (await awaitRoadmapMerge(state, 0)).worktreeId);
    await awaitRoadmapMerge(state, 2);
    const left = present(storedRoadmap(state).attempts[1]);
    const paused = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'pause',
        entryId: left.entryId,
        expectedVersion: storedRoadmap(state).version,
      },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    const window = {
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
    };
    const rows = state.context.storage.audit.listRoadmapTransitions(
      state.workspaceId,
      window.from.toISOString(),
      window.to.toISOString(),
    );
    expect(rows.at(-1)?.metadata).toMatchObject({
      action: 'pause-entry',
      status: 'running',
      holds: [{ entryId: left.entryId, status: 'paused' }],
    });
    expect(rows.at(-1)?.metadata).not.toHaveProperty('attention');
    expect(rows.every((row) => Array.isArray(row.metadata.holds))).toBe(true);
    const report = operatorWaitReport(state.context.storage, state.workspaceId, {
      from: window.from,
      to: new Date(),
    });
    // The item pause also pauses the stopped cycle: the hold is a stop of its own beside the
    // cycle's pause, and its time is the cycle's.
    expect(report.kinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'design-open-questions', stops: 1 }),
        expect.objectContaining({ kind: 'paused', stops: 2 }),
      ]),
    );
  });

  it("counts a roadmap's stops and holds from its audit rows, once where its cycles wait (R-C10)", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour)).toISOString();
    const [held, owner, other] = ['held', 'owner', 'other'].map(asRoadmapEntryId);
    const [heldCycle, repairCycle, otherCycle] = ['c-held', 'c-repair', 'c-other'].map(
      asWorkCycleId,
    );
    const roadmap = {
      id: asRoadmapId('r'),
      attempts: [
        { entryId: held, cycleId: heldCycle },
        // A recovery round's repair of the held entry runs on the owning slice's entry.
        { entryId: owner, cycleId: repairCycle, recovery: { sourceEntryId: held } },
        { entryId: other, cycleId: otherCycle },
      ],
    } as unknown as Roadmap;
    const row = (hour: number, metadata: Record<string, unknown>) => ({
      roadmapId: roadmap.id,
      occurredAt: at(hour),
      metadata,
    });
    const storage = {
      roadmaps: { list: () => [roadmap] },
      audit: {
        listCycleTransitions: () => [
          {
            cycleId: repairCycle,
            occurredAt: at(2),
            metadata: {
              status: 'needs-attention',
              attention: { code: 'work-item-questions', owner: 'operator' },
            },
          },
          { cycleId: repairCycle, occurredAt: at(6), metadata: { status: 'running' } },
        ],
        listRoadmapTransitions: () => [
          row(1, {
            status: 'running',
            holds: [
              {
                entryId: held,
                status: 'needs-attention',
                code: 'entry-preparation-failed',
                owner: 'operator',
              },
            ],
          }),
          row(8, {
            status: 'needs-attention',
            attention: { code: 'scheduler-error', owner: 'operator' },
            holds: [],
          }),
          // A row an older release wrote says nothing of waits: nothing is counted from it.
          row(10, { status: 'needs-attention', reason: 'Scheduler failed.' }),
          // An ended roadmap waits on nobody, whatever holds it keeps.
          row(12, { status: 'running', holds: [{ entryId: other, status: 'paused' }] }),
          row(13, { status: 'stopped', holds: [{ entryId: other, status: 'paused' }] }),
        ],
      },
      execution: {
        cycles: { listForWorkspace: () => [] },
        runs: { activityBetween: () => [] },
      },
    } as unknown as CraftingTableStorage;
    const report = operatorWaitReport(storage, 'w' as never, {
      from: new Date(at(0)),
      to: new Date(at(24)),
    });
    expect(report).toMatchObject({ waitingHours: 10, idleWaitingHours: 10 });
    expect(report.kinds).toEqual([
      { kind: 'work-item-questions', stops: 1, cycleHours: 4 },
      // Held from 1 to 8; its repair cycle's own stop from 2 to 6 is counted once, as the cycle's.
      { kind: 'entry-preparation-failed', stops: 1, cycleHours: 3 },
      { kind: 'scheduler-error', stops: 1, cycleHours: 2 },
      { kind: 'paused', stops: 1, cycleHours: 1 },
    ]);
  });

  it("audits the roadmap's stop and every hold by code, a hold stored before codes as 0047 coded it (R-C10)", () => {
    const [cycleId, entryId] = [asWorkCycleId('c'), asRoadmapEntryId('e')];
    expect(
      roadmapWaitAudit({
        status: 'needs-attention',
        reason: 'The entry needs attention.',
        attention: {
          code: 'cycle-needs-attention',
          owner: 'operator',
          refs: { cycleId, entryId, blockers: ['binding-changed'] },
        },
        entryHolds: {
          a: {
            status: 'needs-attention',
            reason: 'Failed.',
            attention: {
              code: 'entry-preparation-failed',
              owner: 'operator',
              // The gated entry a round's hold names is not the hold's own (review M-1).
              refs: { cause: 'predecessor-merge-missing', entryId: asRoadmapEntryId('owner') },
            },
          },
          // Stored before codes: migration 0047 coded it (R-B4b), and the stored code is read.
          b: {
            status: 'needs-attention',
            reason: 'Stored before codes.',
            attention: { code: 'legacy-attention', owner: 'operator' },
          },
          c: { status: 'paused', reason: 'Item paused by operator.' },
        },
      }),
    ).toEqual({
      attention: { code: 'cycle-needs-attention', owner: 'operator', cycleId, entryId },
      holds: [
        {
          entryId: 'a',
          status: 'needs-attention',
          code: 'entry-preparation-failed',
          owner: 'operator',
          cause: 'predecessor-merge-missing',
        },
        { entryId: 'b', status: 'needs-attention', code: 'legacy-attention', owner: 'operator' },
        { entryId: 'c', status: 'paused' },
      ],
    });
    // Attention belongs to a needs-attention roadmap only; a running one records its holds alone.
    expect(roadmapWaitAudit({ status: 'running', reason: '', entryHolds: {} })).toEqual({
      holds: [],
    });
  });

  // Increment 1 review M-2: each rule of what a roadmap wait counts once, pinned.
  it('merges a roadmap stop by its refs, a pause with every cycle it started, and a hold with its roadmap’s wait (R-C10)', () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour)).toISOString();
    const e1 = asRoadmapEntryId('e1');
    const e2 = asRoadmapEntryId('e2');
    const e3 = asRoadmapEntryId('e3');
    const c1 = asWorkCycleId('c1');
    const c2 = asWorkCycleId('c2');
    const c3 = asWorkCycleId('c3');
    const adopted = asWorkCycleId('c-adopted');
    const roadmap = {
      id: asRoadmapId('r'),
      attempts: [
        { entryId: e1, cycleId: c1 },
        { entryId: e3, cycleId: c3 },
      ],
      // An attempt the operator retired for re-verification is still one the roadmap started.
      retiredAttempts: [{ entryId: e2, cycleId: c2 }],
    } as unknown as Roadmap;
    const cycle = (cycleId: string, hour: number, status: string, code?: string) => ({
      cycleId,
      occurredAt: at(hour),
      metadata: { status, ...(code ? { attention: { code, owner: 'operator' } } : {}) },
    });
    const row = (hour: number, metadata: Record<string, unknown>) => ({
      roadmapId: roadmap.id,
      occurredAt: at(hour),
      metadata,
    });
    const storage = {
      roadmaps: { list: () => [roadmap] },
      audit: {
        listCycleTransitions: () => [
          cycle(c2, 1, 'paused'),
          cycle(c2, 2, 'running'),
          cycle(c2, 6, 'paused'),
          cycle(c2, 7, 'running'),
          cycle(c1, 2, 'needs-attention', 'work-item-questions'),
          cycle(c1, 4, 'running'),
          cycle(c1, 7, 'needs-attention', 'work-item-questions'),
          cycle(c1, 8, 'running'),
          cycle(c3, 3, 'needs-attention', 'step-incomplete'),
          cycle(c3, 5, 'running'),
          cycle(c3, 8, 'needs-attention', 'step-incomplete'),
          cycle(c3, 9, 'running'),
          cycle(c3, 11, 'needs-attention', 'step-incomplete'),
          cycle(c3, 13, 'running'),
          // The operator's own repair cycle an adoption hold names; not an attempt.
          cycle(adopted, 9, 'needs-attention', 'work-item-questions'),
          cycle(adopted, 10, 'running'),
        ],
        listRoadmapTransitions: () => [
          // Paused from 1 to 5, while its three cycles wait (two overlapping): counted once.
          row(1, { status: 'paused', holds: [{ entryId: e3, status: 'paused' }] }),
          // A stop naming a cycle merges with that cycle only (c2 from 6 to 7, not c1 from 7).
          row(5, {
            status: 'needs-attention',
            attention: { code: 'scheduler-error', owner: 'operator', cycleId: c2 },
            holds: [],
          }),
          // A stop naming an entry merges with that entry's cycles (c1), not c3 from 8 to 9.
          row(8, {
            status: 'needs-attention',
            attention: { code: 'entry-blocked', owner: 'operator', entryId: e1 },
            holds: [],
          }),
          // A hold naming a cycle merges with it and with its entry's cycles.
          row(9, {
            status: 'running',
            holds: [
              {
                entryId: e3,
                status: 'needs-attention',
                code: 'entry-preparation-failed',
                owner: 'operator',
                cycleId: adopted,
              },
            ],
          }),
          row(13, { status: 'running', holds: [] }),
          // Attention the operator does not own is no wait.
          row(14, {
            status: 'needs-attention',
            attention: { code: 'scheduler-error', owner: 'controller' },
            holds: [],
          }),
          row(15, { status: 'running', holds: [] }),
        ],
      },
      execution: {
        cycles: { listForWorkspace: () => [] },
        runs: { activityBetween: () => [] },
      },
    } as unknown as CraftingTableStorage;
    const report = operatorWaitReport(storage, 'w' as never, {
      from: new Date(at(0)),
      to: new Date(at(24)),
    });
    expect(report.waitingHours).toBe(12);
    expect(report.kinds).toHaveLength(6);
    expect(report.kinds).toEqual(
      expect.arrayContaining([
        { kind: 'step-incomplete', stops: 3, cycleHours: 5 },
        { kind: 'work-item-questions', stops: 3, cycleHours: 4 },
        // c2's two pauses; the roadmap's pause and its item pause are its cycles' and its own.
        { kind: 'paused', stops: 4, cycleHours: 2 },
        { kind: 'scheduler-error', stops: 1, cycleHours: 2 },
        { kind: 'entry-blocked', stops: 1, cycleHours: 1 },
        { kind: 'entry-preparation-failed', stops: 1, cycleHours: 1 },
      ]),
    );
  });
});
