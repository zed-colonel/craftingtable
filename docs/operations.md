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
`claude` and/or `codex` (or set the explicit executable variables), and HOME must be
the account signed in to the selected agent. Run `codex login` as that account before
using Codex. Tool status reports executable availability, not authentication health.
`CRAFTINGTABLE_CODEX_EXECUTABLE` overrides discovery and `CRAFTINGTABLE_CODEX_MODELS`
replaces its model picker list. Codex app-server behavior was verified with CLI 0.153.4. The adapter communicates
over local stdio; do not start a separate app-server listener for CraftingTable.

The unit owns port 4600, which `pnpm dev` also binds, so stop the service
(`systemctl --user stop craftingtable`) before a dev session; `pnpm check` needs no such
care, because the end-to-end suite uses ports of its own. The unit serves whatever
`apps/web/dist` holds, so a web change needs `pnpm build` and
`systemctl --user restart craftingtable` to appear.

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

Use the configured `CRAFTINGTABLE_PUBLIC_ORIGIN` address on the workstation as well as
on the laptop. Loading `http://localhost:4600` may display the app, but browser sign-in
is rejected when the configured origin is the HTTPS tailnet address. The sign-in error
names the required address; changing the password does not resolve an origin mismatch.

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

## Forgotten password

From the checkout, as the daemon's OS user, run:

```sh
pnpm craftingtable admin reset-password --username keith
```

Use the same `CRAFTINGTABLE_DATA_DIR` (or `XDG_DATA_HOME`) as the daemon if you overrode
the default. The command prints the database path, refuses a missing database or
inactive/missing user, and prompts for the new password twice without echoing it.
Passwords must be 12–1024 UTF-8 bytes; do not pass them in arguments or environment
variables. Ctrl+C cancels; Ctrl+U clears a mistaken entry.

Recovery requires local access to the database, not the old password. It atomically
replaces the Argon2id hash, revokes all of that user's login sessions, and records an
audit entry without password material. Workspaces, plans, runs and repositories remain
intact. Sign in through the browser with the new password. On upgrading to this recovery
implementation, restart the daemon to load its concurrent-login protection; subsequent
resets need no restart.

## Delete all application data

Stop the daemon, then delete the data directory. Registered repositories are untouched,
but linked worktrees under `worktrees/` will disappear from those repositories' worktree
lists only after `git worktree prune` in each primary checkout.

## Pushover notifications

After upgrading, restart the daemon to apply schema 11 and start the notification worker.
In workspace **Settings → Pushover notifications**:

1. Install and sign in to Pushover on the phone, create a Pushover application at
   https://pushover.net/apps/build, and copy its API token and your account user key.
2. Enter both credentials. Optionally enter the phone's Pushover device name; blank
   sends to all devices registered to that account.
3. Check the timezone and daily time (America/Los_Angeles, 21:00 by default), enable
   notifications, save, and send a test. The activity list shows acceptance or failure.

Notification links use `CRAFTINGTABLE_PUBLIC_ORIGIN`, so keep its private HTTPS address
configured and connect the phone to Tailscale when opening a link. Push delivery itself
uses Pushover's public service and requires outbound HTTPS from the workstation; the
phone does not need Tailscale just to receive a push. Normal priority respects Pushover
quiet hours. No email or SMS provider is configured.

Alerts cover automated merge checkpoints and attention stops (design questions, failed
runs, exhausted limits, restart interruption), plus manual review outcomes, unresolved
design conclusions, and failed/interrupted manual runs. Explicit cycle pause/stop does
not nag. Resuming, completing, merging, or removing the work resolves the corresponding
alert. Manual review alerts report the reviewer verdict; opening the item and the merge
command still check current Git state. Git is not polled by the notification service.

The first *accepted* message anchors reminders at +30, +60, +120, +180, +240, +300,
and +360 minutes, followed by daily reminders at the configured local time. Restart or
network downtime produces at most one overdue reminder per item, skipping missed stages.
A local time skipped by daylight saving is skipped that day; a repeated local time sends
once. Changing daily time/timezone updates outstanding schedules on save.

Transient failures retry after 30 seconds, 1 minute, 5 minutes, 15 minutes, then hourly.
These retries do not consume reminder stages. Rate-limit cooldowns honor Pushover's
quota reset / Retry-After and apply across the workspace. Rejected credentials pause
delivery until settings are saved or a test is requested. Save corrected credentials to
retry pending deliveries. Tests are durable, have no reminder schedule, and are limited
to one pending test and one request per minute. Disabling attention notifications still
allows an explicitly requested test. The status list shows the latest 50 records.

The SQLite database holds schedules, attempts, and credentials, so include it in private
backups. Delivery means Pushover accepted a request, not proof the phone displayed it or
the operator read it. A crash or lost response after provider acceptance can cause a
duplicate: Pushover does not offer an idempotency key. A claimed send is recovered after
its one-minute lease expires. A notification already in flight may arrive after the
operator resolves an item or disables notifications; subsequent reminders stop.

## Sequential roadmaps

Restart the daemon after upgrading to apply schema 12. Existing imports, branch settings,
cycles, and notification credentials remain usable.

1. Configure **Projects → a plan → Repository & branches** for every plan you will use.
2. Open **Roadmaps → New roadmap**, name the sequence, and add work items from active
   imported plans. Expand each entry to choose its agents, models, permissions, instructions,
   and completion limits. Workspace profiles seed these choices.
3. Put required predecessors before their selected dependents. Save to review the exact
   plan bindings, integration branches, and current blockers. Saving does not start work.
4. Select **Start roadmap**. One entry executes at a time in that workspace. The scheduler
   waits for required predecessors and for other unmerged worktrees in the same registered
   checkout, including manual worktrees. It does not adopt existing worktrees or cycles.
5. At **Awaiting merge approval**, open the item, inspect the review/diff, and use the existing
   **Merge…** confirmation. The next item starts from the updated integration head.

A mergeable verdict or manually marking the current item complete does not release its
roadmap successor; its own worktree must be merged. Items already completed before the
roadmap reaches them are reused. Existing predecessor commit-evidence checks still apply.
The sequence is strict: a blocked entry holds later entries, even if they are independent.
Cross-project requirements from the draft concurrency sidecar are not imported or inferred.

**Pause roadmap** suspends scheduling and pauses a running cycle for manual work. A cycle
already awaiting merge retains that approval and its normal merge reminders. You can merge
while the roadmap is paused; the next item waits for **Resume roadmap**. Edit queued entries
while paused or needing attention; already-started entries and their positions stay fixed.
Saving creates a new revision, and new attempts bind that revision. **View revisions** retains
all prior definitions. A branch-settings change before dispatch needs an explicit queued
revision; starting work never follows a silently changed integration target.

**Stop roadmap** ends its current cycle and leaves existing worktrees for manual work. An
ended roadmap is historical; create a new one for remaining items. After a daemon restart,
inspect the current item and explicitly resume the roadmap. A completed operator merge is
recognized without rerunning that item. Reserved preparation IDs prevent replay from creating
another recorded worktree or cycle. Git and SQLite still do not form an atomic transaction:
if Git succeeded but its record was never committed, inspect the managed worktree/branch
before retrying, as with manual worktree creation.

Configured Pushover delivery handles item merge/attention checkpoints with the existing
reminder schedule. Scheduler failures without an existing item alert also produce roadmap
attention reminders; pause/stop resolves those reminders. Normal prerequisite/capacity waits
remain visible on the roadmap. Roadmap completion is shown in the app and activity journal.
