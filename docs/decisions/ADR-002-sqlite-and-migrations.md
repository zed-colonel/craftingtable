# ADR-002 — SQLite library and migration strategy

- **Status:** accepted
- **Date:** 2026-07-24
- **Amended:** 2026-07-24 for CT-03 schema version 2, and again after the second
  remediation re-review (CT03-R2R1, CT03-R2R2)

## Context

CT-02 requires one restart-safe, transactional local authority for state, audit
history, sessions, and workspace events. State, audit, and events must commit
atomically, and schema drift must fail closed.

## Decision

- Use `better-sqlite3` 13.0.1, isolated in `@craftingtable/storage`.
- Use repository-owned, package-local ordered SQL migrations. Migration 0001
  installs schema version 1.
- Store migration version, name, SHA-256 checksum, and application timestamp in
  `schema_migrations`.
- Require contiguous ascending versions. Reject changed checksums, unknown
  applied migrations, and databases newer than the application. Apply each SQL
  file and ledger insert in one explicit transaction.
- Open the database in WAL mode with foreign keys enabled, FULL synchronous
  semantics, and a 5000 ms busy timeout. Verify those settings at open.
- Use immediate transactions for writes and deferred transactions for
  consistent read snapshots.
- Restrict foreign-key deletion and expose no CT-02 deletion/retention API.

CT-03 amendment. Migration `0002` installs schema version 2. Because
`PRAGMA foreign_keys` is a no-op inside a transaction and the runner wraps every
migration in one, a migration must be foreign-key clean at every statement.
Migration 0002 therefore seeds its kind catalogs before copying any journal row.
See ADR-013 for the one-time journal rebuild and its preservation guarantees.

**A composite foreign key is not a constraint on nullable columns.** SQLite
applies MATCH SIMPLE semantics: if *any* child column of a composite key is
NULL, the entire key is treated as satisfied and no parent row is looked up. It
does not match a child NULL to a parent NULL. Two rules follow, and CT-03 relies
on both:

- A composite key that adds coherence between columns never replaces the plain
  key that enforces existence. Where a child column is legitimately NULL —
  failure evidence with no plan version, an event with no work item — the
  narrower key must also be declared, or those exact rows become unparented.
- What a foreign key cannot express is "NULL here only if NULL there", because
  the NULL-skip rule disables the comparison in precisely that case. That rule
  is expressed with a `BEFORE INSERT` trigger or a `CHECK` instead.

Any constraint kept for defence in depth that is strictly weaker than another is
labelled as such in the migration, because its removal is not falsifiable by
test.

## Consequences

SQLite and SQL do not leak into server, browser, contracts, or domain code.
Synchronous transaction callbacks make atomic state/audit/event writes
explicit. `better-sqlite3` is a native dependency and must be approved in
pnpm's build allowlist.

The database file and its `-wal`/`-shm` companions are one live persistence
unit. Copying only the main file while the daemon is open is not a supported
backup. Backup/restore tooling remains CT-08.

## Alternatives considered

- `node:sqlite` — still release-candidate at the decision point.
- ORM or migration framework — unnecessary abstraction for one controlled
  SQLite schema.
- In-memory persistence — cannot satisfy restart reconstruction or durable
  replay.
