import { randomUUID } from 'node:crypto';
import { type EvidenceSubmission, submissionHead } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { openCraftingTableStorage } from '../src/storage.js';
import { seedWorkspace } from './planning-test-support.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/**
 * Evidence is read through heads (R-H4): each submission's record keeps its artifacts'
 * contents, megabytes for a live map, and a head beside it lists them by name, digest, size and
 * blankness. Lists read heads; only a submission's own review reads its record.
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
      artifacts: [
        { name, content: 'x'.repeat(1000), digest: 'd' },
        { name: `${name}-blank`, content: ' \n', digest: 'e' },
      ],
    }) as unknown as EvidenceSubmission;
  const add = (value: EvidenceSubmission) =>
    f.storage.transaction((tx) => tx.runtimeEvidence.addSubmission(value));
  const rows = (table: string) => {
    const database = openDatabase(f.databasePath);
    try {
      return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
        .count;
    } finally {
      database.close();
    }
  };
  return { f, workspaceId, submission, add, rows };
}

/** db:verify's evidence findings; the fixture's generation has no map, on purpose. */
const evidenceProblems = (f: TemporaryStorage) =>
  f.storage.integrityProblems().filter((problem) => problem.startsWith('evidence'));

describe('evidence submissions and their heads (R-H4)', () => {
  it('lists heads newest first per map, and reads the full record only by id', () => {
    const { f, workspaceId, submission, add } = fixture();
    const [a, b, other] = [submission('map-1'), submission('map-1'), submission('map-2')];
    add(a);
    add(other);
    add(b);
    const heads = f.storage.runtimeEvidence.submissions(workspaceId, 'map-1');
    expect(heads).toEqual([submissionHead(b), submissionHead(a)]);
    expect(heads[0]?.artifacts.map((artifact) => [artifact.bytes, artifact.blank])).toEqual([
      [1000, false],
      [2, true],
    ]);
    expect(JSON.stringify(heads)).not.toContain('x'.repeat(1000));
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-2')).toEqual([
      submissionHead(other),
    ]);
    expect(f.storage.runtimeEvidence.submission(workspaceId, 'map-1', a.id)).toEqual(a);
    expect(f.storage.runtimeEvidence.submission(workspaceId, 'map-2', a.id)).toBeUndefined();
    // Every read is current: nothing is kept between reads.
    const c = submission('map-1');
    add(c);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);
    expect(evidenceProblems(f)).toEqual([]);
  });

  it('writes a record and its head together, or neither', () => {
    const { f, workspaceId, submission, add, rows } = fixture();
    const a = submission('map-1');
    add(a);
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
    expect([rows('evidence_submissions'), rows('evidence_submission_heads')]).toEqual([1, 1]);
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1').map((s) => s.id)).toEqual([
      a.id,
    ]);

    // A head the guard refuses takes its record with it, even outside a storage transaction.
    f.storage.close();
    const refusing = openCraftingTableStorage(f.databasePath, (kind) => {
      if (kind === 'evidence-submission-head') throw new Error('head refused');
    });
    try {
      expect(() => refusing.runtimeEvidence.addSubmission(submission('map-1'))).toThrow(
        'head refused',
      );
    } finally {
      refusing.close();
    }
    expect([rows('evidence_submissions'), rows('evidence_submission_heads')]).toEqual([1, 1]);

    // A head the database refuses takes its record with it, outside a storage transaction too.
    const refused = submission('map-1');
    const database = openDatabase(f.databasePath);
    try {
      database.exec(
        `CREATE TRIGGER refuse_head BEFORE INSERT ON evidence_submission_heads WHEN NEW.id = '${refused.id}' BEGIN SELECT RAISE(ABORT, 'head refused by the database'); END`,
      );
    } finally {
      database.close();
    }
    const plain = openCraftingTableStorage(f.databasePath, () => {});
    try {
      expect(() => plain.runtimeEvidence.addSubmission(refused)).toThrow(
        'head refused by the database',
      );
    } finally {
      plain.close();
    }
    expect([rows('evidence_submissions'), rows('evidence_submission_heads')]).toEqual([1, 1]);

    // A malformed record is refused by the guard, with its contract error, before a head is made.
    const guarded = openCraftingTableStorage(f.databasePath, (kind) => {
      if (kind === 'evidence-submission') throw new Error('record refused');
    });
    try {
      expect(() =>
        guarded.runtimeEvidence.addSubmission({
          ...submission('map-1'),
          artifacts: undefined,
        } as unknown as EvidenceSubmission),
      ).toThrow('record refused');
    } finally {
      guarded.close();
    }
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
      database
        .prepare('INSERT INTO evidence_submission_heads VALUES (?,?,?,?)')
        .run(outside.id, workspaceId, 'map-1', JSON.stringify(submissionHead(outside)));
    } finally {
      database.close();
    }
    expect(f.storage.runtimeEvidence.submissions(workspaceId, 'map-1')[0]?.id).toBe(outside.id);
  });

  it('reports every head that is missing, differs from its record or is out of order (db:verify)', () => {
    const { f, workspaceId, submission, add } = fixture();
    add(submission('map-1'));
    const [headless, wrong, first, second] = [
      submission('map-1'),
      submission('map-1'),
      submission('map-1'),
      submission('map-1'),
    ];
    const database = openDatabase(f.databasePath);
    try {
      const record = database.prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)');
      const head = database.prepare('INSERT INTO evidence_submission_heads VALUES (?,?,?,?)');
      for (const s of [headless, wrong, first, second])
        record.run(s.id, workspaceId, 'runtime-1', JSON.stringify(s));
      const wrongHead = submissionHead(wrong);
      head.run(
        wrong.id,
        workspaceId,
        'map-1',
        JSON.stringify({
          ...wrongHead,
          artifacts: wrongHead.artifacts.map((a) => ({ ...a, blank: !a.blank })),
        }),
      );
      head.run(second.id, workspaceId, 'map-1', JSON.stringify(submissionHead(second)));
      head.run(first.id, workspaceId, 'map-1', JSON.stringify(submissionHead(first)));
    } finally {
      database.close();
    }
    expect(evidenceProblems(f)).toEqual([
      `evidence submission ${headless.id} has no head`,
      `evidence submission ${wrong.id} has a head that differs from its record`,
      `evidence submission heads are not in submission order from ${first.id}`,
    ]);
  });
});
