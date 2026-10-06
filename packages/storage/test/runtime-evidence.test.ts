import { randomUUID } from 'node:crypto';
import type { EvidenceSubmission } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { seedWorkspace } from './planning-test-support.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/**
 * Decoded evidence submissions are shared by every read on the database (R-D5): a map's
 * submissions were decoded again, megabytes of artifact contents, on each read of a work item's
 * slices. They are immutable and only inserted, so a workspace's stay current while their count
 * and newest row do.
 */
function fixture() {
  const f = temporaryStorage();
  fixtures.push(f);
  const { workspaceId } = seedWorkspace(f.storage);
  // The generation the submissions belong to; its map is not what these tests read.
  const database = openDatabase(f.databasePath);
  try {
    database.pragma('foreign_keys = OFF');
    database
      .prepare('INSERT INTO runtime_generations VALUES (?,?,?,?,?,?)')
      .run('runtime-1', workspaceId, 'map-1', 1, 1, '{}');
  } finally {
    database.close();
  }
  const submission = (definitionId: string, name = randomUUID()) =>
    ({
      id: randomUUID(),
      workspaceId,
      definitionId,
      runtimeId: 'runtime-1',
      artifacts: [{ name, content: 'x'.repeat(1000), digest: 'd' }],
    }) as unknown as EvidenceSubmission;
  const add = (value: EvidenceSubmission) =>
    f.storage.transaction((tx) => tx.runtimeEvidence.addSubmission(value));
  return { f, workspaceId, submission, add };
}

describe('evidence submissions, decoded once (R-D5)', () => {
  it('returns the same decoded records until a submission is added, newest first', () => {
    const { f, workspaceId, submission, add } = fixture();
    const [a, b, other] = [submission('map-1'), submission('map-1'), submission('map-2')];
    add(a);
    add(other);
    add(b);
    const first = f.storage.runtimeEvidence.submissions(workspaceId, 'map-1');
    expect(first.map((s) => s.id)).toEqual([b.id, a.id]);
    const again = f.storage.readTransaction((tx) =>
      tx.runtimeEvidence.submissions(workspaceId, 'map-1'),
    );
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    // Shared records cannot be changed by a reader.
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0]?.artifacts[0])).toBe(true);
    const c = submission('map-1');
    add(c);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-2').map((s) => s.id)).toEqual([
      other.id,
    ]);
  });

  it('never keeps a submission its transaction rolled back', () => {
    const { f, workspaceId, submission, add } = fixture();
    const a = submission('map-1');
    add(a);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1')).toHaveLength(1);
    const lost = submission('map-1');
    expect(() =>
      f.storage.transaction((tx) => {
        tx.runtimeEvidence.addSubmission(lost);
        // The writing transaction sees its own submission.
        expect(tx.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
          lost.id,
          a.id,
        ]);
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
      a.id,
    ]);
    // A later submission takes the rolled-back row's place, and is read as itself.
    const next = submission('map-1');
    add(next);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
      next.id,
      a.id,
    ]);
  });

  it('never keeps what a read inside a rolled-back write saw, even when the next insert reuses its row (R-D5 review)', () => {
    const { f, workspaceId, submission, add } = fixture();
    const a = submission('map-1');
    add(a);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1')).toHaveLength(1);
    const lost = submission('map-1');
    expect(() =>
      f.storage.transaction((tx) => {
        tx.runtimeEvidence.addSubmission(lost);
        tx.runtimeEvidence.submissions(workspaceId, 'map-1');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    // No read in between: the next submission takes the rolled-back one's row, so the count and
    // newest row are what the rolled-back read saw.
    const next = submission('map-1');
    add(next);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
      next.id,
      a.id,
    ]);
  });

  it('sees a submission another connection added', () => {
    const { f, workspaceId, submission, add } = fixture();
    add(submission('map-1'));
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1')).toHaveLength(1);
    const outside = submission('map-1');
    const database = openDatabase(f.databasePath);
    try {
      database
        .prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)')
        .run(outside.id, workspaceId, 'runtime-1', JSON.stringify(outside));
    } finally {
      database.close();
    }
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1')[0]?.id).toBe(outside.id);
  });
});
