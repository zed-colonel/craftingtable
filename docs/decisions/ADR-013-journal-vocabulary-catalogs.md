# ADR-013 — Journal vocabulary catalogs

- **Status:** accepted
- **Date:** 2026-07-24

## Context

Migration `0001-ct02-foundation.sql` fixes the audit action and workspace-event
vocabularies with closed `CHECK (... IN (...))` constraints. That was right for a
tightly bounded CT-02 with one event producer, but CT-03 is the first feature to
add several.

Inspection of the actual schema found a second, sharper constraint the CT-03
package did not anticipate: `workspace_events.payload_json` also carries a CHECK
hard-coded to the `workspace-created` payload shape —

```sql
json_type(payload_json, '$.name') = 'text'
AND json_type(payload_json, '$.slug') = 'text'
```

so **no** new event kind is representable without rebuilding that table,
regardless of the `kind` constraint. The rebuild is therefore mandatory rather
than merely preferable.

Rebuilding both journals in every future feature migration would repeatedly risk
global sequence preservation, trigger preservation, index preservation, and
append-only history. That risk should be taken once.

## Decision

Migration `0002-ct03-planning.sql` introduces migration-owned catalogs:

```sql
CREATE TABLE audit_action_kinds (
  action TEXT PRIMARY KEY CHECK (length(action) BETWEEN 1 AND 64),
  introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 1)
) STRICT;

CREATE TABLE workspace_event_kinds (
  kind TEXT PRIMARY KEY CHECK (length(kind) BETWEEN 1 AND 64),
  introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 1)
) STRICT;
```

`audit_events.action` and `workspace_events.kind` become foreign keys into these
catalogs with `ON DELETE RESTRICT`. Both catalogs carry no-update and no-delete
triggers; `INSERT` stays permitted so a future migration registers a kind with
one statement and no further table rebuild.

Each journal is rebuilt exactly once, in this order:

```text
1  drop the two append-only triggers
2  ALTER TABLE <t> RENAME TO <t>_schema1     (carries its sqlite_sequence row)
3  CREATE TABLE <t> with identical columns; kind/action now a catalog reference
4  INSERT ... SELECT every column including sequence, ORDER BY sequence
5  guard row: CHECK(ok = 1) aborts the migration unless counts and maximum
   sequences match the pre-rebuild table
6  DROP TABLE <t>_schema1                     (frees the old index names)
7  CREATE INDEX with the original names and definitions
8  CREATE the two append-only triggers with identical bodies
```

Four details make this correct rather than merely plausible, each verified
against a real schema-1 database under SQLite 3.53.3 before implementation:

- Triggers are dropped **before** the rename, so `ALTER TABLE RENAME` cannot
  rewrite stale trigger bodies.
- Indexes are freed by the `DROP TABLE` in step 6, so recreating them under
  their original names in step 7 does not collide.
- `AUTOINCREMENT` continuity holds. The rename carries `sqlite_sequence`, the
  explicit-sequence copy establishes a row under the new table name, and step 6
  removes only the old row. The next event receives a sequence strictly greater
  than the preserved CT-02 maximum.
- No foreign-key pragma toggle is needed — and none is possible, because
  `PRAGMA foreign_keys` is a no-op inside a transaction and the migration runner
  wraps every migration in one. The catalogs are seeded before the copy and
  every copied action and kind is registered, so the copy is foreign-key clean.

The in-migration guard is a temporary table whose `CHECK (ok = 1)` fails when a
computed comparison yields 0. A row-count or sequence discrepancy therefore
rolls the entire migration back rather than producing a silently truncated
journal.

`workspace_events.payload_json` becomes
`json_valid(payload_json) AND json_type(payload_json) = 'object'`. Strict
per-kind payload validation stays in `@craftingtable/contracts`: a registered
kind string does not make an arbitrary payload valid.

The domain `AUDIT_ACTIONS` and `WORKSPACE_EVENT_KINDS` lists mirror the
catalogs. Adding a value to either list without seeding it in a migration makes
every insert of that value fail closed.

## Consequences

Journals stay append-only across the migration, keep their global sequences, and
gain an extension path that costs one `INSERT` per future kind. The storage
event mapper becomes an exhaustive switch, so registering a kind fails to
compile until the mapper handles it.

Migration `0002` is the most delicate change in CT-03 and is covered by a
real-file preservation test that seeds a schema-1 database through the CT-02
repositories before migrating.

A test or a defect could in principle insert directly into a catalog. Nothing in
the application does — no repository method exists — but the catalogs are
protected only against update and delete, not insert, because insert is exactly
what future migrations need.

## Alternatives considered

- **Rebuilding both journals in every feature migration** — repeats the highest
  risk operation indefinitely.
- **Dropping the `kind` and `action` constraints entirely** — would let an
  arbitrary string enter the durable journal and make history unreadable.
- **Application-only validation with no database constraint** — loses fail-closed
  behaviour for any code path that bypasses the repository.
- **A new parallel journal for CT-03 events** — would split the global cursor the
  SSE contract depends on.
