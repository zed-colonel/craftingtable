# CraftingTable

CraftingTable is a local supervisory workbench for planning, delegating, observing,
reviewing, and integrating software work performed by existing coding agents.

It runs as a daemon on your workstation. From a browser on any machine on your home
network you import a plan, pick a work item, register a repository, create a worktree,
launch Claude Code with the work item as its brief, watch it work live, steer it, and
read the resulting diff.

## What works today

- **Plans and work items.** Import an implementation plan plus work breakdown as a plan
  bundle; browse projects, plan versions, and work items with their dependencies.
- **Repositories.** Register any local Git checkout by path.
- **Worktrees.** Create a linked worktree on a fresh `ct/<item>-<id>` branch for a work
  item, and remove it when done. The primary checkout is never touched.
- **Agent runs.** Launch Claude Code in the worktree with a composed brief (the work
  item, its dependencies, the plan documents, your instructions). Choose a role
  (implement, review, design), a permission posture, and optionally a model.
- **Live supervision.** Every tool call, result, message, and turn is journaled and
  streamed to the browser. Send follow-up messages, end the session, or cancel.
- **Diffs.** See commits, changed files, and the unified patch of the worktree against
  its base at any time.
- **Durability.** Runs, events, worktrees, and repositories live in SQLite. A daemon
  restart marks runs that were live as interrupted; nothing is lost.

Not yet: automated design/implement/review cycles, merging from the UI, Codex or other
backends, interactive permission prompts. The run model (roles, lineage via
`parentRunId`, normalized events) is the seam those will plug into.

## Quickstart on the workstation

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)), Git 2.32+, and
[Claude Code](https://code.claude.com) installed and signed in (`claude` on PATH or
in `~/.local/bin`). Node 24 is downloaded by pnpm automatically.

```sh
pnpm install
pnpm db:migrate
pnpm craftingtable admin bootstrap --username keith   # prompts for a password
pnpm dev            # daemon on http://127.0.0.1:4600 + Vite UI on http://127.0.0.1:5173
```

Sign in at http://127.0.0.1:5173, import a plan (or use `fixtures/plan-bundles/aq-cont-1`
to try it), open **Repositories** and register a checkout, open a work item, create a
worktree, and launch a run.

`pnpm check` is the CI-equivalent local gate (format, lint, types, build, unit tests,
browser end-to-end tests with a scripted agent, and the forbidden-scope check).

## Using it from the couch

The daemon can serve the built browser app itself and listen on the LAN, but only over
TLS: the session cookie is marked `Secure`, and the daemon refuses to bind a
non-loopback address without a certificate or an HTTPS public origin fronted by a proxy.

The simplest setup is a self-signed certificate for the workstation's LAN name:

```sh
mkdir -p ~/.config/craftingtable
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=workstation.lan" -addext "subjectAltName=DNS:workstation.lan,IP:192.168.1.20" \
  -keyout ~/.config/craftingtable/key.pem -out ~/.config/craftingtable/cert.pem
```

Then build once and start the daemon with the LAN settings:

```sh
pnpm build
CRAFTINGTABLE_HOST=0.0.0.0 \
CRAFTINGTABLE_PORT=4600 \
CRAFTINGTABLE_PUBLIC_ORIGIN=https://workstation.lan:4600 \
CRAFTINGTABLE_TLS_CERT=$HOME/.config/craftingtable/cert.pem \
CRAFTINGTABLE_TLS_KEY=$HOME/.config/craftingtable/key.pem \
pnpm start
```

Trust the certificate on the laptop once (or accept the browser warning), then open
https://workstation.lan:4600. The public origin must match the URL you type exactly;
it is what the CSRF and origin checks compare against. A `systemd --user` unit with these
variables in an `EnvironmentFile` keeps it running; see
[`docs/operations.md`](docs/operations.md).

## Configuration

All settings are environment variables. Defaults suit the loopback dev setup.

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_HOST` | `127.0.0.1` | Listen address. Non-loopback requires TLS or an HTTPS origin. |
| `CRAFTINGTABLE_PORT` | `4600` | Listen port. |
| `CRAFTINGTABLE_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | The origin the browser uses; drives CSRF, origin policy, and cookie security. |
| `CRAFTINGTABLE_TLS_CERT`, `CRAFTINGTABLE_TLS_KEY` | unset | PEM files; set both to serve HTTPS directly. |
| `CRAFTINGTABLE_WEB_DIST` | `apps/web/dist` if built | Built browser app to serve from the daemon. |
| `CRAFTINGTABLE_DATA_DIR` | `~/.local/share/craftingtable` | SQLite database, worktrees, and run briefs live below this. |
| `CRAFTINGTABLE_WORKTREE_ROOT` | `<data>/worktrees` | Where linked worktrees are created. |
| `CRAFTINGTABLE_RUNS_ROOT` | `<data>/runs` | Per-run brief and plan documents handed to the agent. |
| `CRAFTINGTABLE_GIT_EXECUTABLE` | first `git` on PATH | Absolute path override. |
| `CRAFTINGTABLE_CLAUDE_EXECUTABLE` | first `claude` on PATH or `~/.local/bin` | Absolute path override. |
| `CRAFTINGTABLE_DIFF_LIMIT_BYTES` | 4 MiB | Ceiling on one diff response's patch text. |
| `CRAFTINGTABLE_SESSION_LIFETIME_SECONDS` | 30 days | Browser session lifetime. |
| `CRAFTINGTABLE_LOG_LEVEL` | `info` | pino level. |

The **Repositories** page shows which Git and Claude Code executables the daemon found.

## Where things are

- `apps/server` Fastify daemon: auth, workspaces, planning, execution services and routes.
- `apps/web` React browser app; a projection of the daemon's state, never the source of truth.
- `packages/domain` durable vocabulary; `packages/contracts` runtime-validated wire schemas;
  `packages/storage` SQLite and migrations; `packages/planning` plan-bundle parsing.
- `packages/git` Git operations (worktrees, diffs) behind a process-authority module.
- `packages/agents` the agent backend seam and the Claude Code adapter.
- `docs/` architecture, security, operations, and ADRs. `AGENTS.md` is the guidance for
  anyone (human or agent) changing this repository. `init/` is the original planning
  package, background only. `archive/` holds superseded process artifacts.

## Non-goals

CraftingTable is not a coding agent, an IDE, a general workflow engine, a hosted product,
a browser shell, or a replacement for Git or GitHub, and nothing here is a runtime
dependency of the projects it supervises.

> Do not finish CraftingTable before using CraftingTable.
