import type { GitTrust } from '@craftingtable/git';
import { expect, it } from 'vitest';
import { trustByGeneration, trustWrites } from '../../src/services/git-trust.js';

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
    return { commonDirectories: [], worktreeRoots: [String(computed)] } as GitTrust;
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
  expect(bumps).toBe(1);
  writes.written('storage-settings' as Kind, {} as never);
  writes.ended(true, 1);
  expect(bumps).toBe(2);
  // A cycle, an agent's events: nothing the trust reads.
  writes.written('work-cycle' as Kind, {} as never);
  writes.written('run-event' as Kind, {} as never);
  writes.ended(true, 2);
  expect(bumps).toBe(2);
  // A repository registered or retired: rows the guard does not report, beside its audit row.
  writes.written('audit-event' as Kind, {} as never);
  writes.ended(true, 2);
  expect(bumps).toBe(3);
  // Nothing changed.
  writes.ended(true, 0);
  expect(bumps).toBe(3);
  // A worktree written outside a transaction bumps at once and leaves no flag behind.
  open = false;
  writes.written('worktree' as Kind, {} as never);
  expect(bumps).toBe(4);
  open = true;
  writes.ended(true, 1);
  expect(bumps).toBe(5);
});
