import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyDatabase, openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createCycleFixture, startCycle, stepController } from './cycle-test-support.js';
import { formatVerification, verifyDatabase } from '../src/db-verify.js';
import { verified } from '../src/persisted-records.js';
import { testDataRoot } from './test-support.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A daemon database from a real cycle, copied so the fixture's own cleanup stays clean. */
async function cycleDatabase(): Promise<{ path: string; workspaceId: string }> {
  const f = await createCycleFixture({ workers: false });
  try {
    await startCycle(f);
    await stepController(f.services, 2);
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-db-verify-test-'));
    directories.push(directory);
    const path = join(directory, 'copy.sqlite');
    await copyDatabase(f.context.config.databasePath, path);
    return { path, workspaceId: f.workspaceId };
  } finally {
    await f.cleanup();
  }
}

describe('pnpm db:verify (R-H3)', () => {
  it('passes a database the daemon wrote, without touching the file it was given', async () => {
    const { path } = await cycleDatabase();
    const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = digest();

    const verification = await verifyDatabase(path);
    expect(verified(verification)).toBe(true);
    expect(verification.counts['work-cycle'].records).toBe(1);
    expect(verification.counts['agent-run'].records).toBeGreaterThan(0);
    expect(verification.counts['run-event'].records).toBeGreaterThan(0);
    expect(formatVerification(path, verification)).toMatch(/^PASS: \d+ records conform$/m);
    expect(digest()).toBe(before);
  });

  it('upcasts historical rows and reports each contract violation by field', async () => {
    const { path, workspaceId } = await cycleDatabase();
    const database = openDatabase(path);
    try {
      // A session-started event from before billing was recorded.
      const started = database
        .prepare(
          "SELECT run_id, payload_json FROM agent_run_events WHERE kind = 'session-started' LIMIT 1",
        )
        .get() as { run_id: string; payload_json: string };
      const { billing: _billing, ...legacy } = JSON.parse(started.payload_json);
      database
        .prepare(
          `INSERT INTO agent_run_events (id, workspace_id, run_id, occurred_at, kind, payload_json)
           VALUES (?, ?, ?, ?, 'session-started', ?)`,
        )
        .run(
          randomUUID(),
          workspaceId,
          started.run_id,
          new Date().toISOString(),
          JSON.stringify(legacy),
        );
      // A cycle whose policy is out of the contract's bounds.
      database
        .prepare(
          "UPDATE work_cycles SET state_json = json_set(state_json, '$.policy.maxNits', 999)",
        )
        .run();
    } finally {
      database.close();
    }

    const verification = await verifyDatabase(path);
    expect(verified(verification)).toBe(false);
    expect(verification.upcasts).toEqual({
      'run-event: session-started without billing (before 2026-09-05)': 1,
    });
    expect(verification.counts['work-cycle']).toEqual({ records: 1, invalid: 1 });
    expect(verification.invalid).toEqual([
      expect.objectContaining({
        kind: 'work-cycle',
        issues: [expect.stringMatching(/^policy\.maxNits: /)],
      }),
    ]);
    const report = formatVerification(path, verification);
    expect(report).toContain('1x run-event: session-started without billing');
    expect(report).toMatch(/1x work-cycle policy\.maxNits: .* \(for example [0-9a-f-]{36}\)/);
    expect(report).toMatch(/^FAIL: 1 invalid, 0 unreadable, 0 integrity problems/m);
  });
});
