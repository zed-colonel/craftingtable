# CraftingTable

CraftingTable is a local supervisory workbench for planning, delegating, observing,
reviewing, and integrating software work performed by existing coding agents.

It runs as a daemon on your workstation. From a browser on any machine on your home
network you import a plan, admit its work items, and have Claude Code or Codex work on
them in isolated Git worktrees while you watch live, steer, and decide. A separate review
run judges each branch; the daemon merges only on a current `mergeable` review, and final
promotion into a protected branch always waits for your explicit approval.

## The main workflow

1. **Import a plan.** **Import plan** takes a plan bundle (an implementation plan plus a
   work breakdown) or a ZIP package and creates an immutable plan version.
2. **Register a repository and set the plan's integration branch.** **Repositories**
   registers a local Git checkout by path; **Projects → plan → Repository & branches**
   selects the repository and the integration branch that work items merge into.
3. **Admit a work item** into the agenda (**Admit into agenda** on the work item's page).
4. **Run the work.** Either set up an **Automated cycle** (design → implement → review →
   remediate, each step with its own agent, model and permissions) or create a worktree
   and launch implement and review runs by hand. Every run is journaled and streamed live.
5. **Merge through the review gate.** When the latest run on a worktree is a finished review
   with a `mergeable` verdict for the current source and target commits, **Merge into**
   merges it into the integration branch and completes the item. Any later run closes the gate.
6. **Scale up with roadmaps.** **Roadmaps** order work items and delegate their cycles
   sequentially or in parallel under capacity limits; a roadmap may also be allowed to merge
   into integration branches. Cross-project work comes in as a concurrency map (**Roadmaps →
   Import concurrency map**), bound to exact plan versions and executed as scoped slices with
   independent verification and parent acceptance.
7. **Finalize and promote.** Once every item in a plan version is completed, **Finalize
   integration** runs staged reviews (correctness, conformance, simplification, polish,
   final independent review) on a candidate branch. You approve the exact candidate and
   destination commits (**Approve final promotion**); no roadmap policy can do that for you.

Every stop that needs you (questions, decisions, merges, service failures, held roadmap items,
checkpoints to accept, setup) is an item in **Needs you**, most blocking first. Each item's page
hosts the controls that resolve it. The dashboard, the rail count, a strip on every other page
and the roadmap page read the same items, and optional Pushover alerts (configured per workspace
under **Settings**) open them.

## Running it

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)), Git, and
[Claude Code](https://code.claude.com) installed and signed in (`claude` on PATH or in
`~/.local/bin`), or Codex installed and signed in as the daemon's OS user (`codex login`).
pnpm downloads the pinned Node 24 automatically. Development quickstart:

```sh
pnpm install
pnpm craftingtable:dev db migrate
pnpm craftingtable:dev admin bootstrap --username keith   # prompts for a password
pnpm dev            # daemon on http://127.0.0.1:4601 + Vite UI on http://127.0.0.1:5173
```

Sign in at http://127.0.0.1:5173. To try it, import `fixtures/plan-bundles/aq-cont-1`.
`pnpm dev` keeps its own state (`~/.local/share/craftingtable-dev`, port 4601), so it can
run beside the installed daemon; `pnpm craftingtable:dev` runs the CLI against that state.

The installed daemon runs from a deploy checkout, never from a development checkout.
`pnpm deploy:daemon <ref>` builds that commit into a release, asks the running daemon to
drain, and restarts the systemd user unit; `pnpm deploy:daemon --rollback` returns to the
previous release. A drained restart resumes interrupted steps and running roadmaps on its
own; after a crash they wait for an explicit resume. The daemon migrates its database on
start, and only one daemon can use a data directory at a time. Unit setup, backups and
recovery are in [`docs/operations.md`](docs/operations.md).

Forgotten password: run `pnpm craftingtable admin reset-password --username keith` on the
workstation as the daemon's OS user (with the daemon's data-directory environment, if you
set one). It prompts twice, prints the database path, keeps your data, and revokes existing
login sessions.

`pnpm check` is the local gate: format, lint, types, build, unit tests, browser end-to-end
tests with scripted agents, and the forbidden-scope check. Test daemons keep their data in
`CRAFTINGTABLE_TEST_DATA_ROOT`, set in your environment to a directory of its own on a disk,
beside the daemon's data directory and never inside it, so a confined check can see their
worktrees. Without it they use `$XDG_RUNTIME_DIR` (tmpfs), where it cannot, and the test
that shows a confined check reaching an e2e worktree fails.

## Using it from the couch

The session cookie is `Secure` on an HTTPS origin, and the daemon refuses to listen on a
non-loopback address without TLS or an HTTPS public origin fronted by a proxy.

The recommended route is a Tailscale tailnet: leave the daemon on loopback and let
`tailscale serve` terminate TLS with a real certificate, with nothing opened on the LAN.
The steps are in [`docs/operations.md`](docs/operations.md#reaching-the-daemon-from-another-machine).

To serve the LAN directly instead, give the daemon a certificate of its own, for example a
self-signed one for the workstation's LAN name, then build once and start it with TLS:

```sh
mkdir -p ~/.config/craftingtable
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=workstation.lan" -addext "subjectAltName=DNS:workstation.lan,IP:192.168.1.20" \
  -keyout ~/.config/craftingtable/key.pem -out ~/.config/craftingtable/cert.pem
pnpm build
CRAFTINGTABLE_HOST=0.0.0.0 CRAFTINGTABLE_PORT=4600 \
CRAFTINGTABLE_PUBLIC_ORIGIN=https://workstation.lan:4600 \
CRAFTINGTABLE_TLS_CERT=$HOME/.config/craftingtable/cert.pem \
CRAFTINGTABLE_TLS_KEY=$HOME/.config/craftingtable/key.pem \
pnpm start
```

Either way, the public origin must match the URL the browser shows exactly: the CSRF and
origin checks compare against it, so use that address on the workstation too.

## Configuration

Settings are environment variables; defaults suit the loopback development setup. The
variables an operator usually sets:

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_HOST`, `CRAFTINGTABLE_PORT` | `127.0.0.1`, `4600` | Listen address and port. |
| `CRAFTINGTABLE_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | The origin the browser uses; drives CSRF, origin checks and cookie security. |
| `CRAFTINGTABLE_TLS_CERT`, `CRAFTINGTABLE_TLS_KEY` | unset | Absolute PEM paths; set both to serve HTTPS directly. |
| `CRAFTINGTABLE_DATA_DIR` | `$XDG_DATA_HOME/craftingtable` or `~/.local/share/craftingtable` | Database (`state/craftingtable.sqlite`), backups and default roots. |
| `CRAFTINGTABLE_SESSION_IDLE_SECONDS` | `86400` | A session with no request for this long ends (at least 600, at most the session lifetime). |
| `CRAFTINGTABLE_WORKTREE_ROOT`, `CRAFTINGTABLE_RUNS_ROOT` | `<data>/worktrees`, `<data>/runs` | Seed the storage settings on first start; afterwards **Settings** owns them. |
| `CRAFTINGTABLE_CLAUDE_EXECUTABLE`, `CRAFTINGTABLE_CODEX_EXECUTABLE`, `CRAFTINGTABLE_GIT_EXECUTABLE` | found on PATH (agents also in `~/.local/bin`) | Absolute path overrides. |
| `CRAFTINGTABLE_DEVELOPMENT_CAPACITY`, `CRAFTINGTABLE_VERIFICATION_CAPACITY` | `2`, `1` | Workstation slots until saved under **Settings → Execution capacity**. |
| `CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS` | `180` | How long a stop waits for live agent turns before interrupting them. |
| `CRAFTINGTABLE_TEST_DATA_ROOT` | unset (`$XDG_RUNTIME_DIR`) | Tests only: where test daemons keep their data. A disk directory of its own, beside the data directory, never inside it; read from the test process's environment, not the daemon's unit. |

Daemon settings, with bounds, are in [`apps/server/src/config.ts`](apps/server/src/config.ts);
deploy settings in [`scripts/deploy-daemon.mjs`](scripts/deploy-daemon.mjs); local CI and Kata settings in
[`scripts/local-ci/README.md`](scripts/local-ci/README.md) and [`scripts/kata/README.md`](scripts/kata/README.md).

## Where things are

- `apps/server` Fastify daemon: auth, workspaces, planning, execution services and routes.
- `apps/web` React browser app; a projection of the daemon's state, never the source of truth.
- `packages/domain` durable vocabulary; `packages/contracts` runtime-validated wire schemas;
  `packages/storage` SQLite and migrations; `packages/planning` plan and map parsing.
- `packages/git` Git operations; `packages/agents` the agent backend seam, process
  supervision, the Claude Code and Codex adapters, and the Cargo, local-check and native adapters.
- `scripts/` deploy, scope check, local CI and Kata setup; `fixtures/` sample plans and records.
- `init/` the original planning package (background only); `archive/` superseded artifacts.

## Documentation

- [`AGENTS.md`](AGENTS.md): how to change this repository (humans and agents).
- [`docs/architecture.md`](docs/architecture.md): components, records and authority boundaries.
- [`docs/security.md`](docs/security.md): the trust model.
- [`docs/operations.md`](docs/operations.md): installing, deploying, backups, recovery, remote access.
- [`docs/ui-principles.md`](docs/ui-principles.md): the browser app's visual language and page anatomy.
- [`docs/decisions/`](docs/decisions/): architecture decision records.
- [`docs/review/2026-09-system-review/`](docs/review/2026-09-system-review/): the September 2026
  system review and its remediation register.

## Non-goals

CraftingTable is not a coding agent, an IDE, a general workflow engine, a hosted product,
a browser shell, or a replacement for Git or GitHub, and nothing here is a runtime
dependency of the projects it supervises.

> Do not finish CraftingTable before using CraftingTable.
