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
- **Plan branches.** Open **Projects → a plan → Repository & branches** to select a
  registered repository and an existing integration branch, or explicitly create one
  from another local branch. Settings apply to future worktrees for that plan version.
  Existing plans need no reimport; existing worktrees can adopt or retarget a branch
  explicitly without rewriting their starting history.
- **Worktrees.** Create a linked worktree on a fresh `ct/<item>-<id>` branch for a work
  item, and remove it when done. The primary checkout is never touched by an agent.
- **Agent runs.** Launch Claude Code or Codex in the worktree with a composed brief (the work
  item, its dependencies, the plan documents, your instructions). Choose a role
  (implement, review, design), a permission posture, and optionally a model. Runs
  record resolved models and billing information. Codex also records turn token usage;
  dollar usage is shown only when the account reports it.
- **Live supervision.** Every tool call, result, message, and turn is journaled and
  streamed to the browser into a feed you can filter and scroll without losing your
  place. The final outcome appears above activity, with the full recorded message available
  separately from raw events. Send follow-up messages, end the session, or cancel.
- **Diffs.** See commits, changed files, and the unified patch of the worktree against
  its base at any time.
- **Review-gated merge.** A review run ends with a verdict. When the latest run on a
  worktree is a review that returned `mergeable`, the daemon offers Merge into its
  recorded integration target: a merge commit, the worktree removed, the branch deleted, and
  the work item completed, in one step. The primary checkout is never disturbed; when
  it is not on the target the merge happens in a scratch worktree. Any later run closes
  the gate again.
- **Integration updates.** Each review records the item commit and integration commit.
  If either changes, merge approval expires. End sessions and pause the cycle, use
  **Update from integration**, then verify and review manually or resume the cycle for
  a fresh review. Updates use normal merges and abort on conflict. Item diffs exclude
  integration work already present in the item's ancestry. Parallel roadmap cycles automate
  that update and fresh review at safe step boundaries. Required predecessors must
  have integration commit evidence; plan settings can attach evidence to older manual
  completions without changing their completion history.
- **Integration conflict resolution.** An automated cycle with integration conflicts offers
  **Resolve integration conflicts**. Select an agent/model and instructions; the daemon
  prepares the pinned merge, the agent resolves and stages files and runs checks, and the
  daemon commits the update before a fresh review. Older failures use **Inspect integration
  conflicts** first. Pause to guide the agent from its run page; end its session before
  resuming. Failed attempts retain edits and allow up to three agent attempts. **Abandon
  resolution** aborts the pending merge and discards its resolution; unrelated edits may
  remain, and untracked files are preserved.
  Restart requires explicit resume. Stop preserves an owned resolution until it is resumed
  or abandoned. Final merge into integration remains your action.
- **Remediation and findings.** A review's findings can be handed straight to a new
  implement run in the same worktree. Handoffs include the recorded conversation across
  the run lineage, including earlier messages and operator corrections, plus the full
  recorded final messages. The inline preview allows 256 KiB; source files are not
  clipped to that preview. Known upstream truncation is flagged explicitly.
- **Automatic worktree housekeeping.** New runs get temporary space outside Git. Automated
  implementations checkpoint tracked edits and explicitly staged new source before review;
  unknown files go to bounded remediation for classification. Negative reviews hand off
  findings even when verification leaves artifacts. Dirty positive reviews require cleanup
  and a fresh review. Final merge remains your decision. Scratch files remain under each
  run's directory for inspection (they are not automatically pruned).
- **Background completion recovery.** If Claude exits while waiting for background work,
  the daemon holds the worktree until its process group finishes, bounded by the original
  step deadline. It then allows up to two same-step continuations to collect verification
  and finish reporting, without consuming remediation attempts or extending the deadline.
  Incomplete exits appear above the run outcome and cannot close findings or enable merge.
  Questions, exhausted recovery and restart still require operator action. Existing runs
  retain their recorded outcomes; this applies to newly launched runs.
- **Consolidated review reports.** Reviewers finish with a structured report containing
  stable finding IDs, severity, location, explanation, suggested fix, and reviewer-owned
  open/resolved/withdrawn status. The run page counts open findings and retains closed
  ones with their dispositions. Work-item reports retain prior IDs in their handoff
  lineage; finalization reports may omit findings already closed by a valid review. Invalid reports cannot supply a merge verdict; legacy unstructured reviews
  remain usable manually, with their conversation included in handoffs.
- **Automated work-item cycles.** On an admitted, unblocked item's page, create a
  worktree and open **Automated cycle → Set up a cycle**. Choose each step's agent,
  model, and permissions; the daemon runs design → implement → review → remediate,
  stopping for your merge approval. Design advances only with an explicit `none` in
  its final Open questions section. Completion requires zero open blocking, major,
  or minor findings, and a configurable nit allowance (default 3). Remediation rounds
  and step time are bounded; incomplete reports, failures, and stalled reviews pause
  for attention. Pause/resume supports manual intervention; stop returns the worktree
  to the manual flow. Cycle settings stay fixed after start. Workspace notices persist
  across reloads, and daemon restart requires explicit resume. Review and merge check
  the reviewed source and target commits. Standalone cycles stop for your merge approval;
  roadmaps can delegate integration merges explicitly.
- **Roadmaps.** Open **Roadmaps** to select and order imported work items,
  set each step's agent/model/permissions and completion policy, then save and explicitly
  start. The daemon admits eligible items, creates worktrees from their bound integration
  branches, and delegates existing automated cycles. Each completed integration merge releases
  the next eligible item. Dependencies outside the roadmap and existing unmerged worktrees remain
  visible blockers. Pause supports manual work and queued edits; immutable revisions
  retain started settings and execution history. Restart requires explicit roadmap resume.
  Sequential mode preserves strict order. Parallel mode uses order as priority, with bounded
  in-flight items, repository capacity, and per-entry exclusion groups. Items needing attention
  pause independently. Sibling merges trigger an idle worktree update and fresh review; conflicts
  and exhausted recovery budgets require attention. **Integration automation** separately controls
  automatic merges and agent conflict resolution, with manual defaults and per-item overrides.
  Started items retain the policy from their saved revision. Automatic merges retain the same
  clean-worktree, findings, fresh-review, and exact-commit gates. `main`, `master`, repository
  defaults, finalization destinations, and additional protected branches always require approval.
  Choose additional protections in the plan's **Repository & branches** settings.
- **Plan finalization.** Open **Projects → project → plan version → Finalize integration** after
  all plan items are integrated. Select the final destination, 0–10 improvement rounds,
  each round's assessment/verification and polish profiles, a separate final-review profile,
  completion limits, and focus instructions. Each round assesses whole-plan conformance,
  performs justified polish, then verifies it; a final independent review follows. Open
  questions, invalid results, and exhausted remediation budgets require attention. Answers
  can be supplied with **Resume finalization** and apply to that attempt; their recorded
  answers remain in the handoff. Finalization reports include every previously open finding
  with its current disposition, plus new or reopened findings. Unchanged closed findings
  stay in recorded history and a separate handoff archive, rather than being repeated in
  each report. Evidence summarizes current checks and references detailed records; it does
  not accumulate earlier reports. A rejected report's retry receives its validation errors
  and may reuse complete verification only against unchanged candidate/destination commits.
  When a valid review exhausts the remediation allowance, **Authorize more remediation**
  adds 1–20 attempts (default 1) and starts remediation followed by review. Review the
  remaining findings, allowance and optional guidance in that form. Used counts and
  original settings remain; the extra allowance survives restart and spans the whole
  finalization. Resume alone does not extend it. Questions and invalid reports must be
  resolved through their existing controls before additional remediation can be authorized.
  Pausing retains the integration hold; stopping
  releases it and retains the candidate for inspection or removal.
  Finalization works on a dedicated candidate branch from a pinned integration snapshot.
  Further daemon merges into that integration branch wait until finalization ends. Review
  the full candidate diff and run outcomes, then explicitly approve the exact candidate and
  destination commits. The polished candidate merges directly into the final destination;
  the source integration branch remains at its snapshot. External integration drift requires
  a new finalization. No round count or roadmap policy can approve final promotion.
- **Merge recovery.** Merge reservations survive interruptions between Git and database
  completion. Recovery checks the recorded commit and parents before recording completion,
  without repeating a completed merge. Cleanup follows completion; failed cleanup remains
  visible with **Retry worktree cleanup**, and later edits or commits are retained.
- **Design handoff.** A finished design run can be accepted with one click: the implement
  run that follows gets the proposal as its plan. Design runs end with their open
  questions so the operator sees what still needs a decision before accepting.
- **Agent profiles.** Workspace settings hold the agent, model, and permissions each run
  role starts with, so design and review can live on one agent and implementation on
  another. The launch form and every handoff pre-fill from the profile for the target
  role and let each launch override it. Every edge of the loop has a handoff button:
  Implement on a finished design, Review on a finished implementation, Remediate on a
  review with a verdict.
- **Phone supervision.** A compact navigation menu, larger touch controls, wrapping
  findings and branch names, and contained table/diff scrolling support checking
  cycles, steering runs, and explicitly approving merges from a phone browser.
  Work-item links preserve their destination through sign-in.
- **Workspaces and account.** Several workspaces per user, created and renamed from the
  browser; password change from the account page; dark theme by default with a light
  option.
- **Durability.** Runs, events, worktrees, and repositories live in SQLite. A daemon
  restart marks runs that were live as interrupted; nothing is lost.

Not yet: cross-project dependency maps, pinned upstream build environments,
email/SMS notifications, additional backends, or interactive permission prompts.

Pushover notifications are configured per workspace in **Settings**. Owners can save
write-only credentials, choose merge/attention alerts, send a test, and inspect delivery
status. Reminders persist across restarts: immediately, +30 minutes, +1 through +6 hours,
then daily at 21:00 in the configured timezone (default America/Los_Angeles).

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
configure the plan’s integration branch, create a worktree, launch an implement run, then a review run, then merge.

Forgotten password: run `pnpm craftingtable admin reset-password --username keith`
on the workstation as the daemon's OS user. It prompts for a new password twice,
preserves your data, and revokes existing login sessions. Use the daemon's data-directory
environment if you configured a custom location; the command prints the database path.

Upgrading from an earlier build: `pnpm db:migrate` applies schema 15 (the daemon also
migrates on start). Existing runs and their event journals are preserved.

`pnpm check` is the CI-equivalent local gate (format, lint, types, build, unit tests,
browser end-to-end tests with a scripted agent, and the forbidden-scope check).

## Storage and disk space

**Settings → Storage** shows the actual database, worktree, run-file and backup locations
with filesystem capacity. Scan for categorized usage and preview cleanup. An owner of every
active workspace can change future worktree/run placement and backup location without moving
existing work. The installation-wide settings persist in SQLite; environment worktree/run roots
seed the settings on first startup. Whole-data relocation is an offline operation.

Recognized Cargo caches are cleaned after merge and worktree removal. Other scratch expires
after 30 days by default, with an option to retain it. Unmerged, active and interrupted work stays
protected. Run messages, findings, plan files and database history remain. Daily consistent
SQLite backups retain seven snapshots by default; put them on another disk for drive-failure
protection. They do not back up source repositories or unmerged worktrees.

New runs and worktrees require the configured free-space reserve (5 GiB by default). Existing
notification preferences cover disk-pressure and maintenance alerts. This is a launch guard,
not a quota on a running agent. See [storage operations](docs/operations.md#storage-maintenance)
for cleanup limits, backup coverage, restore and migration.

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
