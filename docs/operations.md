# Operations

How to install, deploy, reach and maintain the daemon on the workstation. What each boundary
enforces, and why, is in [`security.md`](security.md); how to run roadmaps is in
[`roadmaps.md`](roadmaps.md); every setting is listed under
[Environment variables](#environment-variables).

## Data and settings locations

The **data directory** is `CRAFTINGTABLE_DATA_DIR`, else `$XDG_DATA_HOME/craftingtable`, else
`~/.local/share/craftingtable`. It holds:

```text
state/craftingtable.sqlite     the database (WAL mode: copy it only with a SQLite backup)
state/pre-migration/           the copy taken before the latest migration
state/processes/<runId>.json   each live run's process group, for restart recovery
state/daemon.lock.<id>         the single-daemon lock
worktrees/<repo>/<item>-<id>   managed worktrees (the default worktree root)
runs/<runId>/                  brief.md, plan/, handoff/, checks/, tool-results/, scratch/
runs/worktree-caches/<id>/     each worktree's shared Cargo target directory
t/<12 hex>/                    a sandboxed Claude run's own TMPDIR (the agents' temporary root)
backups/database/              database snapshots (the default backup root)
check-logs/<runId>/            logs, clones and Cargo homes of the checks the daemon runs
cargo-home/                    the agents' Cargo home (its registry and git caches)
crates-io/                     what the daemon learned from crates.io's index
uv/cache/                      the agents' shared uv cache, with the pypi outside source
uv/checks/                     uv's cache for Python checks' installs, which no agent writes
model-catalog/                 where Codex's catalog app-server runs
git-identity.gitconfig         the operator's user.name and user.email, for daemon Git
```

The **settings directory** is `CRAFTINGTABLE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/craftingtable`,
else `~/.config/craftingtable`. It holds `credentials.json` (Pushover tokens, mode 0600 in a 0700
directory), the optional `outside-sources.json` (see [Agents on the
workstation](#agents-on-the-workstation)), the optional `toolchains.json` (see
[Checks](#checks)), and by convention the unit's environment file, `env`. A
development daemon uses `craftingtable-dev` in place of `craftingtable` for both directories.

The worktree, runs and backup roots are storage settings: the environment seeds the first two at
the first start, and **Settings → Storage** owns all three afterwards
([Storage, backups and restore](#storage-backups-and-restore)).

## Running the daemon

**Development.** `pnpm dev` builds the packages, then runs a development daemon on
127.0.0.1:4601 with its own data and settings directories and the Vite UI on 127.0.0.1:5173, so
it can run beside the installed daemon. `pnpm craftingtable:dev <command>` runs the CLI against
that state (`pnpm craftingtable:dev admin bootstrap --username <name>` once). Set
`CRAFTINGTABLE_DATA_DIR`, `CRAFTINGTABLE_CONFIG_DIR` or `CRAFTINGTABLE_PORT` to override them.
`pnpm check` needs no care around a running daemon: the end-to-end suite uses ports 4610 and 5183
and data directories of its own.

**The installed daemon** runs from a deploy checkout, never from a development checkout, so
editing, building or switching branches there cannot change what it runs. A `systemd --user`
unit runs whatever the deploy root's `current` points at:

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

`~/.config/craftingtable/env` holds the `CRAFTINGTABLE_*` settings for the route you choose
under [Reaching the daemon](#reaching-the-daemon-from-another-machine). Create `current` with a
first `pnpm deploy:daemon <ref> --no-restart`, then `systemctl --user enable --now craftingtable`
and `loginctl enable-linger $USER` so it outlives your login. The three stop settings matter:
node runs the daemon directly (a `pnpm` wrapper may not forward SIGTERM), `KillMode=mixed`
signals only the daemon, which ends its agents itself, and `TimeoutStopSec` must exceed the drain
bound plus 90 seconds, so that a plain `systemctl stop`, a restart or a reboot drains
([Shutdown and recovery](#shutdown-and-recovery)). `pnpm deploy:daemon --status` checks all three
and prints a `drain.conf` drop-in when one is off.

**Prerequisites.** Git 2.43.0 or newer: the daemon refuses to start below it, since its merges
run `merge-tree` with `--attr-source`. With no Git found it starts, but cannot delegate. Claude
Code and Codex are described under [Agents on the workstation](#agents-on-the-workstation).

**One daemon per data directory.** Before anything opens the database, a daemon locks its data
directory (`state/daemon.lock.<id>`, plus an abstract socket on Linux) and its agents' temporary
root. A second daemon on either, such as a stray `pnpm start` in another checkout, even in another
network namespace, exits naming the holder. A lock a killed daemon left is cleared by the next
start. `db migrate` and `db compact-journal` take the lock, so they are refused while the daemon
runs; `admin bootstrap` and `admin reset-password` take it only when they would migrate, so run
them from the deployed release, not a newer checkout:

```sh
cd ~/.local/share/craftingtable-deploy/current
set -a; . ~/.config/craftingtable/env; set +a
pnpm craftingtable db status
```

## Deploying and rolling back

Deploys go through one command, run from any clone of the repository:

```sh
pnpm deploy:daemon <ref>             # build <ref>, check, drain, switch, restart, check health
pnpm deploy:daemon <ref> --when-idle # the same, but wait until no agent turn is live
pnpm deploy:daemon <ref> --no-drain  # restart without draining (live runs wait for Resume)
pnpm deploy:daemon <ref> --no-restart  # switch only; the next restart runs it
pnpm deploy:daemon --rollback        # drain, switch to the previous release, restart
pnpm deploy:daemon --status          # current release, the last eight deploys, unit checks
```

It asks for confirmation unless given `--yes` (and refuses without it when not on a terminal).
The deploy root (`CRAFTINGTABLE_DEPLOY_ROOT`, default `$XDG_DATA_HOME/craftingtable-deploy`)
holds a bare clone `repo.git`, one directory per release (`releases/<time>-<commit>`), the
`current` link the unit runs, and an append-only `deploys.jsonl`. A deploy:

1. fetches the branches and tags of the clone you run it in (the ref must be reachable from one;
   uncommitted changes are not deployed), checks the commit out as a new release, and runs
   `pnpm install --frozen-lockfile` and `pnpm build`; a failed build leaves `current` alone;
2. runs the migration preflight: the release's own storage code opens the live database read-only
   and compares its ledger with the release's migrations. Pending ones are fine (the release
   applies them at start); an applied one whose name or checksum differs, or one the release does
   not know, refuses the deploy with the ledger's code (`name-mismatch`, `checksum-mismatch`,
   `unsupported-version`), as does a check that cannot run. A refusal records `preflight-refused`
   and changes nothing else. The command prints the database it checked, or that there was none;
3. asks the running daemon to drain (`drain-request.json` in its data directory): it admits no new
   work, gives live turns up to its drain bound (`--when-idle`: no bound), interrupts the rest for
   resume and records a clean stop. Ctrl-C or closing the terminal withdraws the request. A daemon
   left drained with no restart exits with status 75 after two minutes, and `Restart=on-failure`
   brings it back; one that does not answer within 15 seconds is restarted without draining;
4. switches `current` in one rename, restarts the unit and polls `/api/health` for 90 seconds. If
   the new release does not answer, it switches back, unless the new release already migrated the
   database past what the previous one can open: then it stays, and the command says why;
5. keeps the newest releases (`--keep N`, default 5), and always the current and previous ones.

The data directory and health address come from the unit: `CRAFTINGTABLE_DEPLOY_DATA_DIR`, else
the unit's `CRAFTINGTABLE_DATA_DIR` (its environment files override its `Environment=` lines),
else the XDG default; `CRAFTINGTABLE_DEPLOY_HEALTH_URL`, else
`http://<unit host, 0.0.0.0 read as 127.0.0.1>:<unit port>/api/health`, or `https://` when the unit
sets `CRAFTINGTABLE_TLS_CERT` (the check then trusts that certificate, self-signed or a leaf a
private CA issued, and checks its chain, not its name, since it asks the unit's own address).

**Rolling back.** `--rollback` switches to the most recent previous release still on disk, with no
rebuild, after the same preflight. An older release cannot open a database a newer one migrated,
so a rollback across a migration is refused with `unsupported-version`, naming the
`state/pre-migration/` copy. That copy is the only way back, and it loses everything recorded
since: stop the daemon, keep the current database aside, put the copy in place as
`state/craftingtable.sqlite` with no old `-wal` or `-shm` files, then run
`pnpm deploy:daemon --rollback`. The daemon keeps only the newest pre-migration copy.

**Upgrading across schemas 38–40.** A release from before schema 38 cannot read what these
migrations store, so the preflight refuses any rollback across them:

- 0038 lets a run environment have no runtime: a run with no pinned dependency environment is now
  held to its repository's adopted checks through a check-only manifest;
- 0039 adds a head row beside each evidence submission, which views read instead of the record;
- 0040 rebuilds the workspace journal without the retired repository registry's columns and drops
  its three empty tables. Allow free space for the pre-migration copy (about the database's size).

**Upgrading to schema 41.** 0041 adds the wind-down, retired-version and repository-cleanup
records (R-B11, ADR-073), empty at upgrade, with their audit actions and event kinds. A release
from before schema 41 cannot open the migrated database, so the preflight refuses a rollback across
it; the pre-migration copy is the only way back and loses every wind-down, retirement and cleanup
recorded since. Refs a cleanup deleted are not restored by any rollback: their commits are in their
integration branch or in a local `<repository>/parked/<branch>` tag.

The release needs Git 2.43.0 or newer. One refused for an older Git stops before it opens the
database, so the deploy's automatic rollback restores the previous release. After deploying:

- **Reload every open page.** The API's paths changed without aliases; a page loaded before the
  deploy asks the old ones.
- **Sign in again, once.** On an HTTPS origin the session cookie is now
  `__Host-craftingtable_session`; the daemon no longer reads the old name, and the first sign-in
  clears it. Rolling back to an earlier release signs everyone out again, since that release reads
  only the old name.
- **Adopt checks in every repository a roadmap runs in.** A roadmap's cycle in a repository with
  no adopted `.craftingtable/checks.json` stops as `repository-checks-undeclared` before anything
  launches (ActionQueue has none yet). Adopt on the Repositories page.
- **Reviews prepared without the adopted checks are refused at merge** in a repository that has an
  adoption, whenever they were prepared; a fresh review runs them first. The refusal says what to
  do: run a fresh review, or pause and resume the cycle (and then its roadmap).
- `outside-sources.json` is optional: without it the one source is `cargo`.

## Reaching the daemon from another machine

The daemon refuses a non-loopback `CRAFTINGTABLE_HOST` unless it serves TLS itself or its public
origin is HTTPS behind a proxy. The public origin must be exactly the URL the browser shows: the
CSRF and origin checks compare against it, and the session cookie is `Secure` on HTTPS. Use that
address on the workstation too: `http://localhost:4600` may show the app, but sign-in is refused,
and the error names the required address.

### Over a Tailscale tailnet

The recommended route. The daemon stays on loopback and `tailscale serve` terminates TLS in front
of it, with a certificate `tailscaled` renews, so nothing opens on the LAN and the laptop trusts
it with nothing to install. Only devices on the tailnet reach it.

```sh
tailscale status --json | jq -r .Self.DNSName   # the machine's name; drop the trailing dot
tailscale set --operator=$USER                   # lets you configure serve without root
```

Put the name in `~/.config/craftingtable/env`, leaving the listener on loopback:

```sh
CRAFTINGTABLE_HOST=127.0.0.1
CRAFTINGTABLE_PORT=4600
CRAFTINGTABLE_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net
```

Restart the unit, then publish it: `tailscale serve --bg --https=443 http://127.0.0.1:4600`.
`tailscale serve status` shows the mapping, `tailscale serve --https=443 off` removes it, and it
survives a reboot. Open `https://<machine>.<tailnet>.ts.net`, with no port. Two surprises: a node
brought up with `--accept-dns=false` cannot resolve its own name, so test from the workstation
with `curl --resolve <name>:443:<tailscale-ip> https://<name>/api/health`; and `tailscale serve`
may warn that serve is not enabled on the tailnet and still succeed (the warning links to the
admin setting to turn on if the proxy stops working).

### Directly on the LAN

Give the daemon a certificate of its own, for example a self-signed one for the workstation's LAN
name and address:

```sh
mkdir -p ~/.config/craftingtable
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=workstation.lan" -addext "subjectAltName=DNS:workstation.lan,IP:192.168.1.20" \
  -keyout ~/.config/craftingtable/key.pem -out ~/.config/craftingtable/cert.pem
chmod 600 ~/.config/craftingtable/key.pem
```

Then set, in `~/.config/craftingtable/env` (or, to try it from a checkout, in the environment of
`pnpm build && pnpm start`):

```sh
CRAFTINGTABLE_HOST=0.0.0.0
CRAFTINGTABLE_PORT=4600
CRAFTINGTABLE_PUBLIC_ORIGIN=https://workstation.lan:4600
CRAFTINGTABLE_TLS_CERT=/home/<you>/.config/craftingtable/cert.pem
CRAFTINGTABLE_TLS_KEY=/home/<you>/.config/craftingtable/key.pem
```

This route also needs the host firewall to allow the port on the LAN interface, a stable address
(a DHCP reservation or a `.local` name), and the certificate trusted on every device that
connects. With `CRAFTINGTABLE_TLS_CERT` in the unit's environment, the deploy's health check asks
over HTTPS and trusts that certificate ([Deploying and rolling
back](#deploying-and-rolling-back)).

## Agents on the workstation

**CLIs and logins.** Install Claude Code (`claude`, found on PATH or in `~/.local/bin`) or Codex
(`codex`, likewise), signed in as the daemon's OS user (`codex login` for Codex); the explicit
`CRAFTINGTABLE_CLAUDE_EXECUTABLE`, `CRAFTINGTABLE_CODEX_EXECUTABLE` and
`CRAFTINGTABLE_GIT_EXECUTABLE` override discovery. The daemon registers whichever it finds. A
sandboxed Claude run also needs `bwrap` and `socat` on its PATH, or it stops before launch as
`agent-environment-unavailable`. Repositories → **Tools on the workstation** shows what was found;
it reports availability, not whether a login is still valid.

**Environment.** Agents start from named variables of the daemon's environment only: `HOME`,
`USER`, `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `TZ`, the four
`XDG_*_HOME` directories, proxy and CA variables, and their own login variables
(`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`; `OPENAI_API_KEY`,
`CODEX_API_KEY`, `CODEX_HOME`). `CRAFTINGTABLE_AGENT_ENV_ALLOW=NAME,OTHER` lets more through.
`HOME` must be the account signed in to the agent.

**Models.** Pickers offer each CLI's own catalog, read at start, hourly and on **Refresh models**
(Tools on the workstation): Claude Code's cached per-account catalog
(`<CLAUDE_CONFIG_DIR or ~/.claude>/cache/model-catalog/`), after the `opus`, `sonnet` and `haiku`
aliases, and Codex's app-server `model/list`. Until a catalog is read the release's own list is
offered, and the tool status says why. `CRAFTINGTABLE_CLAUDE_MODELS` and
`CRAFTINGTABLE_CODEX_MODELS` (`id=Label,id2`) replace a catalog. A run whose model is a display
name or another spelling of an id is not started (`agent-model-misnamed`).

**Temporary directories.** A sandboxed Claude run's own TMPDIR is a 12-hex-character directory in
the agents' temporary root, `<data>/t`; its commands use the run's `scratch/`. Claude's sandbox
makes Unix sockets there, so each directory may be at most 60 bytes long. Set
`CRAFTINGTABLE_AGENT_TMP_ROOT` only when the data directory's path is too long, to a directory of
its own: the daemon refuses one that is or holds `/`, `/tmp`, `/var/tmp`, `/dev/shm`, `/run`,
`XDG_RUNTIME_DIR`, `TMPDIR` or the home, or that overlaps its other roots. Each start removes the
run directories a stopped daemon left there, and logs anything else it finds.

**Outside sources** are the hosts a sandboxed agent command may reach, and the caches it may write
beside its run ([security.md](security.md#agent-sandboxes) says how each agent enforces them).
They are read from `outside-sources.json` in the settings directory at start; edit it and restart:

```json
{ "version": 1, "sources": [{ "kind": "cargo", "extraHosts": ["mirror.example.org"] }] }
```

- `cargo`: `index.crates.io` and `static.crates.io` (what a sparse `cargo fetch` reads, never the
  `crates.io` API), writing the `registry` and `git` caches of the agents' Cargo home.
  `extraHosts` are exact lowercase names of at least three labels: no wildcard, address, port or
  trailing dot.
- `pypi` (R-G17): `pypi.org` and `files.pythonhosted.org`, writing the agents' shared uv cache,
  `<data>/uv/cache`. It takes no `extraHosts` and needs the Python profile in `toolchains.json`
  ([Checks](#checks)): agents get its uv first on PATH, `UV_PYTHON` set to its interpreter,
  `UV_CACHE_DIR` set to the cache and `UV_PYTHON_DOWNLOADS=never`, so a sandboxed `uv sync`
  resolves as checks do. Checks never read that cache: their installs keep their own,
  `<data>/uv/checks` ([Checks](#checks)).
- No file means the `cargo` source. `"sources": []` means none: sandboxed commands reach no
  network, and `cargo fetch` and `uv sync` fail. For a Python project, add
  `{ "kind": "pypi" }` beside `{ "kind": "cargo" }`.
- An invalid file (bad JSON, an unknown key or kind, a bad host, not a regular file, over 64 KiB)
  or a cache that is a link or overlaps a daemon root stops the start, naming the problem.
- Tools on the workstation shows the effective list; each run's journal notes at launch what its
  commands may reach. Read-only runs get none; `unrestricted` runs have no sandbox.
- A sandboxed or read-only Codex run can mask at most one existing file in Codex 0.160.0; one that
  would need more (for example Cargo registry tokens left in `<data>/cargo-home`) is refused
  before it starts as `agent-environment-unavailable`, naming the files: move all but one away.
  A system Docker socket (`/run/docker.sock`) already takes that one, so on such a workstation
  creating `~/.netrc` or `~/.pypirc` (or uv's credentials file) stops every sandboxed and
  read-only Codex run until the file is moved; keep PyPI credentials out of the home directory.

**Cargo.** Agents use the daemon's own Cargo home, `<data>/cargo-home`, never `~/.cargo`. Each
start copies into it, one way, the `registry` and `git` caches of the operator's Cargo home that it
lacks (`CARGO_HOME`, else `~/.cargo`; `CRAFTINGTABLE_CARGO_SEED_FROM` names another, or empty turns
seeding off); nothing is replaced, and no tokens, configuration or binaries are copied. A crate you
fetch later reaches agents at the next start. Checks never build from that home: the daemon builds
each check a registry of its own from crates.io's published index, which it reads over HTTPS once
per crate and keeps in `<data>/crates-io/` (its only outbound request besides Pushover). Offline, a
crate it has not seen before stays unverified, and checks that need it fail naming it.

## Checks

The daemon runs the checks agents ask for (`ct-check`, `ct-act`, `ct-native`, the Cargo launcher's
builds) itself, outside the agent's process tree, as transient systemd user units. A `ct-check`
and a launcher build run in `craftingtable-check-<instance>-<request>` with a read-only file
system apart from the run's own paths and no network; `ct-act` keeps the network and its Docker
socket; `ct-native` starts the approved native unit, `craftingtable-native-<run>`, which is
bounded in CPU, memory, tasks and time but not confined in its files or network, and builds with
the operator's `~/.cargo` ([security.md](security.md#checks-and-builds)). The daemon therefore
needs the user manager: its environment must carry `XDG_RUNTIME_DIR` and the user bus, as the unit
provides. On a host without one, `CRAFTINGTABLE_CHECK_CONFINEMENT=none` runs checks as plain
process groups. Logs are kept in `<data>/check-logs/<run>/`, and a start stops the check units a
previous daemon left.

- **Adopted checks.** A repository's checks are its `.craftingtable/checks.json`, adopted by a
  person on the Repositories page at a branch or exact commit. Every run in a repository with an
  adoption is held to it, and its merge needs a clean, successful daemon run of each check on the
  reviewed commit. A roadmap's cycle in a repository with no adoption stops as
  `repository-checks-undeclared`; other runs there merge on their review alone.
- **Toolchains.** When `cargo` on the daemon's PATH is rustup's proxy (a link, hard link or copy of
  rustup), each check runs the checked commit's rustup-managed toolchain, with automatic installs
  off: install the toolchains a repository pins, or its checks fail saying so. A shim script in
  front of rustup is treated as a directly installed Cargo.
- **Caps.** Every check unit is capped at 8 GB of memory, no swap, and 1024 tasks (threads
  count), unless `toolchains.json` sets `limits` (below). A check that needs more fails as the
  kernel refuses it: raise the cap and restart.
- **Python toolchain** ([ADR-074](decisions/ADR-074-python-toolchains-and-pypi-wheels.md)). A
  repository whose reviewed commit has a root `uv.lock` gets the Python profile in its adopted
  checks. Install the toolchain as root, so agents, which run as your account, cannot change it:

  ```sh
  # uv: the official release, checked against its published SHA-256
  sudo install -D -o root -g root -m 0755 ./uv /opt/craftingtable/bin/uv
  # CPython, installed by that uv
  sudo /opt/craftingtable/bin/uv python install 3.12.15 --install-dir /opt/craftingtable/python --no-bin
  ```

  Then name them in `toolchains.json` in the settings directory and restart:

  ```json
  {
    "version": 1,
    "python": {
      "interpreter": "/opt/craftingtable/python/cpython-3.12.15-linux-x86_64-gnu/bin/python3.12",
      "version": "3.12"
    },
    "uv": { "path": "/opt/craftingtable/bin/uv", "version": "0.12" },
    "media": { "ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe", "fonts": [] },
    "limits": { "memoryMax": "8G", "tasksMax": 1024 }
  }
  ```

  - Every part but `version` is optional; `python` and `uv` go together, and `media` needs them.
    No file means no Python profile and the default caps.
  - Each path must be the file itself (no link, so not the `cpython-3.12-…` alias), a regular
    file that root owns and only root may write, every directory above it too, outside the data
    directory and every root agents write. `version` is a prefix the tool's version must fit:
    `"3.12"` takes any 3.12.x. `memoryMax` takes K, M or G, from 256M to 256G; `tasksMax` 64 to
    65536.
  - An invalid file (bad JSON, an unknown key, a tool that breaks the rule, a bad cap, a link or
    non-regular file, over 64 KiB) stops the start, naming the problem. The start runs no tool.
  - Tools on the workstation shows each tool's path, version, owner, mode and SHA-256 as the
    start's probe and the latest check read them, and what changed and when since the start.
    Every Python check reads them again: a tool that is missing, no longer root-owned, writable by
    others or no longer fits its version refuses the check, naming it; an update that still fits
    is recorded there and in the receipt, and needs no restart.
- **Python checks** (R-G17, R-G19; [ADR-076](decisions/ADR-076-python-checks-install-with-uv-sync.md)).
  With the profile configured, an adopted check of a commit with a root `uv.lock` runs in a fresh
  venv that an install step builds first with `uv sync --locked`, from PyPI, with the network;
  the check itself then runs offline. uv's cache for these installs is `<data>/uv/checks`; it grows
  with every check (each builds its project anew), and the daemon empties it at each start. A
  daemon from before R-G19 left `<data>/pypi-wheels/`, which nothing reads; delete it. For a
  repository to adopt such checks, its `.craftingtable/checks.json` must:
  - list, in every check's `definitionPaths`, each Python environment file the commit tracks at
    any depth (`pyproject.toml`, `uv.lock`, `uv.toml`, `.python-version`, `pytest.ini`,
    `.pytest.ini`, `pytest.toml`, `.pytest.toml`, `.coveragerc`, `tox.ini`, `setup.cfg`,
    `ruff.toml`, `.ruff.toml`, `mypy.ini`, `.mypy.ini`), as well as Cargo's files where it has
    them; at most 50 paths per check;
  - run its tools as the agents do: the install puts the project's console scripts and its
    dependencies' on PATH (`pytest`, the project's own commands), and `python -m …`, scripts and `uv run …`
    (offline, never syncing) work too.

  The project may be packaged (its build backend, from PyPI or uv's own `uv_build`, runs in the
  install; console scripts are installed) or virtual (`tool.uv.package = false`). The lock may
  name PyPI packages, with wheels or only a source distribution (built in the install), the
  project itself, workspace members and paths inside the repository; a Git, URL or other-index
  source, or a path outside the repository, is refused by name. The install ignores the project's
  uv settings (`UV_NO_CONFIG`) but passes uv the resolver options the lock records
  (`exclude-newer`, `resolution`, `prerelease`, `fork-strategy`), and takes uv's default groups
  (`dev`, or the project's `tool.uv.default-groups`), not extras. Its `PATH` is `/usr/bin:/bin`,
  so a source distribution whose build needs another tool (rustup's Cargo, Go) fails there. Changing a listed file,
  `uv.lock` included, stops the slice as `check-definition-changed` until the checks are adopted
  again. Agents should `uv sync` first; their brief says so.
- **Local CI** (`ct-act`) needs `CRAFTINGTABLE_ACT_CONFIG`, a private JSON file naming act, Docker,
  a local Docker socket, a cache root and an image pinned by digest; see
  [`scripts/local-ci/README.md`](../scripts/local-ci/README.md). **Native verification** and Kata
  readiness are in [`scripts/kata/README.md`](../scripts/kata/README.md);
  `CRAFTINGTABLE_KATA_READINESS` names the root-owned smoke-test receipt the workstation audit shows.

## Storage, backups and restore

**Settings → Storage** governs the whole installation, so only an owner of every active workspace
can see or change it. Roots are separate normalized absolute workstation directories; the daemon
creates at most one missing leaf, never a missing mount. Canonical paths and devices are pinned:
a missing or changed volume is refused until restored, rather than filling the OS disk. Changes
apply to future allocations; existing checkouts and run directories keep their recorded paths.

**Scan storage** inventories run directories and checkouts without following links or nested
mounts. **Clean eligible files** removes only what the daemon's own preview listed, after checking
eligibility and identity again; previews expire on restart, a settings change or a cleanup.
Defaults:

- a run's recognised Cargo build caches (found up to four levels into its `scratch/`) go once it
  has ended and nothing else runs in its worktree; a worktree's shared Cargo target goes once the
  worktree is merged or removed and idle;
- the rest of a run's scratch, and its large tool-result bodies, expire 30 days after the later of
  the run's end and its worktree's removal, once the worktree is merged and removed and nothing in
  them changed for 30 days. **Keep until manually removed** turns expiry off;
- briefs, plan and handoff documents, messages, findings and the whole database are kept;
- a launch or new worktree needs 5 GiB free on its volumes; this cannot stop a build already
  running;
- a database snapshot every 24 hours, seven kept in the current backup root. Maintenance runs once
  a minute while the daemon runs and retries failures.

**Back up database now** writes a snapshot with SQLite's online backup API into
`<backup root>/database/` (0700, files 0600; it needs twice the database's size free, at least
1 GiB). Snapshots hold sessions and accounts: keep them private. Retention removes only this
feature's snapshots in the current backup directory; a crash while writing can leave a `.partial`
file. A snapshot covers plans, accounts, settings and run and event history, not repositories,
unmerged work, agents' session stores or run directories: back those up separately (pushed
commits, or a filesystem backup with the daemon stopped), preferably on another disk.

**Restore.** Stop the daemon, keep the current data directory aside, and put the snapshot in place
as `state/craftingtable.sqlite` without old `-wal` and `-shm` files. Restore worktrees and run
directories at their recorded paths, start the daemon, and inspect interrupted cycles before
resuming them. Never copy a live database file, or its `-wal` and `-shm`, by themselves.

**Moving the data directory** is offline and manual: storage roots and run directories are
recorded with canonical paths and devices, so a copy behind a symlink fails those checks, and no
command rewrites them. Move worktrees and runs through **Settings → Storage** instead. When data
lives on another volume, add `ConditionPathIsMountPoint=/mnt/<volume>` to the unit's `[Unit]`, so
an absent volume cannot start a fresh database on the OS disk.

**Checking a database.** `pnpm db:verify <database>` copies the file with the backup API into
`TMPDIR`, migrates the copy and checks every record against the current contracts, plus SQLite's
integrity and foreign-key checks. Point it at a snapshot, never the live file, before deploying a
contract or schema change. A failing record is a defect, or a historical shape that needs an
upcaster in `packages/storage/src/records.ts`.

**Rehearsing a wind-down.** Before winding down and cleaning up a roadmap on the daemon, run it on
copies (R-B11): `pnpm rehearse:wind-down --database <data dir>/state/craftingtable.sqlite --out <new
directory> --roadmap <id> [--retire <plan version>=superseded|parked]...`. It reads the live
database only immutably (a write not yet checkpointed is not in the copy; a read during a checkpoint
can mix moments, so the copy must pass `db:verify`'s checks, and an idle daemon gives a clean copy),
refuses a checkout whose Git directory is not its own, copies the repositories the roadmap's records
name with their managed worktrees into `<out>`, points every other repository and worktree record at
a path that does not exist, and runs the real wind-down and cleanup there with Git and no agent.
`<out>/report.json` gives every figure and every ref that moved; run the `git fsck` lines it lists.
Nothing it does reaches the live database or a live checkout.

**Compacting the journal.** Runs journaled before raw vendor lines stopped being stored keep their
old rows until compacted, with the daemon stopped:

1. take a snapshot and check it with `pnpm db:verify <snapshot>`;
2. `systemctl --user stop craftingtable`;
3. `pnpm craftingtable db compact-journal` reports what would change and writes nothing; it refuses
   a database with pending migrations (start the new release once first);
4. `pnpm craftingtable db compact-journal --apply --vacuum` rewrites ended runs, one transaction
   each with a `storage.journal-compacted` audit record, writing tool-result bodies over 4 KiB to
   each run's `tool-results/` first (or under `--bodies <dir>`); VACUUM then needs free space of
   about twice the database and blocks all writers;
5. start the daemon and check a compacted run's page.

## Notifications

Pushover alerts are configured per workspace by an owner, under **Settings → Notifications**:

1. install Pushover on the phone, create an application at https://pushover.net/apps/build, and
   copy its API token and your user key;
2. enter both, and optionally a device name (blank sends to every device of the account);
3. check the time zone and daily time (America/Los_Angeles, 21:00 by default), tick **Ready for
   merge**, **Needs attention** or both, **Enable notifications**, save, and **Send test
   notification**.

Alerts are the workspace's Needs you items. A new item is pushed only once it has stayed open 30
seconds and the controllers have finished a pass since it opened (at most two minutes); while you
have the workspace open, or sent a command in the last five minutes, it waits up to five minutes.
Items due together go as one message. After the first accepted push, reminders follow at +30,
+60, +120, +180, +240, +300 and +360 minutes, then daily at the configured local time, held while
you are issuing commands. After downtime an item gets at most one overdue reminder. Resolving the
stop resolves its alert.

Transient failures retry after 30 s, 1, 5 and 15 minutes, then hourly, using up no reminders. A
Pushover rate limit holds the workspace's alerts until its reset (at least an hour); a rejection,
until the settings are saved or a test is sent. Links use `CRAFTINGTABLE_PUBLIC_ORIGIN`, so they
open where that address resolves (on the tailnet). Pushover sees the items' titles, short reasons
and the link, never conversations or findings, and sends at normal priority (quiet hours apply).
Delivery means Pushover accepted the request; a lost response can duplicate one. Every attempt is
kept in `notification_deliveries`. To count false alarms (pushed items the daemon resolved with
no operator command) on a read-only copy:

```sql
SELECT count(*) FROM attention_items i WHERE resolved_by = 'automation' AND EXISTS (
  SELECT 1 FROM notification_deliveries d, json_each(d.state_json, '$.itemIds') e
  WHERE d.result = 'accepted' AND e.value = i.id);
```

## Shutdown and recovery

`SIGTERM` or `SIGINT` (a `systemctl stop` or restart, a reboot) drains as a deploy does: no new
work starts, live turns get up to the drain bound to finish, what is still live is interrupted for
resume, and a clean stop is recorded. Pages keep working meanwhile; launches and the storage page's manual commands are refused.
Then requests that change state are answered 503 ("stopping"), those still running get up to 30
seconds to finish, and the HTTP listener, the daemon's checks and the database close. A second
signal interrupts live turns at once. After a clean stop the next start resumes on
its own: running roadmaps and cycles continue, and each interrupted step resumes its vendor session
in the same worktree with its original agent, permissions, guidance and deadline.

After a crash, a stop that did not finish draining, a step whose agent never reported a session,
or a resume that fails, the work waits for an explicit Resume: the next start ends any process
group its own record proves was a live run's, marks those runs `interrupted`, and the cycle or
roadmap needs attention. Worktrees survive restarts. A daemon Git command refused with
`untrusted-git-directory` in a managed run's worktree or repository most often means the run's Git
directory holds a non-empty `config.worktree`, which Git never writes there: inspect it, then
empty it to go on ([security.md](security.md#the-daemons-own-git)). A Claude run killed while one of its
commands ran can leave Claude Code's own empty `config.lock` in the repository's Git directory
(`git config` there then fails with "could not lock config file"); before R-G19 it could also leave
an empty `commondir` (Git in the primary checkout then fails with "failed to read
.git/commondir"). With no Claude run live in that repository, delete an empty `config.lock` or `commondir`
([security.md](security.md#known-limits)). Removing a worktree whose
directory was deleted by hand prunes it from Git's metadata and marks it removed.

## Forgotten password

On the workstation, as the daemon's OS user, from the deployed release with the daemon's
environment ([Running the daemon](#running-the-daemon)):

```sh
pnpm craftingtable admin reset-password --username <name>
```

It prints the database path, refuses a missing database or an inactive or unknown user, and asks
twice for the new password without echoing it (Ctrl-C cancels; Ctrl-U clears). The password is 12
to 1024 UTF-8 bytes, as in the browser. Never pass a password in arguments or the environment. Its
authority is local access to the database: it replaces the hash, revokes every login session of
that user and records an audit entry, all in one transaction, and leaves everything else intact.

## Deleting all application data

Stop the daemon, then delete the data directory (and the settings directory, which holds the
Pushover credentials). Registered repositories are untouched, but their linked worktrees stay in
`git worktree list` until `git worktree prune` in each primary checkout.

## Environment variables

Settings are read once, at start, from the process environment (the unit's environment file for
the installed daemon). Defaults suit loopback development. A value out of bounds stops the start.

### Daemon

Read by `apps/server/src/config.ts` unless the meaning says otherwise.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_HOST` | `127.0.0.1` | Listen address: a host name or IP. Anything but loopback needs TLS or an HTTPS public origin. |
| `CRAFTINGTABLE_PORT` | `4600` (`pnpm dev`: `4601`) | Listen port, 1–65535. |
| `CRAFTINGTABLE_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | The origin the browser uses: CSRF and origin checks, the Host check, cookie security, notification links. |
| `CRAFTINGTABLE_TLS_CERT` | unset | Absolute PEM path; set with the key to serve HTTPS directly. |
| `CRAFTINGTABLE_TLS_KEY` | unset | Absolute PEM path of the certificate's key. |
| `CRAFTINGTABLE_WEB_DIST` | `apps/web/dist` when built | Absolute path of the built browser app to serve; empty serves the API only. |
| `CRAFTINGTABLE_DATA_DIR` | `$XDG_DATA_HOME/craftingtable` | Absolute data directory ([locations](#data-and-settings-locations)); `pnpm dev`: `craftingtable-dev`. |
| `CRAFTINGTABLE_CONFIG_DIR` | `$XDG_CONFIG_HOME/craftingtable` | Absolute settings directory (credentials, outside sources); `pnpm dev`: `craftingtable-dev`. |
| `CRAFTINGTABLE_REPOSITORY_ROOTS` | unset | Normalized absolute directories, colon-separated, that repositories may be registered under; unset refuses every new registration. |
| `CRAFTINGTABLE_SESSION_LIFETIME_SECONDS` | `2592000` (30 days) | Longest a login session lives, 300–7776000. |
| `CRAFTINGTABLE_SESSION_IDLE_SECONDS` | `86400` | A session with no request for this long ends, 600 to the lifetime. |
| `CRAFTINGTABLE_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS` | `180` | How long a stop waits for live turns before interrupting them, 0–3600. |
| `CRAFTINGTABLE_WORKTREE_ROOT` | `<data>/worktrees` | Seeds the storage settings' worktree root at the first start; Settings owns it afterwards. |
| `CRAFTINGTABLE_RUNS_ROOT` | `<data>/runs` | Seeds the runs root likewise; must not overlap the worktree root. |
| `CRAFTINGTABLE_AGENT_TMP_ROOT` | `<data>/t` | Normalized absolute directory for sandboxed Claude runs' own TMPDIRs; each must be at most 60 bytes. |
| `CRAFTINGTABLE_GIT_EXECUTABLE` | `git` on `PATH` | Normalized absolute path of the daemon's Git (2.43.0 or newer). |
| `CRAFTINGTABLE_CLAUDE_EXECUTABLE` | `claude` on `PATH`, then `~/.local/bin` | Normalized absolute path of Claude Code. |
| `CRAFTINGTABLE_CODEX_EXECUTABLE` | `codex` on `PATH`, then `~/.local/bin` | Normalized absolute path of Codex. |
| `CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS` | `60000` | How long one daemon Git command (a worktree creation, a merge and its drivers) may run, 10 s to 30 min. |
| `CRAFTINGTABLE_DIFF_LIMIT_BYTES` | `4194304` (4 MiB) | Largest patch one diff answer carries, 64 KiB to 64 MiB. |
| `CRAFTINGTABLE_DEVELOPMENT_CAPACITY` | `2` | Development slots, 1–32, until saved under Settings → Capacity. |
| `CRAFTINGTABLE_VERIFICATION_CAPACITY` | `1` | Verification and acceptance slots, 1–32, likewise. |
| `CRAFTINGTABLE_CLAUDE_MODELS` | unset (the catalog) | `id=Label,id2`: replaces Claude Code's model catalog. |
| `CRAFTINGTABLE_CODEX_MODELS` | unset (the catalog) | `id=Label,id2`: replaces Codex's model catalog. |
| `CRAFTINGTABLE_AGENT_ENV_ALLOW` | unset | Comma-separated variable names agents receive beyond the built-in list. |
| `CRAFTINGTABLE_CARGO_SEED_FROM` | `$CARGO_HOME`, else `~/.cargo` | Normalized absolute Cargo home whose caches seed the agents' at start; empty turns seeding off. |
| `CRAFTINGTABLE_CHECK_CONFINEMENT` | `systemd` | `none` runs checks as plain process groups (no user manager; tests). |
| `CRAFTINGTABLE_ACT_CONFIG` | unset | Local CI installation file for `ct-act` (`services/runtime-evidence-service.ts`). |
| `CRAFTINGTABLE_KATA_READINESS` | unset | Root-owned Kata smoke-test receipt shown in workstation audits (`packages/agents/src/native-environment.ts`). |
| `XDG_DATA_HOME` | `~/.local/share` | Base of the default data directory (absolute values only). |
| `XDG_CONFIG_HOME` | `~/.config` | Base of the default settings directory (absolute values only). |
| `XDG_RUNTIME_DIR` | set by the user manager | Needed for check units; also a directory the agents' temporary root may not be or contain. |
| `HOME` | the account's | Default bases and Cargo home; the agents' temporary root may not be or contain it. |
| `TMPDIR` | `/tmp` | The agents' temporary root may not be or contain it. |
| `CARGO_HOME` | `~/.cargo` | The default for `CRAFTINGTABLE_CARGO_SEED_FROM`. |
| `RUSTUP_HOME` | `~/.rustup` | Where rustup keeps toolchains; passed into checks, which run the checked commit's toolchain from it (`check-request-service.ts`, `local-check.ts`). |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's account directory: its model catalog, and passed to Claude runs (`packages/agents/src/claude-code/catalog.ts`). |
| `PATH` | | Where `git`, `claude`, `codex`, `cargo`, `bwrap` and `socat` are found. |

### Deploy

Read by `scripts/deploy-daemon.mjs`.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_DEPLOY_ROOT` | `$XDG_DATA_HOME/craftingtable-deploy` | The bare clone, releases, `current` and `deploys.jsonl`. |
| `CRAFTINGTABLE_DEPLOY_DATA_DIR` | the unit's `CRAFTINGTABLE_DATA_DIR`, else the XDG default | The data directory a drain request and the migration preflight use. |
| `CRAFTINGTABLE_DEPLOY_HEALTH_URL` | `http://<unit host>:<unit port>/api/health` (`https://` with the unit's TLS certificate) | What the health check polls after a restart. |
| `CRAFTINGTABLE_DEPLOY_UNIT` | `craftingtable` | The systemd user unit to drain, restart and check. |
| `XDG_DATA_HOME` | `~/.local/share` | Base of the default deploy root and data directory. |

### Tests

Read by the test harness: `vitest.config.ts`, `playwright.config.ts`, `e2e/` and the named tests.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_TEST_DATA_ROOT` | `$XDG_RUNTIME_DIR` (tmpfs) | Where test daemons keep their data: a directory of its own on a disk, beside the data directory and never inside it, so confined checks can see e2e worktrees (`apps/server/test/e2e/test-data-root.ts`). |
| `CRAFTINGTABLE_TEST_TIMEOUT_SCALE` | `1` | A positive factor for every test and e2e timeout on a slow or busy host. |
| `CRAFTINGTABLE_E2E_WORKERS` | `4` | Playwright workers. |
| `CRAFTINGTABLE_WALKTHROUGH` | unset | `1` records the UI walkthrough (`pnpm ui:walkthrough`); `rehearse` walks it without captures (`pnpm test:e2e`). |
| `CRAFTINGTABLE_WALKTHROUGH_DIR` | `$XDG_DATA_HOME/craftingtable-walkthrough` | Where walkthrough images go, outside the repository. |
| `WALKTHROUGH_LABEL` | the commit | The walkthrough capture's label. |
| `CRAFTINGTABLE_DEV_API_TARGET` | `http://127.0.0.1:${CRAFTINGTABLE_PORT:-4601}` | The Vite dev server's API proxy target (`apps/web/vite.config.ts`; the e2e run sets it). |
| `CRAFTINGTABLE_MIGRATION_SNAPSHOT` | unset | A copied snapshot for the opt-in migration and resume tests; never a live database. |
| `CRAFTINGTABLE_REAL_CLAUDE` | unset | `1` runs the sandbox test against the installed Claude Code. |
| `CRAFTINGTABLE_REAL_PYPI` | unset | `1` runs the Python check test that installs from the real PyPI (`apps/server/test/server-execution-python-checks.test.ts`). |
| `CRAFTINGTABLE_TEST_NO_NETNS` | unset | `1` declares that the host refuses unprivileged network namespaces, so the instance-lock test that needs one skips there instead of failing. |
| `CRAFTINGTABLE_UPDATE_GOLDEN` | unset | `1` rewrites the planning format golden files. |
| `UPDATE_ROUTE_INVENTORY` | unset | `1` rewrites `docs/api-routes.md` (`pnpm routes:inventory`). |

### Set by the daemon

Not configuration: the daemon puts these in the environment of agents, launchers or checks.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_RUN_ID` | | The run's id, on every agent process; restart recovery reads it to prove a group was the run's. |
| `CRAFTINGTABLE_RUN_NAMESPACE` | | The run's id, for runs with launchers and in check units; nothing in CraftingTable reads it. |
| `CRAFTINGTABLE_DEPENDENCY_MANIFEST` | | The run's dependency manifest, in local CI jobs and native checks. |
| `CRAFTINGTABLE_CARGO_CONFIG` | | Cargo patches onto the exported dependency sources, likewise. |
| `CRAFTINGTABLE_VERIFICATION_MODE` | | Scoped checks or a current-upstream build, in local CI jobs. |
| `CRAFTINGTABLE_CI_ARTIFACTS_DIR` | | Where a local CI job keeps logs and artifacts. |
| `CARGO_HOME` | | `<data>/cargo-home` for agents; a fresh home per declared check; the operator's `~/.cargo` for native checks. |
| `CARGO_TARGET_DIR` | | The worktree's shared target for agents (else the run's `scratch/target`); the manifest's for launchers and checks. |
| `TMPDIR` | | The run's `scratch/` for its commands (with `TMP` and `TEMP`); a sandboxed Claude process gets its own short directory. |

### Retired

The daemon ignores these and names any that are set in a warning at start (`RETIRED_SETTINGS` in
`config.ts`): use `CRAFTINGTABLE_GIT_EXECUTABLE` and `CRAFTINGTABLE_GIT_COMMAND_TIMEOUT_MS`.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_ARTIFACT_ROOT` | | Removed repository inspector. |
| `CRAFTINGTABLE_GIT_BIN` | | Removed inspector's Git path. |
| `CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS` | | Removed. |
| `CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS` | | Removed. |
| `CRAFTINGTABLE_GIT_SEARCH_PATH` | | Removed. |
| `CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES` | | Removed. |
| `CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES` | | Removed. |
| `CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS` | | Removed. |
| `CRAFTINGTABLE_GIT_TIMEOUT_MS` | | Removed. |
| `CRAFTINGTABLE_MANAGED_WORKTREE_ROOT` | | Removed. |
| `CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS` | | Removed. |
