import { existsSync, rmSync } from 'node:fs';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, TEST_PASSWORD, TEST_USERNAME } from './test-support.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("a test daemon's cleanup (TS-M14)", () => {
  it('closes the daemon, and removes its data directory when the record check fails (ARCH F8d)', async () => {
    const context = await createTestContext();
    directories.push(context.directory);
    const { workspace } = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    // A stored event whose kind no release knows: `db:verify`, and so the cleanup, refuses it.
    const database = openDatabase(context.storage.databasePath);
    try {
      database
        .prepare(
          `INSERT INTO workspace_event_kinds (kind, introduced_in_schema)
           VALUES ('future-event-kind', 5)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO workspace_events (
             id, schema_version, occurred_at, workspace_id, kind, payload_json
           ) VALUES ('event-unknown-kind', 1, '2026-10-02T00:00:00.000Z', ?, 'future-event-kind', '{}')`,
        )
        .run(workspace.id);
    } finally {
      database.close();
    }

    await expect(context.cleanup()).rejects.toThrow('break their contracts (R-H3)');
    expect(existsSync(context.directory)).toBe(false);
    // The daemon closed as production's does: its server answers nothing, its storage is shut.
    await expect(context.app.inject({ method: 'GET', url: '/api/session' })).rejects.toThrow();
    expect(() => context.storage.users.findByNormalizedUsername(TEST_USERNAME)).toThrow();
  });
});
