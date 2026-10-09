import type { GitOperations } from '@craftingtable/git';
import { expect, it, vi } from 'vitest';
import { checkedOutBranches } from '../../src/services/checkout-fact.js';

it('reads each repository once per response, and says nothing when Git cannot (R-G10 D3, review L7)', async () => {
  const listBranches = vi.fn(async (root: string) =>
    root === '/broken'
      ? ({ ok: false, failure: { kind: 'git-failed', message: 'no' } } as never)
      : ({ ok: true, value: { branches: ['main', 'dev'], checkedOut: 'main' } } as never),
  );
  const holds = checkedOutBranches({ listBranches } as unknown as GitOperations);
  expect(await holds('/repo', 'main')).toBe(true);
  expect(await holds('/repo', 'dev')).toBe(false);
  expect(await holds('/broken', 'main')).toBeUndefined();
  expect(listBranches.mock.calls.map(([root]) => root)).toEqual(['/repo', '/broken']);
  expect(await checkedOutBranches(undefined)('/repo', 'main')).toBeUndefined();
});
