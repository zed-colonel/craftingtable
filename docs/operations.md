# Local operations (accepted CT-03 plus CT-04A1)

## Data location and configuration

By default the daemon stores data at:

```text
$XDG_DATA_HOME/craftingtable/state/craftingtable.sqlite
```

or `~/.local/share/craftingtable/state/craftingtable.sqlite` when
`XDG_DATA_HOME` is unset. `CRAFTINGTABLE_DATA_DIR` may override the base but
must be absolute.

Supported configuration:

```text
CRAFTINGTABLE_HOST=127.0.0.1
CRAFTINGTABLE_PORT=4600
CRAFTINGTABLE_PUBLIC_ORIGIN=http://127.0.0.1:5173
CRAFTINGTABLE_SESSION_LIFETIME_SECONDS=2592000
CRAFTINGTABLE_LOG_LEVEL=info
```

Only `127.0.0.1`, `localhost`, and `::1` hosts are accepted.

## CT-04A1 Git boundary prerequisites

The A1 library requires a non-root POSIX daemon and Git 2.32.0 or newer.
Production composition in A2 must supply either an explicit absolute Git
executable or an explicit absolute search path; ambient daemon `PATH` is a
development/test convenience only. Search-path resolution selects the first
canonical executable whose version probe succeeds. It skips non-executable,
malformed, failing, and pre-2.32 candidates in order; if none is viable, it
reports the first candidate's probe failure. An explicit executable never
falls back to the search path. Inspector creation has one aggregate deadline
across root validation, candidate discovery, and every version probe. The
optional `creationTimeoutMs` defaults to
`2 × commandTimeoutMs + 5000`, accepts 1000–90000 ms, and cannot be shorter
than `commandTimeoutMs`.

Source roots must already exist as canonical directories with no symlink
component. Reserved roots may be absent, but every existing component must be
canonical and symlink-free. Source roots and reserved roots cannot equal,
contain, or descend from one another. Repository requests must be exact
top-level primary checkouts strictly below a source root. A symlinked source
layout is rejected before Git, even when it resolves to an otherwise valid
repository. A source root containing `:` anywhere in its absolute path is
rejected as invalid policy during inspector creation. Reserved roots may
contain `:` because they never supply a Git working directory or ceiling.

Git treats `GIT_CEILING_DIRECTORIES` as a colon-delimited POSIX list and
defines no escaping for a literal colon. A repository basename may contain a
colon when its parent is unambiguous, but inspection rejects a requested path
whose parent contains a colon before starting a repository Git process.
Internally, repository commands carry a branded, prevalidated ceiling;
environment construction only serializes it.

Inspection is intentionally conservative about concurrent working-tree
activity. Postflight compares the repository top-level directory's size and
mtime as well as kind, device, inode, and canonical resolution. Creating,
deleting, or renaming a top-level entry can therefore return
`observation-raced` even without repository-layout replacement. The operator
has accepted this narrower personal-use policy: A2 registration must inspect a
clean, quiescent working tree and may retry only after activity has stopped.

No `CRAFTINGTABLE_*` Git or repository setting is active yet, no repository is
registered at startup, and the daemon still starts without Git configuration.
CT-04A2 owns operator-facing configuration and composition.

## First start

Install dependencies, migrate, and create the only initial administrator:

```sh
pnpm install
pnpm db:migrate
pnpm db:status
pnpm craftingtable admin bootstrap --username keith
pnpm dev
```

Bootstrap prompts twice without echo. It refuses password arguments and
refuses if any user already exists. An accepted operator amendment records
exactly one safe `admin.bootstrap.denied` audit row for each refusal; it creates
no other row.

The schema is at version 2. Migration `0002-ct03-planning.sql` rebuilds both
CT-02 journals once so their audit-action and workspace-event vocabularies
become migration-owned catalogs, then adds the planning tables. It preserves
every CT-02 row, both global sequences, the append-only triggers, and every
index; an in-migration guard aborts the whole migration if a row count or
maximum sequence fails to match. Migration `0001` is unchanged, so an existing
database still validates.

Migration `0002` was revised during CT-03 remediation to close a structural
ownership gap and freeze the imported work graph. A local database that ran the
*pre-remediation* `0002` will therefore fail validation with
`schema invalid (checksum-mismatch)`. Reset it with the procedure below; a
CT-02-era database at schema 1 is unaffected because `0001` is untouched.

Imported planning artifacts are stored as bounded SQLite BLOBs (at most 2 MiB
each). This is deliberately narrow so one import is one atomic transaction; it
does not make SQLite CraftingTable's general artifact store. Artifacts from
failed imports persist until a retention feature exists, so the database grows
with repeated failed imports.

`db status` opens an existing database read-only and reports a missing database
as schema `0/1` without creating it. Pending migrations exit with status 2.
Unsupported versions and migration name/checksum mismatches produce a
structured `schema invalid (...)` diagnostic and exit with status 4 for both
`db status` and `db migrate`; neither command repairs or bypasses validation.

## Shutdown and database handling

`SIGINT` and `SIGTERM` stop accepting work, abort active SSE loops, wait for
stream tasks, close Fastify, and close SQLite. SQLite runs in WAL mode with
FULL synchronous semantics and a 5000 ms busy timeout.

The `.sqlite`, `.sqlite-wal`, and `.sqlite-shm` files are one live persistence
unit. Do not copy only the main file while the daemon is open. CT-02 has no
backup/restore CLI; stop the daemon before making an offline copy, and treat
formal backup/restore tooling as CT-08 work.

Tests and Playwright always use unique temporary data directories. They never
open the operator's normal database.

## Resetting a local installation

CT-02 intentionally has no remote or in-process reset endpoint. To reset,
stop the daemon, identify the configured data directory, and move that entire
directory to a separately named backup location. Start the daemon, run
`pnpm db:migrate`, and bootstrap again. Moving instead of deleting keeps the
old database/WAL/SHM unit recoverable while the operator verifies the new
installation. Never reset while the daemon is running.
