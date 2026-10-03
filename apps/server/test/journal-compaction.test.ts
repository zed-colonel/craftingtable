import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runEventPageResponseSchema } from '@craftingtable/contracts';
import {
  type AgentRunEvent,
  type AgentRunId,
  asAgentRunEventId,
  TOOL_RESULT_PREVIEW_BYTES,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  ready,
  registerAndWorktree,
  runToFinish,
} from './execution-test-support.js';
import { compactJournal } from '../src/services/journal-compaction.js';

afterEach(cleanupExecutionFixtures);

/** A finished run plus events shaped as the daemon journaled them before R-H2. */
async function legacyRun() {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const runId = await runToFinish(state, worktree.id, { instructions: 'Legacy.' });
  const output = `${'compiler output →\n'.repeat(600)}error: done`;
  const append = (kind: AgentRunEvent['kind'], payload: object, raw: string) =>
    state.context.storage.transaction((tx) =>
      tx.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId: state.workspaceId,
        runId,
        occurredAt: new Date().toISOString(),
        kind,
        payload,
        raw,
      } as never),
    );
  append('assistant-message', { text: 'Checking.' }, '{"type":"assistant"}');
  append(
    'tool-result',
    { toolUseId: 'legacy', content: output, isError: true, truncated: false },
    `{"type":"user","content":${JSON.stringify(output)}}`,
  );
  append(
    'notice',
    { category: 'other', message: 'Backend message: mystery' },
    '{"type":"mystery"}',
  );
  const directory = join(state.context.config.execution.runsRoot, runId);
  return { state, runId, output, directory };
}

async function events(state: Awaited<ReturnType<typeof ready>>, runId: AgentRunId) {
  const page = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}/runs/${runId}/event-page?includeRaw=true`,
    headers: { cookie: state.cookie },
  });
  return runEventPageResponseSchema.parse(page.json()).events;
}

describe('journal compaction (R-H2)', () => {
  it('reports without writing, then drops raw lines and moves large bodies, audited per run', async () => {
    const { state, runId, output, directory } = await legacyRun();
    const before = await events(state, runId);
    const options = { bodyDirectory: () => directory, now: () => new Date() };

    const dry = compactJournal(state.context.storage, { ...options, apply: false });
    expect(dry.runs).toEqual([
      expect.objectContaining({ runId, rawCleared: 2, bodiesMoved: 1, bodiesKept: 0 }),
    ]);
    expect(await events(state, runId)).toEqual(before);
    expect(existsSync(join(directory, 'tool-results'))).toBe(false);

    const applied = compactJournal(state.context.storage, { ...options, apply: true });
    expect(applied.runs).toEqual(dry.runs);
    const [run] = applied.runs;
    expect(run?.bytesAfter).toBeLessThan((run?.bytesBefore ?? 0) / 2);

    const after = await events(state, runId);
    expect(after.map((event) => event.sequence)).toEqual(before.map((event) => event.sequence));
    // Only the notice the adapter could not normalize keeps its vendor line.
    expect(after.filter((event) => event.raw !== undefined).map((event) => event.kind)).toEqual([
      'notice',
    ]);
    const result = after.find(
      (event) => event.kind === 'tool-result' && event.payload.toolUseId === 'legacy',
    );
    if (result?.kind !== 'tool-result') throw new Error('Missing tool result');
    expect(Buffer.byteLength(result.payload.content)).toBeLessThanOrEqual(
      TOOL_RESULT_PREVIEW_BYTES,
    );
    const full = await state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${state.workspaceId}/runs/${runId}/tool-results/${result.payload.body?.digest}`,
      headers: { cookie: state.cookie },
    });
    expect(full.body).toBe(output);
    expect(readdirSync(join(directory, 'tool-results'))).toHaveLength(1);

    const audit = state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 100 })
      .filter((row) => row.action === 'storage.journal-compacted');
    expect(audit).toEqual([
      expect.objectContaining({
        targetId: runId,
        metadata: expect.objectContaining({ rawCleared: 2 }),
      }),
    ]);

    // A second pass finds nothing left to do.
    expect(compactJournal(state.context.storage, { ...options, apply: true }).runs).toEqual([]);

    // The journal is append-only again, with the trigger exactly as the migration wrote it.
    const database = openDatabase(state.context.config.databasePath);
    try {
      expect(() => database.prepare('UPDATE agent_run_events SET raw_json = NULL').run()).toThrow(
        /append-only/,
      );
      expect(
        database
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_run_events_no_update'")
          .get(),
      ).toEqual({
        sql: `CREATE TRIGGER agent_run_events_no_update
    BEFORE UPDATE ON agent_run_events
BEGIN
    SELECT RAISE(ABORT, 'agent_run_events is append-only');
END`,
      });
    } finally {
      database.close();
    }
  });

  it('keeps a body in the journal when its run directory is gone, and never touches live runs', async () => {
    const { state, runId } = await legacyRun();
    const result = compactJournal(state.context.storage, {
      apply: true,
      bodyDirectory: () => undefined,
      now: () => new Date(),
    });
    expect(result.runs).toEqual([
      expect.objectContaining({ runId, rawCleared: 2, bodiesMoved: 0, bodiesKept: 1 }),
    ]);
    const kept = (await events(state, runId)).find(
      (event) => event.kind === 'tool-result' && event.payload.toolUseId === 'legacy',
    );
    expect(kept?.kind === 'tool-result' && kept.payload.body).toBeUndefined();
    expect(state.context.storage.execution.runs.listEnded().map((run) => run.id)).toEqual([runId]);
  });
});
