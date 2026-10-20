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
   into integration branches. Cross-project work comes in as a concurrency map, bound to exact
   plan versions and executed as scoped slices with independent verification and parent
   acceptance. [`docs/roadmaps.md`](docs/roadmaps.md) is the guide.
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

Prerequisites: pnpm 10 (see [`CONTRIBUTING.md`](CONTRIBUTING.md)), Git 2.43.0 or newer (the
daemon refuses to start below it), and [Claude Code](https://code.claude.com) installed and
signed in (`claude` on PATH or in `~/.local/bin`), or Codex installed and signed in as the
daemon's OS user (`codex login`). pnpm downloads the pinned Node 24 itself. Development
quickstart:

```sh
pnpm install
pnpm craftingtable:dev db migrate
pnpm craftingtable:dev admin bootstrap --username keith   # prompts for a password
pnpm dev            # daemon on http://127.0.0.1:4601 + Vite UI on http://127.0.0.1:5173
```

Sign in at http://127.0.0.1:5173. To try it, import `fixtures/plan-bundles/aq-cont-1`.
`pnpm dev` keeps its own state (`~/.local/share/craftingtable-dev`, port 4601), so it can
run beside the installed daemon; `pnpm craftingtable:dev` runs the CLI against that state.

The installed daemon runs from a deploy checkout, never from a development checkout:
`pnpm deploy:daemon <ref>` builds that commit into a release, drains the running daemon and
restarts the systemd user unit, and `--rollback` returns to the previous release. Reload open
pages after a deploy. The unit, deploys, backups, recovery and a forgotten password are in
[`docs/operations.md`](docs/operations.md).

`pnpm check` is the local gate: format, lint, types, build, unit tests, browser end-to-end
tests with scripted agents, and the forbidden-scope check. Set `CRAFTINGTABLE_TEST_DATA_ROOT`
to a directory of its own on a disk, beside the daemon's data directory and never inside it,
for the test daemons' data; without it they use `$XDG_RUNTIME_DIR` (tmpfs), where a confined
check cannot see their worktrees, and that test fails.

## Using it from the couch

The session cookie is `Secure` on an HTTPS origin, and the daemon refuses to listen on a
non-loopback address without TLS or an HTTPS public origin fronted by a proxy. The
recommended route is a Tailscale tailnet: the daemon stays on loopback and `tailscale serve`
terminates TLS with a real certificate, with nothing opened on the LAN. Serving the LAN
directly needs a certificate of the daemon's own. Both are in
[`docs/operations.md`](docs/operations.md#reaching-the-daemon-from-another-machine). Either
way, the public origin must match the URL the browser shows exactly, on the workstation too.

## Configuration

Settings are environment variables; defaults suit the loopback development setup. The ones an
operator usually sets:

| Variable | Default | Meaning |
|---|---|---|
| `CRAFTINGTABLE_HOST`, `CRAFTINGTABLE_PORT` | `127.0.0.1`, `4600` | Listen address and port. |
| `CRAFTINGTABLE_PUBLIC_ORIGIN` | `http://127.0.0.1:5173` | The origin the browser uses; drives CSRF, origin checks and cookie security. |
| `CRAFTINGTABLE_TLS_CERT`, `CRAFTINGTABLE_TLS_KEY` | unset | Absolute PEM paths; set both to serve HTTPS directly. |
| `CRAFTINGTABLE_DATA_DIR` | `$XDG_DATA_HOME/craftingtable` or `~/.local/share/craftingtable` | Database, backups and default roots. |
| `CRAFTINGTABLE_REPOSITORY_ROOTS` | unset | Absolute directories, colon-separated, that repositories may be registered under; unset refuses every registration. |

Every variable, with its default and bounds, is in
[`docs/operations.md`](docs/operations.md#environment-variables).

## Where things are

- `apps/server` Fastify daemon: auth, workspaces, planning, execution services and routes.
- `apps/web` React browser app; a projection of the daemon's state, never the source of truth.
- `packages/domain` durable vocabulary; `packages/contracts` runtime-validated wire schemas;
  `packages/storage` SQLite and migrations; `packages/planning` plan and map parsing.
- `packages/git` Git operations; `packages/agents` the agent backend seam, process
  supervision, the Claude Code and Codex adapters, and the Cargo, local-check and native adapters.
- `scripts/` deploy, scope and docs checks, replays, local CI and Kata setup; `fixtures/`
  sample plans and records.
- `init/` the original planning package (background only); `archive/` superseded artifacts.

## Documentation

- [`AGENTS.md`](AGENTS.md): how to change this repository (humans and agents).
- [`docs/architecture.md`](docs/architecture.md): components, records and authority boundaries.
- [`docs/security.md`](docs/security.md): the trust boundaries and who holds which authority.
- [`docs/operations.md`](docs/operations.md): installing, deploying, backups, recovery, remote
  access and every environment variable.
- [`docs/roadmaps.md`](docs/roadmaps.md): running roadmaps and cross-project maps.
- [`docs/ui/`](docs/ui/README.md): the browser app's visual language, information
  architecture, glossary and pages.
- [`docs/decisions/`](docs/decisions/README.md): architecture decision records and their index.
- [`docs/api-routes.md`](docs/api-routes.md): the generated route inventory.
- [`docs/review/2026-09-system-review/`](docs/review/2026-09-system-review/): the September 2026
  system review and its remediation register.

## Non-goals

CraftingTable is not a coding agent, an IDE, a general workflow engine, a hosted product,
a browser shell, or a replacement for Git or GitHub, and nothing here is a runtime
dependency of the projects it supervises.

> Do not finish CraftingTable before using CraftingTable.

## License

CraftingTable is released under the [MIT License](LICENSE).
