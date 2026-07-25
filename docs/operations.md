# CT-03 local operations

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
