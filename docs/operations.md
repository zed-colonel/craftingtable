# Local operations

## Data location

By default the daemon keeps everything under `~/.local/share/craftingtable`
(`$XDG_DATA_HOME/craftingtable` when set; `CRAFTINGTABLE_DATA_DIR` overrides it):

```text
state/craftingtable.sqlite   the database (WAL mode; back up the -wal and -shm files with it)
worktrees/<repo>/<item>-<id> linked Git worktrees created for runs
runs/<runId>/brief.md        the brief handed to the agent, plus plan/ documents
```

`pnpm db:status` reports the schema version; `pnpm db:migrate` applies pending
migrations. Migrations run automatically when the daemon starts.

## Running the daemon

Development: `pnpm dev` runs the daemon on 127.0.0.1:4600 and the Vite UI on 5173.

Standalone: `pnpm build` once, then `pnpm start`. The daemon serves the built UI itself
when `apps/web/dist` exists (or `CRAFTINGTABLE_WEB_DIST` points at a build).

A `systemd --user` unit keeps it running across logins:

```ini
# ~/.config/systemd/user/craftingtable.service
[Unit]
Description=CraftingTable daemon
After=network-online.target

[Service]
WorkingDirectory=%h/src/craftingtable
EnvironmentFile=%h/.config/craftingtable/env
ExecStart=/usr/bin/env pnpm start
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

with `~/.config/craftingtable/env` holding the `CRAFTINGTABLE_*` variables from the
README's LAN section. Enable it with `systemctl --user enable --now craftingtable`
and `loginctl enable-linger $USER` so it survives logout.

The daemon's environment is the environment agents inherit: PATH must reach `git` and
`claude` (or set the explicit executable variables), and HOME must be the account Claude
Code is signed in as.

## Shutdown and recovery

`SIGTERM` or `SIGINT` closes the HTTP listener, terminates every live agent process
group (SIGTERM, then SIGKILL after a grace period), waits briefly, and closes the
database. On the next start, runs that were live are marked `interrupted` with a
`run-finished` event, so the journal always explains why a run stopped.

Worktrees survive restarts. A worktree the daemon cannot remove (for example because
the directory was deleted by hand) is pruned from Git's metadata and marked removed.

## Reset

Stop the daemon, then delete the data directory. Registered repositories are untouched,
but linked worktrees under `worktrees/` will disappear from those repositories' worktree
lists only after `git worktree prune` in each primary checkout.
