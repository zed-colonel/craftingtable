# Local operations

## Data location

By default the daemon keeps everything under `~/.local/share/craftingtable`
(`$XDG_DATA_HOME/craftingtable` when set; `CRAFTINGTABLE_DATA_DIR` overrides it):

```text
state/craftingtable.sqlite   the database (WAL mode; use a consistent SQLite backup)
worktrees/<repo>/<item>-<id> linked Git worktrees created for runs
runs/<runId>/brief.md        the brief handed to the agent, plus plan/ and handoff/ documents
runs/<runId>/scratch/        disposable build output and temporary test files
t/<12 hex>/                  each live run's agent process TMPDIR (CRAFTINGTABLE_AGENT_TMP_ROOT)
backups/database/           private, consistent SQLite snapshots
```

`pnpm db:status` reports the schema version; `pnpm db:migrate` applies pending
migrations. Migrations run automatically when the daemon starts.

## Storage maintenance

Open **Settings → Storage**. This controls the entire installation; viewing or changing it
requires ownership of every active workspace. Locations are workstation paths, not browser
paths. Worktree and run root environment variables initialize settings once; afterward the
saved policy is authoritative. Changes affect future allocations. Each run's directory is
recorded durably; existing checkouts and interrupted runs keep their paths. Integration merge
scratch keeps its original location for recovery. Recover unfinished finalization preparation
before changing the future worktree root.

Roots must be separate normalized absolute paths, outside source repositories and database
state. The daemon can create one leaf below an existing directory, but never recursively
recreate a missing mount. Canonical paths and device identities are pinned. If a volume is
missing or changed, restore it before continuing; the daemon does not fall back to the OS disk.

**Scan storage** inventories known run directories and active checkouts without following
symlinks or nested mounts. **Clean eligible files** consumes a server-held preview, then
rechecks eligibility and identity before removal. Previews expire on restart, settings changes,
or cleanup. Reported allocated blocks can differ from physical usage on compressed filesystems
or when hardlinks/reflinks share data. Partially unreadable trees produce warnings.

Defaults:

- Remove recognized Cargo build caches after finished, failed or cancelled runs, with no live
  siblings in the worktree. Search up to four levels under registered scratch for Cargo's cache
  signature, compiler marker and debug/release fingerprint directory. Both backends set
  CARGO_TARGET_DIR to the current run's scratch/target. Preserve verification reports elsewhere
  in scratch. Cleanup queues behind maintenance and holds that worktree's next automation step;
  deletion shares the launch/mutation guard. Unknown build systems and caches outside scratch
  are not inferred safe. Git worktree removal owns existing checkout build-output cleanup.
- Expire the remaining scratch directory after 30 days from the later of run completion and
  worktree removal, provided no contained file has changed more recently. Setting retention to
  **Keep until manually removed** disables expiry. Active, interrupted and unmerged work is
  excluded. This policy deliberately preserves removed-but-unmerged work as well.
- Keep run briefs, plan/handoff documents, messages, findings and all SQLite history. Scratch
  file logs can expire; agents must record verification evidence in their final messages.
- Keep a 5 GiB reserve on database, checkout and run volumes before launches, and on the future
  checkout volume before creating a worktree. This cannot limit an already-running build;
  increase the reserve for large builds and reduce roadmap parallelism when necessary.
- Create a consistent SQLite snapshot every 24 hours and retain seven snapshots on the current
  backup root. Maintenance checks once per minute while the daemon is running; it retries errors
  and recomputes cleanup eligibility after restart. Storage pressure/maintenance errors use the
  existing attention-notification preference and reminder schedule.

Use **Back up database now** before upgrades or storage moves. Snapshots are made through
SQLite's online backup API, published after completion, and stored in a mode-0700 directory as
mode-0600 files. They contain credentials. Do not copy a live SQLite main file by itself or copy
its WAL and SHM companions independently and assume the result is consistent. Retention removes
only backups registered by this feature in the current backup directory; older backup roots,
manual backups and migration rollback copies are left alone. A crash during publication can
leave an unregistered snapshot or `.partial` file, which is retained for manual inspection.

A database snapshot covers plans, imported artifacts, accounts, settings, notification state,
and run/event history. It does **not** cover source repositories, Git commits, unmerged working
files, external agent sessions or materialized run directories. Keep repository backups (or
pushed commits) separately. To protect uncommitted work and host configuration, take a filesystem
backup while the daemon and agents are stopped. Build caches can be excluded from that backup.
A backup on the same drive protects against some software mistakes, not drive failure: prefer
a separate physical disk for database snapshots and source backups.

To restore, stop the daemon and agents, retain the current data directory as a rollback copy,
and restore the snapshot as `state/craftingtable.sqlite` in a fresh private state directory
without old WAL/SHM files. Restore the corresponding repositories/worktrees and run directories
at their recorded paths (or compatible links), then run database integrity/foreign-key checks
and inspect interrupted cycles before explicitly resuming them. A database-only restore cannot
reconstruct unmerged working files.

### Checking and compacting the database

`pnpm db:verify <database>` checks every stored record against the current contracts (R-H3). It
copies the file with SQLite's backup API and reads only the copy, so it is safe on a snapshot.
Point it at a **Back up database now** snapshot, never at the live file. Run it before deploying a
change to the contracts or the schema. A failing record is a defect to fix, or a historical
shape that needs an upcaster in `packages/storage/src/records.ts`.

Since R-H2, new runs keep raw vendor lines only for output the adapter could not normalize. Tool
results larger than 4 KiB go to `<run directory>/tool-results/`, and the journal keeps a
preview and a digest. Runs journaled earlier keep their old rows until compacted. Compaction is
an operator action, run with the daemon stopped:

1. Take a snapshot (**Back up database now**) and check it with `pnpm db:verify <snapshot>`.
2. Stop the daemon (`systemctl --user stop craftingtable`; see "Shutdown and recovery").
3. `pnpm craftingtable db compact-journal` reports what would change and writes nothing. It
   refuses a database with pending migrations, so the deployed daemon must have started once.
4. `pnpm craftingtable db compact-journal --apply --vacuum` rewrites ended runs. Each run is one
   transaction, with a `storage.journal-compacted` audit record, and bodies are written to the
   run directories first. Then VACUUM returns the freed space. VACUUM needs free space of about
   twice the database size (the rebuilt copy passes through the WAL) and blocks all writers
   while it runs, which is why the daemon must be stopped.
5. Start the daemon, and check the Storage panel and a compacted run's page.

The command takes the data-directory lock, so it refuses to run while the daemon holds it. It
touches only runs that have ended. A tool result whose run directory no longer exists stays in
the journal. The journal's append-only trigger is lifted only inside each run's transaction,
and is restored byte-identical before that transaction commits. On a copy of the 2026-09-23
database, compaction cut the file from 547 MB to 137 MB and wrote 54 MB of compressed bodies.
Tool-result bodies expire with each run's scratch retention: 30 days after the run's work is
merged and removed, and no sooner than 30 days after the bodies were last written. So bodies that
compaction writes for runs already past retention stay for 30 days after compaction, and those
runs then keep only the 4 KiB preview of each large tool result.

### Moving application data to another disk

Whole-application moves are deliberately offline; the browser does not relocate an open SQLite
handle. Stop the daemon and verify no agent processes are writing. Make a consistent snapshot,
then copy the data directory with metadata and symlinks preserved to a private directory on the
mounted destination. Checksum-verify the copy, check SQLite integrity and foreign keys, and
verify each active worktree's HEAD and working status.

Preserve the original logical data path with a symlink to the new physical directory. This
keeps old Git worktree registrations, run briefs and agent-session references valid. After
schema 15 has registered canonical root/device identities and run directories, a move also
requires updating those controller records to the verified new canonical paths/device; a
symlink alone is insufficient. Keep historical messages immutable. This version provides
future-allocation settings, not an unattended migration command.

Add `ConditionPathIsMountPoint=/mnt/<volume>` to the user service's `[Unit]` section (or a
private drop-in) so an absent data volume cannot lead to a fresh database on the OS disk.
Reload the service definition, start the daemon, and verify the Storage panel and active work.
Keep the original copy until the move is accepted. Runs interrupted by a stop that was not a
completed drain remain interrupted until explicitly resumed.

## Running the daemon

**Development:** `pnpm dev` runs a development daemon on 127.0.0.1:4601 with its own data
directory (`$XDG_DATA_HOME/craftingtable-dev`) and the Vite UI on 5173, so it can run beside
the installed daemon. `pnpm craftingtable:dev <command>` runs the CLI against that data
directory (for example `pnpm craftingtable:dev admin bootstrap --username <name>` once).
Set `CRAFTINGTABLE_DATA_DIR`/`CRAFTINGTABLE_PORT` to override either.

**One daemon per data directory.** At start, before touching the database, a daemon takes
an exclusive lock on its data directory: a Unix socket file, `<data>/state/daemon.lock`, and
on Linux first an abstract socket as well, which the kernel releases the moment the process
exits. A second daemon on the same directory, for example a stray `pnpm start` in another
checkout, exits with a message naming the holder instead of marking the live daemon's runs
interrupted. It locks its agents' temporary root the same way (see below). The socket file
refuses a daemon in any network namespace that sees the directory, so one started inside a
sandbox with a network namespace of its own (`bwrap --unshare-net`, `unshare -n`, a unit with
`PrivateNetwork=`) is refused too; the abstract socket alone would not have refused it. A
socket file left by a killed daemon answers nobody and is reclaimed by the next start, which
already holds the abstract socket. `pnpm craftingtable db migrate` takes the data
directory's lock, so stop the daemon before migrating by hand (the daemon also migrates on
start).

**The installed daemon** runs from a deploy checkout, never from a development checkout, so
editing, building or checking out branches there cannot change what it runs. Deploys go
through one command, run from any clone of the repository:

```sh
pnpm deploy:daemon <ref>             # build <ref>, drain, switch to it, restart, check health
pnpm deploy:daemon <ref> --when-idle # same, but wait until no agent turn is live instead of a bound
pnpm deploy:daemon --rollback        # drain, switch back to the previous release and restart (no rebuild)
pnpm deploy:daemon --status          # current release, recent deploys, unit check
```

The deploy root (`$CRAFTINGTABLE_DEPLOY_ROOT`, default `$XDG_DATA_HOME/craftingtable-deploy`)
holds a bare clone (`repo.git`), one directory per release (`releases/<time>-<commit>`, each
installed and built), a `current` symlink and an append-only `deploys.jsonl`. A failed build
leaves `current` untouched. So does a release whose migrations do not match the live database
(R-H3): after the build, and before draining or switching, the release's own storage code opens
the database read-only (`<data>/state/craftingtable.sqlite`, the data directory found as the
drain finds it: `CRAFTINGTABLE_DEPLOY_DATA_DIR`, then the unit's settings, where its
environment files override its `Environment=` lines as systemd has them, then the XDG default) and compares its migration ledger with the
release's migration files. An applied migration whose checksum or name differs, or one the
release does not know, stops the deploy with the ledger's code (`checksum-mismatch`,
`name-mismatch`, `unsupported-version`); so does a check that cannot run or cannot read the
database. A refusal removes the new release, records `preflight-refused`, and leaves the
running daemon alone. Pending migrations are fine: the release applies them when it starts.
The command prints the database it checked, or that there was none (a first deploy; anything
else means the data directory was not found). `--rollback` checks its target the same way,
since an older release cannot open a database a newer one has migrated; the refusal names the
pre-migration copies in `<data>/state/pre-migration/`. So does the automatic rollback after a
failed health check: if the new release migrated the database first, it stays, and the
command says why. On a stopped daemon's database the read-only open leaves empty `-wal` and
`-shm` files beside it (SQLite's own; the database's bytes are unchanged).
After the restart the command polls `/api/health` (host and port
from the unit's environment file, or `CRAFTINGTABLE_DEPLOY_HEALTH_URL`); if the new release
does not answer within 90 seconds, it switches back to the previous release and restarts that.
The five newest releases are kept (`--keep N`). The command asks for confirmation unless given
`--yes`.

**Restarts drain instead of stopping the roadmap.** Before switching releases the command asks
the running daemon to drain by writing a request file into its data directory. The daemon then
starts no new agent run and no roadmap admission, lets live turns finish for up to its drain
bound (`CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS`, default 180; `--when-idle` waits without a
bound), then interrupts what is still live and records a clean stop in the database. The
restarted daemon reads that record: running roadmaps and cycles keep running, a step whose
turn finished is classified as usual, and a step the drain interrupted resumes its vendor
session (`claude --resume`, Codex thread resume) in the same worktree with its original agent,
permissions, guidance and deadline, so only the in-flight tool call is redone. Pressing Ctrl-C
while the command waits, closing its terminal or stopping it withdraws the request; the daemon
resumes admissions and nothing is switched. If the daemon had already interrupted live runs,
or the command dies after the drain but before the restart, the drained daemon exits with
status 75 after two minutes and `Restart=on-failure` brings it back, so automation resumes
from the clean stop. `--no-drain` restarts the old way. A daemon that predates drain support does not
answer within 15 seconds, and the command then restarts it without draining.

A crash, a stop that did not finish draining, a step whose agent never reported a session id,
and a resume that fails all still stop for the operator: the cycle or roadmap needs attention
and waits for an explicit Resume. A migration on start first copies the populated database to
`state/pre-migration/` (the three newest copies are kept), so manual pre-upgrade backups are no
longer needed.

`SIGTERM` (a plain `systemctl stop`, `restart` or a reboot) runs the same bounded drain and a
second signal interrupts at once. That path drains only when systemd signals the daemon alone
and waits for it, which the unit below does: node runs the built daemon directly (a `pnpm`
wrapper may not forward the signal), `KillMode=mixed` signals only the daemon, which ends its
agents itself, and `TimeoutStopSec` is above the drain bound. For an existing unit, put the
three settings in `~/.config/systemd/user/craftingtable.service.d/drain.conf` (an empty
`ExecStart=` line first clears the old command). `pnpm deploy:daemon --status` checks all three
and prints the drop-in.

A `systemd --user` unit runs whatever `current` points at:

```ini
# ~/.config/systemd/user/craftingtable.service
[Unit]
Description=CraftingTable daemon
After=network-online.target

[Service]
WorkingDirectory=%h/.local/share/craftingtable-deploy/current
EnvironmentFile=%h/.config/craftingtable/env
ExecStart=/usr/bin/env node apps/server/dist/index.js
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=300

[Install]
WantedBy=default.target
```

with `~/.config/craftingtable/env` holding the `CRAFTINGTABLE_*` variables for the
route you chose below. Run the first `pnpm deploy:daemon <ref> --no-restart` to create
`current`, then enable the unit with `systemctl --user enable --now craftingtable` and
`loginctl enable-linger $USER` so it survives logout. `pnpm deploy:daemon --status` reports
when the unit does not run from `current`.

Agents start from named variables of the daemon's environment only (R-G5): HOME, USER,
LOGNAME, SHELL, PATH, LANG, LANGUAGE, `LC_*`, TERM, TZ, the four `XDG_*_HOME` directories,
proxy and CA variables, and the agent's own login variables (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`; `OPENAI_API_KEY`, `CODEX_API_KEY`,
`CODEX_HOME`). Desktop session variables, `XDG_RUNTIME_DIR` and SSH agents are not
passed. `CRAFTINGTABLE_AGENT_ENV_ALLOW=NAME,OTHER` lets further names through. PATH must
reach `git` and `claude` and/or `codex` (or set the explicit executable variables), and
HOME must be the account signed in to the selected agent. Run `codex login` as that account before
using Codex. Tool status reports executable availability, not authentication health.
`CRAFTINGTABLE_CODEX_EXECUTABLE` overrides discovery and `CRAFTINGTABLE_CODEX_MODELS`
replaces its model picker list. Codex app-server behavior was verified with CLI 0.153.4. The adapter communicates
over local stdio; do not start a separate app-server listener for CraftingTable.

Each run's agent process gets its own private temporary directory, `<12 hex characters>/`
beneath the agents' temporary root (LIVE-31): `<data>/t` by default, or
`CRAFTINGTABLE_AGENT_TMP_ROOT`, a normalized absolute path. Claude Code's command sandbox makes
Unix sockets there, whose paths hold at most 107 bytes, so the root must be short: each run's
directory is the root plus 13 bytes and must be at most 60, or Claude runs do not start (a
typed `agent-environment-unavailable` stop). Set the variable only where the data directory's path is
too long, to a directory used for nothing else. The directory goes when its run ends, and
each start removes what a stopped daemon left: only directories named as a run's (12
lowercase hex characters, never through a link). Anything else in the root stays, and the
start logs one warning naming it (TS-H3). The daemon refuses to start with a root that is
`/`, `/tmp`, `/var/tmp`, `/dev/shm`, `/run`, the daemon's `XDG_RUNTIME_DIR` or `TMPDIR`, its
`HOME`, or the account's home in the user database, or a directory above one of them (a
directory of its own inside them is fine); that is the database's directory `<data>/state`,
inside it, or above it (the data directory included; other directories inside the data
directory, such as the default `<data>/t`, are fine); or that overlaps the worktree, runs,
check-log or Cargo-home roots or the default backup directory `<data>/backups`. Paths are
compared as written and through their links, as far as they exist; a link that names nothing
yet is followed to what it names. A root that cannot be resolved (unreadable, a link loop) is
refused; a directory it is compared with that cannot be is compared as far as it can be read,
so an unreadable `HOME` or `TMPDIR` never stops the daemon starting. The check sees the runs and
backup roots as configured at start: **Settings → Storage** can move them later, and the check
does not follow, but the sweep's name filter still leaves whatever they hold. Two daemons
cannot share one root, since each start would sweep the other's live runs' directories: a
daemon also locks its agents' temporary root, canonically, as it locks its data directory, and
a second daemon on the same root exits at start, before its sweep, with a message naming the
holder (R-G5). The lock compares roots, not what lies inside them: a root that is a run-named
directory (12 hex characters) inside another daemon's root would still be swept by that
daemon's start. The root's socket file is `.craftingtable-daemon.lock` in the root, which the
sweep leaves without naming it. A root the
daemon cannot create (a link to a directory that does not exist yet, an unwritable parent)
stops its start with the variable's name.

The daemon runs the checks agents ask for with `ct-check` itself, each in a transient systemd user unit
(`craftingtable-check-<instance>-<request>.service`) with a read-only file system except the run's own
paths and no network (R-G4). The unit therefore needs the user manager: the daemon's environment must
carry `XDG_RUNTIME_DIR` (and the user bus), as the systemd unit provides. Their logs are kept under
`<data>/check-logs/<run>/`. On a host without a user manager, `CRAFTINGTABLE_CHECK_CONFINEMENT=none` runs
them as plain process groups. The daemon stops its own leftover check units when it starts. No check unit sees the user's runtime directory (`/run/user/<uid>`: its user bus would start units outside the confinement) or the system's Docker and D-Bus sockets; local CI keeps only its Docker socket.

Agents use the daemon's own Cargo home, `<data>/cargo-home`, never the operator's `~/.cargo` (R-G5
review): an agent may write its download caches, and nothing written there reaches the operator's
own builds. Check units never build from it (operator decisions 2026-09-29): Cargo trusts whatever
it finds in a Cargo home, so each check gets a fresh one under `<data>/check-logs/<run>/`
(`cargo-home-<n>`, one stable path per concurrent check, so build outputs stay reusable). Nothing
of the shared home's registry comes along, not even its index: the check's home is a local
registry the daemon builds, holding the published index entries of the crates the checked tree's
`Cargo.lock` files pin and only the downloaded crates whose SHA-256 matches the checksum crates.io
publishes, plus the Git dependencies whose locked commit a database holds, cloned through a pack.
Its configuration replaces crates.io with that registry, and the check runs with
`CARGO_NET_OFFLINE=true`, whatever the tree's own configuration says. Cargo extracts sources afresh.
A crate that is missing, rewritten or unverifiable is left out and named in the check's output,
and the build fails. The check cannot see the shared home, and its own is emptied when it ends. A declared check's unit sees none of the roots agents write, of any run (the data directory, run and worktree roots, the shared Cargo home, the CI cache, the repository's Git directory, the operator's whole home, `/dev/shm`), only its own clone, scratch, build outputs and Cargo home, and the Rust toolchain and trusted PATH directories under the home, read-only; its `HOME` is its scratch directory, so the tree's own Cargo configuration cannot point at agent-written files. A pinned build of a clean worktree, in a run prepared since R-G13's second increment, runs the same way on a private clone of the committed head, with private checkouts of the pinned upstream commits (fetched by exact commit through a verified pack, their trees checked against the pins) bound in read-only under `check-logs/<run>/<check>.private/pinned`; its target is `check-logs/<run>/declared-target/<commit>`. A pinned build of uncommitted work and supplemental checks still run in the agent's worktree. For runs prepared since then, a current-upstream gate (a review or checkpoint candidate built against current pins) is met only by every adopted check, run against private checkouts of the pins (patched in by a `.cargo/config.toml` the daemon writes above the clone; the tree's own Cargo configuration still outranks it), together with a pinned build that resolves a pinned crate; a repository with no adopted checks stops such a run as `repository-checks-undeclared`, as scoped runs already did. The daemon's `cargo` must be rustup's proxy (a link, hard link or copy) or a directly installed Cargo, not a shim script in front of rustup: every adopted check runs the checked commit's rustup-managed toolchain, resolved through that proxy. Every adopted check must name, as definition files, each Cargo configuration and toolchain file its commit tracks, at any depth. A Git dependency's locked commit is checked to be the bytes its name says, not to come from the dependency's own remote.

The daemon learns published crates from crates.io's own index over HTTPS
(`https://index.crates.io/`), once per crate, and keeps each crate's index file and every
version's checksum under `<data>/crates-io/`, since a published version never changes; a crate it
could not learn is asked about again after ten minutes, and it makes at most 500 requests in any ten minutes. This is the daemon's only outbound request of its own.
Without it (offline, or the index unreachable) a crate it has not seen before stays unverified, so
checks that need it fail until the index can be reached. Crates from other registries are never
verified. A tree without a committed `Cargo.lock` (or with a format-1 lock) gets no registry
crates, and the check says so. The approved native environment keeps the operator's Cargo home
(ADR-054). At each start the daemon copies into it, one way, the `registry` and
`git` caches of the operator's Cargo home that it lacks (`CARGO_HOME`, else `~/.cargo`; override with
`CRAFTINGTABLE_CARGO_SEED_FROM`, or set it empty to turn seeding off), so offline builds and Codex
runs, which cannot fetch, find what the operator has downloaded. Existing files are never replaced,
and no tokens, configuration or binaries are copied. The first start copies the whole cache (about
500 MB on this workstation; copy-on-write only when the data directory shares a file system with
it). A crate the operator fetches later reaches agents on the next daemon start.

`pnpm check` needs no care around a running daemon: the end-to-end suite uses ports and
data directories of its own.

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

Alerts are sent from the daemon's attention items (schema 32, ADR-070): every stop that
waits for the operator, such as merge approvals, design and review questions, failed runs,
exhausted limits, restart interruption, interrupted merges and failed cleanups, pending
planning amendments, queued dependency refreshes, held roadmap items, checkpoints ready for
evidence and verification setup, plus manual review outcomes, unresolved design conclusions
and failed or interrupted manual runs. Explicit cycle pause/stop does not nag. Items that are
due in the same wake go out as one message. A new item is pushed only after it has settled
for 30 seconds and both controllers have completed a pass since it opened; while you have the
workspace open, or issued a command in the last five minutes, a new item waits up to five
minutes and reminders wait until you stop issuing commands. Resuming, completing, merging, or removing the work resolves the corresponding
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
allows an explicitly requested test. The status list shows the latest 50 items, open ones
first. Every push attempt is kept in `notification_deliveries`. To count false alarms, pushed
items the daemon resolved without any operator command, query a read-only copy:
`SELECT count(*) FROM attention_items i WHERE resolved_by = 'automation' AND EXISTS (SELECT 1
FROM notification_deliveries d, json_each(d.state_json, '$.itemIds') e WHERE d.result =
'accepted' AND e.value = i.id)`.

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
ended roadmap is historical; create a new one for remaining items. After a drained restart the
roadmap continues on its own; after a crash, inspect the current item and explicitly resume
the roadmap. A completed operator merge is
recognized without rerunning that item. Reserved preparation IDs prevent replay from creating
another recorded worktree or cycle. Git and SQLite still do not form an atomic transaction:
if Git succeeded but its record was never committed, inspect the managed worktree/branch
before retrying, as with manual worktree creation.

Configured Pushover delivery handles item merge/attention checkpoints with the existing
reminder schedule. Scheduler failures without an existing item alert also produce roadmap
attention reminders; pause/stop resolves those reminders. Normal prerequisite/capacity waits
remain visible on the roadmap. Roadmap completion is shown in the app and activity journal.


## Parallel roadmaps

Choose **Scheduling mode → Parallel** when creating a roadmap. Existing definitions remain
sequential. No new migration is needed beyond schema 12. Set maximum in-flight items and
maximum in-flight items per repository (both default to 2), plus the integration-refresh
limit for each new item (default 3). In-flight includes work waiting for merge, paused work,
and work needing attention. The summary separately shows cycles currently running.

List order is scheduling priority. A blocked earlier entry does not stop an eligible later
entry. Required dependencies still come from the imported plan, and only operator merges
release started prerequisites. There is no implicit merge order based on position or item
number, and this increment does not import the draft cross-project map.

For a fork such as AQ-08 → AQ-09 and AQ-10, select all three and start once. AQ-08 runs first;
after its merge, both successors can get their own worktree from the updated integration
head. After merging either successor, the other updates from integration at an idle review
boundary and runs a fresh review with the combined-state checks. It may need remediation
again. Conflicts abort the update and require manual attention; the existing **Update from
integration** and cycle resume controls remain available. Exhausting the refresh limit also
requires a manual update before resuming. No controller performs a final merge.

Use comma-separated **Exclusion groups** on entries that must not overlap. Names are exact
and workspace-scoped; sharing any group prevents overlap until the holder merges or its
worktree is removed. Existing manual worktrees consume repository capacity, and an item
with a manual worktree is not delegated a duplicate. When multiple workspace roadmaps share
one registered checkout, admission respects the tightest active repository limit.

**Pause item** holds just that entry. **Resume item** retries its preparation or resumes its
paused cycle through normal handoff checks. Other eligible items continue if capacity permits.
An item already awaiting merge keeps its checkpoint, including when paused. Its operator
merge is still recognized and releases dependents. Item preparation failures use the existing
Pushover reminder schedule; sibling progress does not reset those reminders.

**Pause roadmap** stops new admission and pauses every running owned cycle; **Stop roadmap**
ends all owned cycles and retains their worktrees for manual work. Restart requires explicit
roadmap resume. Individually paused entries remain paused when the roadmap resumes. Parallel
priority can be reordered while paused, but started entries cannot be removed or have their
settings changed. Capacity edits apply to admission; lowering limits never cancels work.
Scheduling mode cannot change while attempts are in flight. Refresh limits for started items
remain bound to their execution revision, visible through **View revisions**.
