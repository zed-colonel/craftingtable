# CT-02 local operations

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
