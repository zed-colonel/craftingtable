import { afterEach, describe, expect, it } from 'vitest';
import { seedWorkspace } from './planning-test-support.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

describe('run profiles', () => {
  it('stores one profile per role and replaces the whole set on save', () => {
    const fixture = temporaryStorage();
    fixtures.push(fixture);
    const { storage } = fixture;
    const seeded = seedWorkspace(storage);
    expect(storage.execution.runProfiles.list(seeded.workspaceId)).toEqual([]);

    storage.transaction((tx) => {
      tx.execution.runProfiles.replace({
        workspaceId: seeded.workspaceId,
        profiles: [
          { role: 'implement', backend: 'codex', model: 'gpt-5', permissionMode: 'auto' },
          { role: 'review', backend: 'claude-code', permissionMode: 'edit-only' },
        ],
        occurredAt: '2026-09-09T12:00:00.000Z',
        updatedByUserId: seeded.userId,
      });
    });
    expect(storage.execution.runProfiles.list(seeded.workspaceId)).toEqual([
      { role: 'implement', backend: 'codex', model: 'gpt-5', permissionMode: 'auto' },
      { role: 'review', backend: 'claude-code', permissionMode: 'edit-only' },
    ]);

    // Saving again replaces the set: the review profile disappears, implement changes.
    storage.transaction((tx) => {
      tx.execution.runProfiles.replace({
        workspaceId: seeded.workspaceId,
        profiles: [{ role: 'implement', backend: 'claude-code', permissionMode: 'unrestricted' }],
        occurredAt: '2026-09-09T12:01:00.000Z',
        updatedByUserId: seeded.userId,
      });
    });
    expect(storage.execution.runProfiles.list(seeded.workspaceId)).toEqual([
      { role: 'implement', backend: 'claude-code', permissionMode: 'unrestricted' },
    ]);
    // Another workspace is unaffected.
    expect(storage.execution.runProfiles.list(seedWorkspace(storage, 'b').workspaceId)).toEqual([]);
  });
});
