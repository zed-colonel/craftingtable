import { asUserId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

/**
 * R-E3b: `commits` counts this process's committed write transactions, so a read keyed on it
 * (the inbox's map evaluation) is reused only while nothing was written.
 */

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) temporary.cleanup();
});

it('counts each committed outermost write, not a read, a nested savepoint or a rollback', () => {
  const temporary = temporaryStorage();
  temporaries.push(temporary);
  const { storage } = temporary;
  const before = storage.commits;
  storage.readTransaction((tx) => tx.users.findById(asUserId('nobody')));
  expect(storage.commits).toBe(before);
  storage.transaction(() => storage.transaction(() => undefined));
  expect(storage.commits).toBe(before + 1);
  expect(() =>
    storage.transaction(() => {
      throw new Error('rolled back');
    }),
  ).toThrow('rolled back');
  expect(storage.commits).toBe(before + 1);
});
