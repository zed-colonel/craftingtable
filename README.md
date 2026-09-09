# CraftingTable

CraftingTable is a local supervisory workbench for planning, delegating, observing,
reviewing, and integrating software work performed by existing coding agents.

It runs as a daemon on your workstation. From a browser on any machine on your home
network you import a plan, admit a work item into your agenda, register a repository,
create a worktree, launch Claude Code or Codex with the work item as its brief, watch it work
live, steer it, have a second run review the branch, and merge it when the review says
it is mergeable.

## What works today

- **Plans and work items.** Import an implementation plan plus work breakdown as a plan
  bundle; browse projects, plan versions, and work items with their dependencies. Items
  move `Proposed → In agenda → Completed`; completing one unblocks its dependents.
- **Repositories.** Register any local Git checkout by path.
- **Worktrees.** Create a linked worktree on a fresh `ct/<item>-<id>` branch for a work
  item, and remove it when done. The primary checkout is never touched by an agent.
- **Agent runs.** Launch Claude Code or Codex in the worktree with a composed brief (the work
  item, its dependencies, the plan documents, your instructions). Choose a role
  (implement, review, design), a permission posture, and optionally a model. Runs
  record resolved models and billing information. Codex also records turn token usage;
  dollar usage is shown only when the account reports it.
- **Live supervision.** Every tool call, result, message, and turn is journaled and
  streamed to the browser into a feed you can filter and scroll without losing your
  place. Send follow-up messages, end the session, or cancel.
- **Diffs.** See commits, changed files, and the unified patch of the worktree against
  its base at any time.
- **Review-gated merge.** A review run ends with a verdict. When the latest run on a
  worktree is a review that returned `mergeable`, the daemon offers Merge into a branch
  you choose (the default branch, another existing branch, or a new one created from
  the default branch): a merge commit, the worktree removed, the branch deleted, and
  the work item completed, in one step. The primary checkout is never disturbed; when
  it is not on the target the merge happens in a scratch worktree. Any later run closes
  the gate again.
- **Remediation.** A review's findings can be handed straight to a new implement run
  in the same worktree; its brief reproduces the findings and asks for a disposition on
  each.
- **Design handoff.** A finished design run can be accepted with one click: the implement
  run that follows gets the proposal as its plan. Design runs end with their open
  questions so the operator sees what still needs a decision before accepting.
- **Workspaces and account.** Several workspaces per user, created and renamed from the
  browser; password change from the account page; dark theme by default with a light
  option.
- **Durability.** Runs, events, worktrees, and repositories live in SQLite. A daemon
  restart marks runs that were live as interrupted; nothing is lost.

Not yet: automated implement → review → merge cycles (every step exists as a command,
the orchestrator does not), additional backends, interactive permission prompts.

## Quickstart on the workstation

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)), Git 2.32+, and
[Claude Code](https://code.claude.com) installed and signed in (`claude` on PATH or
in `~/.local/bin`), or Codex installed and signed in (`codex login`). Node 24 is
downloaded by pnpm automatically.

```sh
pnpm install
pnpm db:migrate
pnpm craftingtable admin bootstrap --username keith   # prompts for a password
pnpm dev            # daemon on http://127.0.0.1:4600 + Vite UI on http://127.0.0.1:5173
```

Sign in at http://127.0.0.1:5173, import a plan (or use `fixtures/plan-bundles/aq-cont-1`
to try it), open **Repositories** and register a checkout, open a work item, admit it,
create a worktree, launch an implement run, then a review run, then merge.

Forgotten password: run `pnpm craftingtable admin reset-password --username keith`
on the workstation as the daemon's OS user. It prompts for a new password twice,
preserves your data, and revokes existing login sessions. Use the daemon's data-directory
environment if you configured a custom location; the command prints the database path.

Upgrading from an earlier build: `pnpm db:migrate` applies schema 7 (the daemon also
migrates on start). Existing runs and their event journals are preserved.

`pnpm check` is the CI-equivalent local gate (format, lint, types, build, unit tests,
browser end-to-end tests with a scripted agent, and the forbidden-scope check).

## Using it from the couch

The daemon can serve the built browser app itself and listen on the LAN, but only over
TLS: the session cookie is marked `Secure`, and the daemon refuses to bind a
non-loopback address without a certificate or an HTTPS public origin fronted by a proxy.

If the laptop and the workstation are already on a Tailscale tailnet, the easiest route
is to leave the daemon on loopback and let `tailscale serve` terminate TLS in front of
it: a real certificate, nothing opened on the LAN interface, and reachable from a phone
later. That setup is in [`docs/operations.md`](docs/operations.md); the rest of this
section is the direct-LAN alternative.

Serving the LAN directly needs a certificate of your own, and the simplest is a
self-signed one for the workstation's LAN name:

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
| `CRAFTINGTABLE_CODEX_EXECUTABLE` | first `codex` on PATH or `~/.local/bin` | Absolute path override. |
| `CRAFTINGTABLE_CODEX_MODELS` | built-in Codex model list | `id=Label,id=Label` entries for the model picker. |
| `CRAFTINGTABLE_CLAUDE_MODELS` | built-in list (`opus`, `sonnet`, `haiku` aliases plus current ids) | `id=Label,id=Label` entries for the launch form's model picker. |
| `CRAFTINGTABLE_DIFF_LIMIT_BYTES` | 4 MiB | Ceiling on one diff response's patch text. |
| `CRAFTINGTABLE_SESSION_LIFETIME_SECONDS` | 30 days | Browser session lifetime. |
| `CRAFTINGTABLE_LOG_LEVEL` | `info` | pino level. |

The **Repositories** page shows which Git, Claude Code, and Codex executables the daemon found.

Codex uses its documented app-server integration over local stdio (verified with CLI
0.153.4). Sign in as the daemon's OS user with `codex login`; subscription login works.
Auto uses the workspace-write sandbox with Codex automatic approval review. Edit-only
denies requests to expand access; Unrestricted disables the sandbox and approval checks.
Follow-ups steer an active turn or start another turn in the same thread. End session
finishes accepted input; Cancel interrupts and terminates the process group. Codex does
not enforce dollar budget caps. Dollar estimates may be unavailable on subscription
accounts; missing costs appear as `—`, never as zero.

## Where things are

- `apps/server` Fastify daemon: auth, workspaces, planning, execution services and routes.
- `apps/web` React browser app; a projection of the daemon's state, never the source of truth.
- `packages/domain` durable vocabulary; `packages/contracts` runtime-validated wire schemas;
  `packages/storage` SQLite and migrations; `packages/planning` plan-bundle parsing.
- `packages/git` Git operations (worktrees, diffs) behind a process-authority module.
- `packages/agents` the agent backend seam, shared process supervision, and Claude Code and Codex adapters.
- `docs/` architecture, security, operations, and ADRs. `AGENTS.md` is the guidance for
  anyone (human or agent) changing this repository. `init/` is the original planning
  package, background only. `archive/` holds superseded process artifacts.

## Non-goals

CraftingTable is not a coding agent, an IDE, a general workflow engine, a hosted product,
a browser shell, or a replacement for Git or GitHub, and nothing here is a runtime
dependency of the projects it supervises.

> Do not finish CraftingTable before using CraftingTable.
