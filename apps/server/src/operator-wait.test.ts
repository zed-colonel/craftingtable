import { operatorWaitReportSchema } from '@craftingtable/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
  openQuestions,
  startCycle,
  stepController,
  storedCycle,
} from './cycle-test-support.js';

/** R-C1: operator wait is measured from the cycle audit trail and shown on the dashboard. */

const fixtures: CycleFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

describe('operator wait (R-C1)', () => {
  it('records the stop code with each transition and reports it by kind', async () => {
    const f = await createCycleFixture({ workers: false });
    fixtures.push(f);
    const started = await startCycle(f);
    await stepController(f.services);
    f.backend.latest.release(openQuestions);
    await stepController(f.services, 3);
    expect(storedCycle(f, started.id).attention?.code).toBe('design-open-questions');

    const recorded = f.context.storage.audit
      .listCycleTransitions(f.workspaceId, new Date(Date.now() + 60_000).toISOString())
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
});
