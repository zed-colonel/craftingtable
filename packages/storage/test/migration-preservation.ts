import type Database from 'better-sqlite3';

/**
 * Test support for table-rebuild migrations (R-H3, DATA-14). Take an image of a database
 * seeded at the schema before a migration, migrate, take another, and compare: every row
 * that existed must still exist with the same values in the columns it had, in the same
 * rowid order (the repositories list by rowid), and every index, trigger and AUTOINCREMENT
 * sequence must survive under its name. Columns and tables the migration adds are allowed;
 * anything it removes must be named.
 */
export interface DatabaseImage {
  readonly tables: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  readonly keys: Readonly<Record<string, readonly string[]>>;
  readonly indexes: Readonly<Record<string, { readonly table: string; readonly sql: string }>>;
  readonly triggers: Readonly<Record<string, { readonly table: string; readonly sql: string }>>;
  readonly sequences: Readonly<Record<string, number>>;
}

export function imageOf(database: Database.Database): DatabaseImage {
  const names = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const tables: Record<string, Record<string, unknown>[]> = {};
  const keys: Record<string, string[]> = {};
  for (const name of names) {
    tables[name] = database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[];
    keys[name] = (
      database.prepare('SELECT name, pk FROM pragma_table_info(?)').all(name) as {
        name: string;
        pk: number;
      }[]
    )
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
  }
  const schema = (type: 'index' | 'trigger') =>
    Object.fromEntries(
      (
        database
          .prepare(
            'SELECT name, tbl_name AS "table", sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL',
          )
          .all(type) as { name: string; table: string; sql: string }[]
      ).map((row) => [row.name, { table: row.table, sql: row.sql }]),
    );
  const hasSequences = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .get();
  const sequences = hasSequences
    ? Object.fromEntries(
        (
          database.prepare('SELECT name, seq FROM sqlite_sequence').all() as {
            name: string;
            seq: number;
          }[]
        ).map((row) => [row.name, row.seq]),
      )
    : {};
  return { tables, keys, indexes: schema('index'), triggers: schema('trigger'), sequences };
}

export interface Removals {
  /** Tables the migration drops on purpose. */
  readonly tables?: readonly string[];
  /** Indexes or triggers the migration drops or replaces on purpose. */
  readonly schema?: readonly string[];
}

/** Ledgers and catalogs a migration appends to; their earlier rows must stay first. */
const APPEND_ONLY = new Set(['schema_migrations', 'audit_action_kinds', 'workspace_event_kinds']);

/** Everything a migration lost or changed that existed before it; empty when preserved. */
export function preservationProblems(
  before: DatabaseImage,
  after: DatabaseImage,
  removed: Removals = {},
): string[] {
  const problems: string[] = [];
  const dropped = new Set(removed.tables ?? []);
  for (const [table, rows] of Object.entries(before.tables)) {
    if (dropped.has(table)) continue;
    const now = after.tables[table];
    if (!now) {
      problems.push(`table ${table} is gone`);
      continue;
    }
    if (APPEND_ONLY.has(table) ? now.length < rows.length : now.length !== rows.length) {
      problems.push(`table ${table} had ${rows.length} rows and now has ${now.length}`);
      continue;
    }
    const columns = Object.keys(rows[0] ?? {});
    const project = (row: Record<string, unknown>) =>
      JSON.stringify(columns.map((column) => row[column]));
    rows.forEach((row, index) => {
      const current = now[index] as Record<string, unknown>;
      if (project(row) !== project(current))
        problems.push(
          `table ${table} row ${index} changed or moved: ${project(row)} -> ${project(current)}`,
        );
    });
    const key = before.keys[table] ?? [];
    if (key.join() !== (after.keys[table] ?? []).join())
      problems.push(`table ${table} primary key changed`);
  }
  const kept = new Set(removed.schema ?? []);
  for (const kind of ['indexes', 'triggers'] as const)
    for (const [name, entry] of Object.entries(before[kind])) {
      if (kept.has(name) || dropped.has(entry.table)) continue;
      const now = after[kind][name];
      if (!now) problems.push(`${kind === 'indexes' ? 'index' : 'trigger'} ${name} is gone`);
      else if (now.table !== entry.table)
        problems.push(`${name} now belongs to ${now.table} instead of ${entry.table}`);
    }
  for (const [table, sequence] of Object.entries(before.sequences)) {
    if (dropped.has(table)) continue;
    const now = after.sequences[table];
    if (now === undefined || now < sequence)
      problems.push(`sequence of ${table} fell from ${sequence} to ${now ?? 'nothing'}`);
  }
  return problems;
}

/** Copies every row of `tables` from `source` into `target`, using the columns both share. */
export function copyRows(
  source: Database.Database,
  target: Database.Database,
  tables: readonly string[],
): void {
  for (const table of tables) {
    const columns = new Set(
      (
        target.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]
      ).map((column) => column.name),
    );
    for (const row of source.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<
      string,
      unknown
    >[]) {
      const shared = Object.keys(row).filter((column) => columns.has(column));
      target
        .prepare(
          `INSERT INTO "${table}" (${shared.join(',')}) VALUES (${shared.map(() => '?').join(',')})`,
        )
        .run(...shared.map((column) => row[column]));
    }
  }
}
