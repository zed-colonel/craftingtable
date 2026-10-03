import { randomUUID } from 'node:crypto';
import { operatorWaitReportSchema } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createCycleFixture, storedCycle } from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  openQuestions,
  startCycle,
  stepDaemon,
} from './execution-test-support.js';
import { OperatorWaitService, operatorWaitReport } from '../src/services/operator-wait-service.js';

/** R-C1: operator wait is measured from the cycle audit trail and shown on the dashboard. */

afterEach(cleanupExecutionFixtures);

describe('operator wait (R-C1)', () => {
  it('records the stop code with each transition and reports it by kind', async () => {
    const f = await createCycleFixture();
    const started = await startCycle(f, f.worktreeId);
    await stepDaemon(f.services);
    f.backend.latest.release(openQuestions);
    await stepDaemon(f.services, 3);
    expect(storedCycle(f, started.id).attention?.code).toBe('design-open-questions');

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
      scope: { id: 'scope', executionScope: { kind: 'slice-verification' } as never },
      final: { id: 'final', finalizationId: 'f-1' as never },
      item: { id: 'item' },
    };
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour)).toISOString();
    const storage = {
      audit: {
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
});
