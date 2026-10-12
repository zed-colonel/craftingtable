import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { asSliceId, type EvidenceSubmission, submissionHead } from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { discoverMigrations, runMigrations } from '../src/migrations.js';
import { copyRows, imageOf, preservationProblems } from './migration-preservation.js';
import { seedWorkspace } from './planning-test-support.js';
import { temporaryStorage, testDataRoot } from './test-support.js';

/**
 * Migration 0039 (R-H4, operator design 2026-10-06): `evidence_submission_heads` beside the
 * evidence records, filled from them in submission order. Every record stays byte-identical;
 * each submission gets exactly one head, equal to the domain's `submissionHead` of its record,
 * and the heads are immutable like the records.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const WS = 'workspace-a';
const RUNTIME = 'runtime-1';

function record(id: string, definitionId: string, fields: Partial<EvidenceSubmission> = {}) {
  return {
    id,
    workspaceId: WS,
    definitionId,
    bindingRevision: 1,
    runtimeId: RUNTIME,
    subject: { kind: 'checkpoint', sourceId: 'ADR-1' },
    environmentId: 'local',
    executedBy: 'implementer',
    executedAt: '2026-10-07T00:00:00.000Z',
    reviewers: [{ identity: 'reviewer', roles: ['code'], artifact: 'review' }],
    requirements: [],
    cases: [],
    artifacts: [],
    createdAt: '2026-10-07T00:00:00.000Z',
    createdByUserId: 'user-a',
    ...fields,
  };
}

/** Contents whose size and blankness SQL must compute exactly as JavaScript does. */
const SUBMISSIONS = [
  record('s-1', 'definition-1', {
    artifacts: [
      {
        name: 'review',
        content: 'Reviewed — ünïcode 😀 and "quotes" \\ and \u0001.',
        digest: 'd1',
      },
      { name: 'empty', content: '', digest: 'd2' },
      { name: 'spaces', content: ' \t\n\r\u000b\u000c     ', digest: 'd3' },
      { name: 'lines', content: '    　﻿', digest: 'd4' },
      // Not whitespace to trim(): next line and a zero-width space.
      { name: 'next-line', content: '\u0085', digest: 'd5' },
      { name: 'zero-width', content: '​', digest: 'd6' },
      { name: 'lone', content: 'a\ud800b', digest: 'd7' },
    ],
  }),
  record('s-2', 'definition-2'),
  record('s-3', 'definition-1', {
    subject: { kind: 'checkpoint', sourceId: 'ADR-2' },
    artifacts: [{ name: 'proposal', content: 'Use the queue.\n', digest: 'd8' }],
    architectureDecision: {
      kind: 'architecture-decision-v1',
      bindingDigest: 'binding',
      coverage: 'clauses',
      proposal: 'The proposal text.',
      sourceReferences: 'docs/adr/ADR-2.md',
      retainedObligations: 'Full checkpoint stays.',
      consumers: [
        { sliceId: asSliceId('wi/WI-01/domain'), phase: 'merge', replacesFullCheckpoint: false },
      ],
    },
  }),
] as unknown as EvidenceSubmission[];

/** A database at schema 38 holding evidence submissions and a decision on one of them. */
function schema38(path: string, submissions = SUBMISSIONS): Database.Database {
  const fixture = temporaryStorage();
  const source = new Database(fixture.databasePath);
  const database = openDatabase(path);
  try {
    seedWorkspace(fixture.storage);
    runMigrations(database, discoverMigrations().slice(0, 38));
    copyRows(source, database, ['users', 'workspaces']);
  } finally {
    source.close();
    fixture.cleanup();
  }
  database.exec(`
    INSERT INTO import_archives (id,workspace_id,digest,filename,byte_length,content,created_at)
    VALUES ('archive','${WS}','digest','map.zip',0,X'','2026-09-02');
    INSERT INTO concurrency_definitions (id,workspace_id,archive_id,map_id,revision,digest,record_json)
    VALUES ('definition-1','${WS}','archive','map','r1','digest','{}'),
           ('definition-2','${WS}','archive','map','r2','digest','{}');
  `);
  database
    .prepare('INSERT INTO runtime_generations VALUES (?,?,?,?,?,?)')
    .run(RUNTIME, WS, 'definition-1', 1, 1, '{}');
  for (const s of submissions)
    database
      .prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)')
      .run(s.id, WS, RUNTIME, JSON.stringify(s));
  database
    .prepare('INSERT INTO evidence_decisions VALUES (?,?,?,?)')
    .run('decision-1', WS, 's-1', JSON.stringify({ id: 'decision-1', submissionId: 's-1' }));
  return database;
}

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0039-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

describe('migration 0039: evidence submission heads (R-H4)', () => {
  it('keeps every record and gives each submission its head, in submission order', () => {
    const database = schema38(temporaryPath());
    try {
      const before = imageOf(database);
      runMigrations(database, discoverMigrations().slice(0, 39));
      const after = imageOf(database);
      // The records, their decisions and every trigger and index are untouched.
      expect(preservationProblems(before, after)).toEqual([]);
      const heads = database
        .prepare(
          'SELECT id, workspace_id, definition_id, head_json FROM evidence_submission_heads ORDER BY rowid',
        )
        .all() as { id: string; workspace_id: string; definition_id: string; head_json: string }[];
      expect(heads.map((h) => [h.id, h.workspace_id, h.definition_id])).toEqual([
        ['s-1', WS, 'definition-1'],
        ['s-2', WS, 'definition-2'],
        ['s-3', WS, 'definition-1'],
      ]);
      // Each head is the domain's head of its record: sizes in UTF-8 bytes, blank as trim() sees it.
      expect(heads.map((head) => JSON.parse(head.head_json))).toEqual(
        SUBMISSIONS.map(submissionHead),
      );
      expect(
        (JSON.parse(heads[0]?.head_json ?? '{}') as EvidenceSubmission).artifacts.map(
          (a) => (a as unknown as { blank: boolean }).blank,
        ),
      ).toEqual([false, true, true, true, false, false, false]);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Immutable like the records.
      for (const sql of [
        "UPDATE evidence_submission_heads SET head_json = '{}'",
        "DELETE FROM evidence_submission_heads WHERE id = 's-2'",
      ])
        expect(() => database.prepare(sql).run(), sql).toThrow('Evidence is immutable');
      // A head names its own submission, workspace and map, and only a stored submission.
      const add = database.prepare('INSERT INTO evidence_submission_heads VALUES (?,?,?,?)');
      expect(() =>
        add.run('s-4', WS, 'definition-1', JSON.stringify(record('s-4', 'definition-1'))),
      ).toThrow(/FOREIGN KEY/);
      database
        .prepare('INSERT INTO evidence_submissions VALUES (?,?,?,?)')
        .run('s-4', WS, RUNTIME, JSON.stringify(record('s-4', 'definition-1')));
      for (const [id, definition, head] of [
        ['s-4', 'definition-1', record('s-5', 'definition-1')],
        ['s-4', 'definition-2', record('s-4', 'definition-1')],
        ['s-4', 'definition-1', { ...record('s-4', 'definition-1'), workspaceId: 'other' }],
      ] as const)
        expect(() => add.run(id, WS, definition, JSON.stringify(head))).toThrow(/CHECK constraint/);
      add.run('s-4', WS, 'definition-1', JSON.stringify(record('s-4', 'definition-1')));
      expect(() =>
        add.run('s-4', WS, 'definition-1', JSON.stringify(record('s-4', 'definition-1'))),
      ).toThrow(/UNIQUE/);
    } finally {
      database.close();
    }
  });

  // A fill that is wrong in one way each; the guard is the only check between it and permanent
  // heads, since heads are immutable.
  it.each([
    [
      'leaves a submission without its head',
      'FROM evidence_submissions AS s ORDER BY s.rowid;',
      "FROM evidence_submissions AS s WHERE s.id <> 's-2' ORDER BY s.rowid;",
    ],
    [
      'writes the heads out of submission order',
      'FROM evidence_submissions AS s ORDER BY s.rowid;',
      'FROM evidence_submissions AS s ORDER BY s.rowid DESC;',
    ],
    [
      "keeps an artifact's contents",
      "'digest', json_extract(a.value, '$.digest'),",
      "'digest', json_extract(a.value, '$.digest'), 'content', json_extract(a.value, '$.content'),",
    ],
    [
      'drops an artifact',
      "FROM json_each(s.record_json, '$.artifacts') AS a)))",
      "FROM json_each(s.record_json, '$.artifacts') AS a WHERE a.key > 0)))",
    ],
  ])('rolls back a fill that %s', (_case, correct, wrong) => {
    const database = schema38(temporaryPath());
    try {
      const migration = discoverMigrations()[38];
      if (!migration) throw new Error('Expected migration 0039');
      expect(migration.sql.split(correct)).toHaveLength(2);
      const sql = migration.sql.replace(correct, wrong);
      expect(() =>
        runMigrations(database, [
          ...discoverMigrations().slice(0, 38),
          { ...migration, sql, checksum: migration.checksum },
        ]),
      ).toThrow(/CHECK constraint failed: ok = 1/);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE name = 'evidence_submission_heads'")
          .all(),
      ).toEqual([]);
      expect(database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({
        v: 38,
      });
    } finally {
      database.close();
    }
  });
});
