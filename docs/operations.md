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

with `~/.config/craftingtable/env` holding the `CRAFTINGTABLE_*` variables for the
route you chose below. Enable it with `systemctl --user enable --now craftingtable`
and `loginctl enable-linger $USER` so it survives logout.

The daemon's environment is the environment agents inherit: PATH must reach `git` and
`claude` (or set the explicit executable variables), and HOME must be the account Claude
Code is signed in as.

The unit owns port 4600, and both `pnpm dev` and the end-to-end suite in `pnpm check`
bind that port themselves, so stop the service (`systemctl --user stop craftingtable`)
before either. It serves whatever `apps/web/dist` holds, so a web change needs
`pnpm build` and `systemctl --user restart craftingtable` to appear.

## Reaching the daemon from another machine

The daemon refuses a non-loopback `CRAFTINGTABLE_HOST` unless TLS is configured or the
public origin is HTTPS behind a proxy. There are two ways to satisfy that.

### Over a Tailscale tailnet (simplest)

The daemon stays on loopback and `tailscale serve` terminates TLS in front of it. No port
is opened on the LAN interface, a host firewall keeps its default-deny stance, and the
certificate is a real one that `tailscaled` renews, so the laptop trusts it with nothing
to install. Only devices on the tailnet can reach it.

Find the machine's MagicDNS name, and let the CLI configure serve without root:

```sh
tailscale status --json | jq -r .Self.DNSName   # trailing dot; drop it for the origin
tailscale set --operator=$USER
```

Put that name in `~/.config/craftingtable/env`, leaving the listener on loopback:

```sh
CRAFTINGTABLE_HOST=127.0.0.1
CRAFTINGTABLE_PORT=4600
CRAFTINGTABLE_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net
```

Then `pnpm build` once, start the daemon (the unit above), and publish it:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4600
```

`tailscale serve status` shows the mapping, `tailscale serve --https=443 off` removes it,
and the configuration survives a reboot. Open `https://<machine>.<tailnet>.ts.net` — no
port, because serve listens on 443, and the origin must match what the browser shows
exactly or the CSRF and origin checks reject every mutation.

Two things that surprise people:

- A node brought up with `--accept-dns=false` cannot resolve its own MagicDNS name, so a
  smoke test from the workstation itself needs
  `curl --resolve <name>:443:<tailscale-ip> https://<name>/api/health`. Other devices on
  the tailnet resolve it normally.
- `tailscale serve` may warn that serve is not enabled on the tailnet and still succeed;
  the message links to the admin console setting to turn on if the proxy stops working.

### Directly on the LAN

Bind a LAN address and give the daemon its own certificate, as described in the README's
"Using it from the couch" section. This route also needs the host firewall to allow the
port on the LAN interface, a stable address (a DHCP reservation or a `.local` name), and
the certificate trusted on every device that connects.

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
