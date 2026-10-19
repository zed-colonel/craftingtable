import type { GitTrust } from '@craftingtable/git';
import { afterEach, expect, it } from 'vitest';
import { trustByGeneration, trustWrites } from '../../src/services/git-trust.js';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  mutationHeaders,
  ready,
} from '../execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * The daemon's Git trust, read again only after a write that can change it (R-B5, decision 13):
 * a worktree or the storage settings written, or a repository (a table the guard does not
 * report); not at every command.
 */

type Kind = Parameters<ReturnType<typeof trustWrites>['written']>[0];

it('computes the trust once per generation', () => {
  let computed = 0;
  const trust = trustByGeneration(() => {
    computed += 1;
    return {
      trust: { commonDirectories: [], worktreeRoots: [String(computed)] } as GitTrust,
      complete: true,
    };
  });
  expect(trust.read().worktreeRoots).toEqual(['1']);
  expect(trust.read().worktreeRoots).toEqual(['1']);
  trust.bump();
  expect(trust.read().worktreeRoots).toEqual(['2']);
  expect(computed).toBe(2);
});

it('bumps on the writes the trust reads, and not on others', () => {
  let bumps = 0;
  let open = true;
  const writes = trustWrites(
    () => {
      bumps += 1;
    },
    () => open,
  );
  writes.written('worktree' as Kind, {} as never);
  writes.ended(true, 1);
  expect(bumps).toBe(2);
  writes.written('storage-settings' as Kind, {} as never);
  writes.ended(true, 1);
  expect(bumps).toBe(4);
  // A cycle, an agent's events: nothing the trust reads.
  writes.written('work-cycle' as Kind, {} as never);
  writes.written('run-event' as Kind, {} as never);
  writes.ended(true, 2);
  expect(bumps).toBe(4);
  // A repository registered: a row the guard does not report, beside its audit row.
  writes.written('audit-event' as Kind, {} as never);
  writes.ended(true, 2);
  expect(bumps).toBe(5);
  // Nothing changed.
  writes.ended(true, 0);
  expect(bumps).toBe(5);
  // A worktree written outside a transaction bumps at once and leaves no flag behind.
  open = false;
  writes.written('worktree' as Kind, {} as never);
  expect(bumps).toBe(6);
  open = true;
  writes.ended(true, 0);
  expect(bumps).toBe(6);
});

it('is computed again when a repository is registered, through the storage as it writes (review MEDIUM-2)', async () => {
  // A registration writes the repository (a table the guard does not report) beside its audit
  // row (a guarded one): no worktree is written, and nothing else bumps.
  const state = await ready();
  let bumps = 0;
  state.context.storage.observeWrites(
    trustWrites(
      () => {
        bumps += 1;
      },
      () => state.context.storage.inTransaction,
    ),
  );
  const register = (rootPath: string) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/repositories`,
      headers: mutationHeaders(state),
      payload: { rootPath },
    });
  const path = fixtureRepository();
  expect((await register(path)).statusCode).toBe(200);
  expect(bumps).toBeGreaterThan(0);
  // Registered again: nothing new is written, and the trust is kept.
  const before = bumps;
  expect((await register(path)).statusCode).toBe(200);
  expect(bumps).toBe(before);
});

it('keeps no trust that could not read a registered checkout, and reads it again (review LOW-1)', () => {
  let computed = 0;
  let complete = false;
  const trust = trustByGeneration(() => {
    computed += 1;
    return { trust: { commonDirectories: [], worktreeRoots: [] } as GitTrust, complete };
  });
  trust.read();
  trust.read();
  expect(computed).toBe(2);
  complete = true;
  trust.read();
  trust.read();
  expect(computed).toBe(3);
});

it('bumps again at the commit of a worktree written in a transaction (review LOW-4)', () => {
  let bumps = 0;
  const writes = trustWrites(
    () => {
      bumps += 1;
    },
    () => true,
  );
  writes.written('worktree' as Kind, {} as never);
  expect(bumps).toBe(1);
  writes.ended(true, 1);
  expect(bumps).toBe(2);
  // Rolled back: the bump at the write stands (it only reads again), and none follows.
  writes.written('storage-settings' as Kind, {} as never);
  writes.ended(false, 0);
  expect(bumps).toBe(3);
});
