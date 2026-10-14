# Security model

CraftingTable is a single-operator tool on a home network. It keeps authentication, CSRF and
origin checks, and agent containment in force anyway, because a signed-in browser can make the
daemon start a coding agent with write access to the operator's repositories.

Who is trusted:

- **Trusted:** the operator, and the operating-system account the daemon runs as. A process with
  that account's full authority can read everything the daemon can.
- **Semi-trusted:** the coding agents. They act on the operator's behalf, but repository contents,
  plans and tool output can mislead them, so what they can reach is bounded by the posture the
  operator chose, and nothing an agent writes widens its own authority.
- **Untrusted:** other hosts on the network, plan bundles, ZIP packages and maps, agent output and
  review reports, Git output, and repository contents.

The daemon is the only authority over workflow state. The browser is a projection: it submits
typed commands, never commands to run.

## Trust boundaries

| Boundary | Enforced by | Only cooperative | Covering tests |
|---|---|---|---|
| Network listener | A non-loopback listener is refused without TLS or an HTTPS public origin; a `Host` check; security headers on every answer | TLS termination by a proxy (`tailscale serve`) is outside the daemon | `apps/server/test/config.test.ts`, `apps/server/test/routes/browser-security.test.ts` |
| Browser session | Argon2id passwords, a `__Host-` session cookie on HTTPS, digest-only session tokens, idle and absolute session ends, sign-in throttling, session-bound CSRF token and exact origin | — | `apps/server/test/server-auth.test.ts`, `apps/server/test/server-auth-hardening.test.ts`, `apps/server/test/security/*.test.ts` |
| Route authority | Every route's declared access, checked before its body is read; step-up for the commands that grant the most; one body schema per command | Services repeat their own role checks as a second line | `apps/server/test/route-access.test.ts`, `apps/server/test/route-inventory.test.ts`, `apps/server/test/server-auth-hardening.test.ts` (step-up) |
| Browser input | Typed commands only; repository registration under configured roots; cleanup by daemon-held preview | — | `apps/server/test/server-execution-runs.test.ts`, `apps/server/test/storage-management.test.ts` |
| Process authority | Only listed modules may spawn; argument arrays; supervised process groups; named environment variables only for agents, checks and daemon Git (not the native probes); process records proved before a restart signals | The brief's instruction to stay in the worktree | `scripts/check-forbidden-scope.test.mjs`, `packages/agents/test/process.test.ts`, `apps/server/test/restart-reaping.test.ts` |
| Agent sandboxes | Claude Code's OS sandbox for commands; Codex's per-run permission profiles; one denied-reads list for commands, Claude's file tools and read-only runs; outside sources as the only network and cache writes | Claude Code's own tools are governed by its permission posture, not the sandbox; `unrestricted` has no sandbox | `packages/agents/test/claude-code/arguments.test.ts`, `packages/agents/test/codex/arguments.test.ts`, `packages/agents/test/codex/denied-files.test.ts`, `packages/agents/test/outside-sources.test.ts` |
| The daemon's own Git | Git directories named explicitly; no hooks, fsmonitor, system or global configuration; untrusted Git directories refused | A repository's own configuration still applies; the ref watch detects moves, it does not prevent them | `packages/git/test/git-directory-pinning.test.ts`, `packages/git/test/adapter-robustness.test.ts`, `apps/server/test/services/ref-watch.test.ts` |
| Checks and builds | Checks run by the daemon in confined, capped units, on private clones, with offline Cargo homes and a root-owned Python toolchain; checks adopted only by a person | Local CI's Docker; the native unit's file system; the tree's own build scripts | `packages/agents/test/local-check.test.ts`, `packages/agents/test/check-spool.test.ts`, `packages/agents/test/toolchains.test.ts`, `packages/agents/test/python-checks.test.ts`, `apps/server/test/server-execution-check-only.test.ts`, `apps/server/test/server-execution-check-adoption.test.ts`, `apps/server/test/server-execution-toolchains.test.ts` |
| Merge and promotion | The review gate at exact commits; protected destinations; final promotion only by an operator's session, with step-up | A review's verdict is the reviewer's assertion | `apps/server/test/server-execution-merge-gate.test.ts`, `apps/server/test/server-execution-integration.test.ts`, `apps/server/test/server-execution-finalization.test.ts` |
| Delegated work | Authority from a recorded, rechecked owner or editor; pause and stop are commands | — | `apps/server/test/server-execution-roadmaps.test.ts`, `apps/server/test/server-execution-decision-preparation.test.ts` |
| Untrusted input | Bounded parsers; ZIPs read in memory, never extracted; text rendered as text; reports validated | A valid report is still an assertion | `packages/planning/test/archive.test.ts`, `apps/server/test/server-package-imports.test.ts`, `apps/server/test/services/review-report.test.ts` |
| Stored secrets | Credentials file outside the database, mode 0600; database and copies 0600; denied to sandboxed agents | The OS account's own trust | `apps/server/test/security/credential-file.test.ts`, `apps/server/test/notifications.test.ts` |
| Outbound requests | Fixed HTTPS endpoints, no redirects, timeouts and size bounds | — | `apps/server/test/services/notification-transport.test.ts`, `apps/server/test/services/crate-checksums.test.ts`, `apps/server/test/services/pypi-wheels.test.ts` |
| Installation storage | Installation access; validated, pinned roots; deletion only of what the daemon previewed | Concurrent host file-system changes | `apps/server/test/storage-management.test.ts` |

## Network and the browser origin

- The daemon listens on loopback by default. A non-loopback `CRAFTINGTABLE_HOST` is refused at
  start unless TLS is configured (`CRAFTINGTABLE_TLS_CERT` and `CRAFTINGTABLE_TLS_KEY`, both
  absolute) or the public origin is HTTPS, served by a TLS proxy. See
  [Reaching the daemon from another machine](operations.md#reaching-the-daemon-from-another-machine).
- Every request whose `Host` names neither the public origin's host, a loopback name, nor the
  address the daemon listens on (unless that is a wildcard) is refused with 421 before any route
  runs, so a page that points its own name at this address (DNS rebinding) reaches nothing.
- Every answer, event streams included, carries a content security policy (the app's own
  scripts, styles, fonts and requests, `data:` images, no plugins, no base, no framing),
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
  and `Cross-Origin-Opener-Policy: same-origin`. A route that sets one itself keeps its own:
  imported plan files (`text/plain`), archives (`application/octet-stream`) and build records
  (`application/json`) are served as attachments under `default-src 'none'; sandbox`.
- The daemon can serve the built browser app, so one origin carries the app and the API.

## Authentication and sessions

- There is no registration route: the first account comes from `admin bootstrap`, an interactive
  command that refuses a password on its command line. Passwords are 12 to 1024 UTF-8 bytes,
  whether set in the browser or by `admin bootstrap` and `admin reset-password` (the hasher
  refuses any other length), and are stored as Argon2id hashes. Session tokens are 32 random
  bytes, kept only as SHA-256 digests, and each session has its own CSRF token. The session
  cookie is `HttpOnly` and `SameSite=Strict` with `Path=/` and no `Domain`. On an HTTPS public
  origin it is also `Secure` and carries the `__Host-` prefix (`__Host-craftingtable_session`), so
  a browser accepts it only from this host over HTTPS and neither a sibling host nor a plain-HTTP
  page can set or shadow it. Cookies are scoped by host, not port: another HTTPS service on the
  same host (another `tailscale serve` port) still can. An HTTP origin (loopback development)
  keeps the plain name, which a browser would refuse with the prefix. The daemon reads the cookie only under its origin's name.
- A session ends after its lifetime (30 days by default, `CRAFTINGTABLE_SESSION_LIFETIME_SECONDS`)
  or after 24 hours with no request (`CRAFTINGTABLE_SESSION_IDLE_SECONDS`). Event streams check
  the session on every iteration without counting as use; a tab left hidden reads nothing, so it
  is signed out after the idle span.
- Sign-in is throttled per username and per client address: five failures within 15 minutes lock
  that key for 15 minutes (429, reason `login-rate-limited`, with `Retry-After`). An attempt
  counts from the moment it arrives, before its password is checked, so attempts sent at once get
  at most five checks; a success takes its own count back. Behind `tailscale serve` the address is
  the last one the loopback proxy names in `X-Forwarded-For`; any local process could set it, so
  the username's count is the one that holds. One audit row stands for a username's window of
  failures and one for each lock. At most two password checks run at once and 32 wait; more are
  refused. The counts are held in memory, at most 10,000 keys, and a key still counting is never
  dropped to make room.
- A password change needs the current password and revokes every other session. A forgotten
  password is reset with `admin reset-password`, an interactive local command whose authority is
  the account's access to the database; it revokes the user's sessions in the same transaction,
  and there is no web reset ([Forgotten password](operations.md#forgotten-password)). Sign-in
  and a password change check the credentials again after hashing, so a request in flight cannot
  restore access with a password that was just reset.
- Request logs redact cookies, `Authorization` and `Set-Cookie`; audit records carry no request
  bodies, passwords or tokens. See [ADR-009](decisions/ADR-009-authentication-sessions-and-csrf.md).

## Route access and step-up

Every API route declares who may call it where it is registered (`config.access`,
`apps/server/src/routes/route-access.ts`): `public` (health and sign-in only), `session` (any
signed-in user, outside a workspace), the least workspace role (`member`, `editor`, `owner`) for
routes under `/api/workspaces/:workspaceId/`, or `installation` (host-level settings, for an owner
of every active workspace). Every command also declares its tag (`decision`, `control` or
`config`) and its body schema. The daemon refuses to start when a route has no access, a workspace
mutation admits viewers, a mutation other than sign-in is public, or a command lacks its tag or
body schema. [`api-routes.md`](api-routes.md) is generated from this table.

One guard runs before the body is read, so an outsider learns nothing from parse or validation
errors:

- no session: 401;
- a command without the session's CSRF header (`x-craftingtable-csrf`), or from an origin other
  than the public origin, or with `Sec-Fetch-Site: cross-site`: 403;
- a non-member: 404, recorded as a denied access;
- a member below the declared role, or `installation` for someone who does not own every active
  workspace: 403.

Sign-in, the one public command, checks the origin and the JSON media type before its body is
read. The guard attaches the signed-in caller to the request; handlers read it with `contextOf`
and never authenticate again. Services keep their own role checks.

Once the body is parsed, and before it is validated against the route's schema, these commands
need **step-up**, the operator's password again within the last 10 minutes
(`POST /api/auth/step-up`):

- any command whose body sets `permissionMode: 'unrestricted'` anywhere, or `unrestricted` in a
  `permissions` record (a launch, a cycle start, saved profiles, roadmap entries and settings
  levels, finalization overrides);
- a control that starts or resumes agent work (anything but pause, stop or abandon) on a
  roadmap, cycle or finalization whose stored settings grant `unrestricted` anywhere;
- a final promotion: a finalization's `merge`, or a worktree merge into its repository's default
  branch;
- winding a roadmap down when it retires a plan version, and every cleanup of a wound-down
  roadmap's repositories, which only an owner may run
  ([ADR-073](decisions/ADR-073-winding-down-a-roadmap.md)).

Without it the command answers 403 with reason `step-up-required`; the browser asks for the
password once for every command waiting, steps the session up and sends each again, and declining
leaves the refusals. A wrong password answers 403 with `step-up-failed` and counts toward the
username's sign-in lock. Step-up is held per session in the daemon's memory, so a restart or a
sign-out ends it. Work that later runs on its own under settings granted that way does not ask
again.

## What the browser can submit

The browser never submits a shell command, an argument vector or an executable path. What it
submits is typed, validated by the route's schema, and resolved by the daemon:

- a repository path to register. It must lie under `CRAFTINGTABLE_REPOSITORY_ROOTS` (absolute,
  colon-separated; unset refuses every registration): the path, links resolved, is checked before
  Git reads it, Git is given the resolved path, and the top level Git reports is checked again.
  Registered repositories keep working when the roots change.
- a work item and repository for a worktree; the daemon derives the branch name and the path
  under its worktree root;
- a role, a permission posture, an optional model and effort, and free text that becomes the
  brief or a message to the agent;
- branch settings, a starting branch, or a worktree to adopt, retarget or update. Branch names
  are validated and reach Git in argument arrays; no rebase or force-push is exposed.
- a ref and expected commit when adopting a repository's checks: the commands come from the
  repository's `.craftingtable/checks.json` at that commit, not from the browser (see
  [Checks and builds](#checks-and-builds));
- storage locations, as an installation owner; cleanup names only a daemon-held preview by id,
  never a path (see [Installation storage](#installation-storage)).

## Agent processes

- Only the modules named in `PROCESS_AUTHORITY` (`scripts/check-forbidden-scope.mjs`) may spawn
  a process, each with its reason: agent supervision (`packages/agents/src/process.ts`), the Git
  runner (`packages/git/src/runner.ts`), local checks, pinned Cargo and the native environment.
  `pnpm check:scope` fails any other production module that imports a process capability.
- Every spawn uses an argument array with `shell: false`. Agent sessions and daemon Git commands
  run in a process group of their own, ended as a group (SIGTERM, then SIGKILL after a grace
  period), with bounded output.
- An agent starts from named variables of the daemon's environment only: `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `PATH`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `TZ`, the four `XDG_*_HOME`
  directories, proxy and CA variables, its vendor's own login variables (`ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`; `OPENAI_API_KEY`, `CODEX_API_KEY`,
  `CODEX_HOME`), names the operator adds with `CRAFTINGTABLE_AGENT_ENV_ALLOW`, and the run's own
  overlay. Desktop session variables, `XDG_RUNTIME_DIR` and SSH agents are not passed.
- Each run gets a short private directory, `<agents' root>/<12 hex>` (`<data>/t` by default),
  mode 0700, which a sandboxed Claude process uses as its own `TMPDIR` for its sandbox's sockets.
  It is removed when the run ends, and a start removes only directories named that way, never
  through a link. Commands use the run's scratch directory as `TMPDIR`, `TMP` and `TEMP`.
- Right after launch the daemon records the run's process group (leader pid, start time, boot
  id, and its installation: the database file's device and inode) in
  `<data>/state/processes/<runId>.json`, which no sandboxed command can read or write; a
  `process.json` an agent writes in its run directory is ignored. After a stop that did not drain,
  a start signals only a group the record proves is the run's: same boot and leader start time,
  a leader still leading its group and started after the run, or, once the leader has exited,
  members all in its session, started after the run and carrying the run's
  `CRAFTINGTABLE_RUN_ID`. Never pid 0 or 1 or the daemon's own group; a record from another
  installation (a copy of the data directory) is left alone and journaled.
- Claude Code loads no settings from any scope, not even the repository's, and no MCP servers,
  skills, plugins or auto-memory; the repository's `CLAUDE.md` still applies. Codex runs with
  plugins, apps, hooks and memories disabled, and every MCP server and user skill the operator's
  configuration adds switched off. Unexpected Codex approval or input requests are declined. See
  [ADR-020](decisions/ADR-020-execution-model-and-claude-code-backend.md) and
  [ADR-023](decisions/ADR-023-codex-app-server.md).

## Agent sandboxes

The permission posture is chosen per run or step. Under `auto` (the default) Claude Code's
classifier approves routine actions and commands run without asking inside its sandbox. Under
`edit-only` Claude's file edits are accepted and every prompt is denied, so a Claude `edit-only`
run runs no commands. Codex runs commands without asking inside its sandbox under both.
`unrestricted` removes permission checks and the sandbox: the run has the operator's full local
authority, like running the agent by hand, and choosing it needs step-up. No command may ask to
leave a sandbox: Claude's refuses unsandboxed commands and will not start without the sandbox,
and Codex runs with approval policy `never`.

**Claude.** Every posture but `unrestricted` runs Bash in Claude Code's OS sandbox. Commands may
write the worktree, the run's directories, its scratch space, the outside sources' caches and the
directories the daemon adds for the run (`additionalDirectories`: the previous run's directory, a
historical baseline's Cargo home, a pinned local-CI cache root, the worktree's shared Cargo
target). In
the repository's Git directory they may write what a commit, a rebase or a merge needs: Claude
Code grants the whole common directory itself, and the adapter keeps read-only every entry of it
that exists at launch but `objects/`, `refs/`, `logs/` and `worktrees/` (the primary checkout's
`HEAD`, `index` and `packed-refs`, `config`, `hooks/`, `info/`, `rr-cache/` and the rest), every
other worktree's entry that exists at launch, and, existing or not, the common directory's
`commondir`, `config.worktree` and `objects/info` and the run's own `commondir`, `gitdir` and
`config.worktree`. A name missing at launch is not denied beyond those: a worktree entry created
after the run launched, and Git's in-progress state for the primary checkout (`rebase-merge/`,
`rebase-apply/`, `sequencer/`), stay writable (see Known limits).
They may listen on local ports and reach no host but the outside sources' hosts, a strict
allowlist. Claude's own file tools are not commands: permission rules deny them reads and edits of
the same list its commands are denied (below), each path itself and everything under it;
otherwise they follow the posture. An `unrestricted` run's file tools are denied only the daemon's
protected paths, as its commands are denied nothing. Its WebFetch and WebSearch tools are not
limited by the network allowlist, by decision: a sandboxed run cannot read the daemon's secrets,
so they have nothing of the daemon's to send.

**Codex.** A sandboxed Codex run's commands get a permission profile defined for the run
(`craftingtable`), selected on the thread and on every turn: they may write the worktree, the
temporary directories, the run's directories, the outside sources' caches and the same added
directories, and reach no
network but the sources' hosts, through Codex's own proxy (none without a source). To stage and
commit, only the common directory's `objects/`, `refs/` and `logs/` and the run's own Git
directory are writable, with `objects/info`, `commondir` and `gitdir` read-only; the rest of the
common directory, `config`, `hooks/` and `info/` included, stays read-only. The daemon resolves
these directories before launch and grants them only when they are the primary checkout's own; a
repository that enables `extensions.worktreeConfig` gets no Git grant. A read-only Codex run
gets a profile of its own (`craftingtable-read-only`, below). Verified with Codex CLI 0.160.0.

**Denied reads.** Both sandboxes deny commands the same list (`sandboxDeniedReads`): the user's
runtime directory (the rootless Docker socket and the session bus), the system Docker socket,
`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.config/gh`, `~/.git-credentials`, `~/.codex`,
Claude Code's credentials file (for Codex, the whole of `~/.claude`), the registry tokens in the
run's Cargo home, `~/.pypirc`, `~/.netrc`, uv's stored credentials and its user configuration
(under the XDG data and configuration directories), and the daemon's protected paths: the database directory (with its
pre-migration copies and process records), the default and the configured backup directories,
and the settings directory with the credentials file. Claude's own file tools are denied the same
list on every posture but `unrestricted` (which keeps only the daemon's protected paths), so a
read-only Claude run, which has no commands, has its Read, Glob and Grep denied it, and a
read-only Codex run's profile denies it too. Codex 0.160.0 can mask at most one existing file
per sandbox, so a sandboxed or
read-only Codex run that would need more is refused before it starts (`environment-unavailable`;
a cycle stops as `agent-environment-unavailable`), naming the files.

**Outside sources.** The only hosts a sandboxed command may reach beyond loopback, and the only
caches it may write beside its worktree and run, are the operator's outside sources, named in
`outside-sources.json` in the settings directory and read at start. Two kinds exist. `cargo`:
`index.crates.io` and `static.crates.io` (never the `crates.io` API, which publishes) and the
`registry` and `git` caches of the daemon's own Cargo home, `<data>/cargo-home`, never the
operator's `~/.cargo`. `pypi` ([ADR-074](decisions/ADR-074-python-toolchains-and-pypi-wheels.md)):
`pypi.org` and `files.pythonhosted.org` only (no extra host, so no mirror or second index, and
never `upload.pypi.org`), writing one uv cache all agents share, `<data>/uv/cache`, which no
check reads; it needs the Python profile, whose uv goes first on agents' PATH, with
`UV_PYTHON` set to the profile's interpreter and Python downloads off. The daemon refuses to start
when the file is invalid, lies where agents write, or would put a cache over its own files. Read-only runs get no sources; `unrestricted`
runs are not limited by them. Each run's journal notes at launch what its commands may reach.
Configuration is in [Agents on the workstation](operations.md#agents-on-the-workstation).

**Read-only runs.** A decision preparation or a question stop's investigation runs read-only,
whatever its posture, with escalation denied. Claude is restricted to Read, Glob and Grep, which
are denied the protected paths. Codex's commands get a read-only permission profile defined for
the run (`craftingtable-read-only`): they read what the account can except the denied reads, write
nothing (not the worktree, `/tmp` or `$TMPDIR`) and reach no network. The daemon records the
worktree when an investigation starts and compares it once the run has ended; a change stops it as
`worktree-changed`, and the stop's commands are refused until the operator acknowledges it or the
tree matches again.

## The daemon's own Git

Every daemon Git command runs through `packages/git/src/runner.ts` with:

- `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.excludesFile=/dev/null` and
  `core.attributesFile=/dev/null`, so repository hooks and fsmonitor commands never run in the
  daemon's context; diffs pass `--no-ext-diff --no-textconv`;
- named variables only (`PATH`, `HOME`, a C locale), no system configuration, and as global
  configuration only a daemon-written file with the operator's `user.name` and `user.email`
  (`<data>/git-identity.gitconfig`); replace refs are ignored;
- its Git directories named explicitly (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`), never found
  through a file an agent can write. A worktree's `.git` file must name an entry in a registered
  repository's `worktrees/` whose `gitdir` names that worktree back; a managed worktree holding a
  Git directory of its own is refused; a `commondir` file that disagrees with where its Git
  directory lies is refused (Git's ref store follows it even under `GIT_COMMON_DIR`); and so is
  any command in a managed run's worktree or repository while the run's Git directory holds a
  non-empty `config.worktree`. Each fails with `untrusted-git-directory` and nothing runs.
  Commands with no repository yet (`git init` of a scratch store, `git version`) are not pinned;
- an index file only when the daemon makes one for a single command (`GIT_INDEX_FILE`).

A repository's own configuration still applies, including its identity, merge drivers, signing
program and filters; sandboxed agents cannot write it. The daemon deletes only branches whose
commits are kept: merged ones (an item's branch after its merge, an integration branch after
promotion), and a wound-down roadmap's branches on the owner's cleanup, each contained in its
integration branch at a pinned commit or in a new parked tag. Every deletion is a
compare-and-delete, so a branch that moved meanwhile stays. It creates baseline and parked tags
create-only and never moves or publishes one; a `git push --tags` by the operator would publish
them.

The daemon records a run's repository's branches and tags when the run starts and compares them
when it ends. A ref no managed worktree owns that moved, and that none of the daemon's own Git
operations moved there, is journaled, audited as `agent-run.protected-ref-moved`, kept in
`protected_ref_moves` and shown as an inbox item per repository until an owner or editor
acknowledges exactly the moves it listed. A move is never changed or deleted. This detects; it
does not prevent, and the snapshots are held in memory, so a restart ends the watch.

## Checks and builds

Agents never run the checks that count. Their launchers (`ct-check`, `ct-act`, `ct-native`, and
pinned Cargo's build commands) leave a request in the run's spool; the daemon runs it outside the
agent's process tree and records the receipt in its database while the run is live. The spool is
agent-owned, so the daemon never follows a link or reads a FIFO there and creates each reply file
exclusively. See [ADR-053](decisions/ADR-053-scoped-verification-and-local-ci.md) and
[Checks](operations.md#checks).

- **Check units.** Each check runs in a transient systemd user unit: the file system read-only
  except the run's own paths, a private `/tmp`, an empty `/dev/shm`, no network, no new
  privileges, a time limit for the whole cgroup, capped memory (no swap) and tasks, and exactly
  the environment the daemon names.
  A check unit sees neither the user's runtime directory nor the system's Docker and D-Bus
  sockets. A local CI unit sees the runtime directory empty too, but for the Docker socket its
  configuration names, which is bound back when it lies there (rootless Docker), and it keeps the
  system's Docker socket; no other socket there (an SSH or GPG agent's, the user bus) reaches it.
  `CRAFTINGTABLE_CHECK_CONFINEMENT=none` runs checks as plain process groups instead (tests, or a
  host without a user manager).
- **Private clones and Cargo.** A declared check, and a pinned build of a clean worktree, runs
  on a daemon-private clone of the committed head, with verified private checkouts of the pinned
  upstream commits, in a unit that sees none of the roots any agent writes, from the manifest
  text the daemon verified at launch. Each check gets a fresh Cargo home, a local registry of the
  locked crates whose SHA-256 matches crates.io's published index, and runs offline. Adopted
  checks run the commit's rustup-managed toolchain (a `path` toolchain is refused) with rustc
  wrappers cleared, and a check is refused when the tree has a Cargo configuration or toolchain
  file it was not adopted with. A build of uncommitted work, which no gate accepts, still runs in
  the worktree.
- **The Python toolchain.** A Python project's adopted checks build their venv with, and run
  first on PATH, only the interpreter and uv that `toolchains.json` names
  ([ADR-074](decisions/ADR-074-python-toolchains-and-pypi-wheels.md)). Each must be a regular
  file that root owns and only root may write, every directory above it too, with no link on the
  way, because anything the operator's account can write, agents can; the interpreter's install
  (its standard library at any depth, and the entries of its `lib/`, its `bin/` and its prefix,
  where a `pyvenv.cfg` would redirect it) is held to the same rule before the interpreter ever
  runs. The daemon refuses to start on a tool that breaks
  the rule, probes each one with fixed arguments and no input, and every Python check reads each
  tool again, the media tools and fonts included: any problem with one (missing, no longer
  root-owned, writable by its group or others, a failed probe, a version that no longer fits)
  refuses the check, and the identities it ran with go into its receipt.
- **Python checks.** An adopted check of a reviewed commit with a root `uv.lock` runs in a fresh
  venv built for it alone, in its private directory, by units with no network: the lock is read
  with the profile's interpreter, the wheels that fit it come from the daemon's verified store
  (copied, then hashed again), and uv installs them offline with every hash required and nothing
  built. Git, URL, path and other-index sources, sdist-only packages and a packaged project are
  refused by name. The check runs with the venv first on PATH and read-only, uv offline and
  frozen, and no Python or uv setting inherited; it never reads the agents' uv cache or reuses a
  venv. Its receipt names the tools, the profile, the lock and, by digest, the set of verified
  wheels the install could draw on. Python environment and tool configuration files
  (`pyproject.toml`, `uv.lock`, `uv.toml`, `.python-version`, pytest's `pytest.ini`,
  `.pytest.ini`, `pytest.toml` and `.pytest.toml`, `.coveragerc`, `tox.ini`, `setup.cfg`, Ruff's
  and mypy's) are held like Cargo's: every adopted check must name each one its commit tracks, at
  any depth, and a check is refused when its tree has one it was not adopted with. The tests,
  `conftest.py` and the rest of the tree's code stay the reviewer's: under `python -m` the tree
  comes first on `sys.path`, so a module there can stand in for the runner or a locked package,
  and a `*.dist-info` there can register a pytest plugin.
- **Adopted checks.** Checks are adopted only by a person: an owner or editor on the Repositories
  page, from `.craftingtable/checks.json` read by the daemon's Git at an exact commit. A slice
  that changes a definition file is merged only by a person who approves the definitions with
  the merge, by digest; a roadmap never merges it, and an agent never adopts. In a repository with
  an adoption every run is held to its checks (a run without a pinned environment gets a
  check-only manifest whose one launcher is `ct-check`), and any merge needs a clean, successful,
  daemon-recorded receipt of each check on the reviewed head; a review prepared without the
  adoption is refused. A roadmap's cycle in a repository with no adoption stops before launch as
  `repository-checks-undeclared`. Where a review's gate needs a build (upstream pins, scoped
  checks, native verification) or adopted checks, it authorizes integration only with a valid
  frozen build record from its current dependency environment.
- **Local CI and native verification.** `ct-act` runs act in a daemon unit with the same file
  limits plus the CI cache, network allowed, and a `HOME` and working directory the daemon owns
  (no planted `.actrc`); it refuses jobs with `container`, `services`, a reusable workflow or a
  `docker://` step. Rootless Docker keeps ordinary user authority, so these are cooperative
  controls, not a hostile-code sandbox. `ct-native` starts the operator-approved native unit,
  bounded in CPU, memory, tasks and time, whose file access follows the OS account; an approval
  binds observed host and toolchain facts to an exact binding and grants no Kata or root
  authority ([ADR-054](decisions/ADR-054-managed-native-verification.md)).
- **Pinned exports.** Pinned dependency generations take registered repository aliases and local
  refs. Exports reject links, submodules, unsafe names and oversized trees, and read the exact
  commit through a pack fetched into a daemon-private repository, so an object rewritten in a
  repository's store fails the export
  ([ADR-047](decisions/ADR-047-pinned-builds-and-reviewed-evidence.md)).

## Merge and promotion authority

The implementation agent never holds merge authority. Merging is a daemon command, and the only
evidence it accepts is a current review.

- **The review gate.** A worktree is mergeable only when no run is live in it and its latest run
  (investigations aside) is a finished review whose `mergeable` verdict was given for the
  worktree's current version and target. The merge command checks the gate again, verifies the
  reviewed source and target commits, and reserves a durable merge operation. It builds the
  merge commit without a worktree and moves the target by compare-and-swap, or fast-forwards the
  primary checkout when that has the target checked out; a target that moved, or is checked out
  elsewhere, is refused and nothing moves. See
  [ADR-021](decisions/ADR-021-work-item-lifecycle-and-review-gated-merge.md).
- **Delegated merges.** An owner or editor may let a roadmap merge into integration branches and
  delegate conflict resolution, separately, through its saved policy; the policy of the attempt's
  own definition revision decides. `main`, `master`, every registered default branch of the
  repository, additional protected branches in plan settings and every finalization destination
  can never be an automatic target. See
  [ADR-033](decisions/ADR-033-delegated-integration-and-plan-finalization.md).
- **Conflict resolution.** A resolution agent edits, stages and verifies a pinned integration
  merge into the item branch; the daemon checks `HEAD`, `MERGE_HEAD`, the resolved index, the
  staged tree and that no untracked files remain before committing the reserved two-parent
  commit. Abandoning aborts only the recorded merge. See
  [ADR-032](decisions/ADR-032-delegated-integration-conflict-resolution.md).
- **Checkpoint commits.** Before an automated review the daemon may commit tracked edits and
  explicitly staged new files on the managed item branch, bound to a reserved content
  fingerprint, parent commit and path list, with hooks off; drift stops the step. See
  [ADR-031](decisions/ADR-031-worktree-finalization-and-review-housekeeping.md).
- **Repository cleanup.** Only an owner's command, with step-up, on a wound-down roadmap removes
  its worktrees and branches, selected by the roadmap's records, never by a branch pattern. A
  branch is deleted only by compare-and-swap at the tip the plan recorded, while its integration
  branch at a pinned commit, or a new parked tag created from nothing, keeps its commits. Never
  touched: every registration's default branch; every plan's integration and manual merge
  branches; every roadmap's integration branches; active worktrees' integration branches;
  finalizations' integration and target branches; pending merges' targets; `craftingtable/*`
  branches; existing tags; and whatever another roadmap that has not ended names. A worktree whose
  checkout left its branch, or cannot be inspected, stays. Each of these is checked again when an
  interrupted cleanup resumes. See [ADR-073](decisions/ADR-073-winding-down-a-roadmap.md).
- **Final promotion.** Only an authenticated operator command from a browser session, with
  step-up, carrying the exact reviewed candidate and destination commits, promotes a finalization;
  no stage, roadmap policy, question or exhausted budget relaxes it. Every finalization is staged
  and its promotion checks every stage and the current full review. See
  [ADR-042](decisions/ADR-042-staged-plan-finalization.md).
- **Slices and evidence.** A slice merge never completes its parent; parent acceptance is a
  separate reviewed command. Saved-plan acceptance is generated only for a map's plan checkpoint
  whose obligations are the setup facts the daemon knows (`mapCapabilities`), and is accepted
  by the operator with a rationale. It is bound to the plan-acceptance inputs: the map and its
  archives, the binding, the adopted proposals and staged decisions, reviewer roles, target and
  selection, resources and upstream pins; names, instructions, agents, automation and capacity
  are not inputs, and records from before (v1) keep their saved-revision rule
  ([ADR-050](decisions/ADR-050-generated-plan-acceptance-evidence.md)). The
  public evidence upload cannot carry the server-only markers of generated plans, candidate
  checkpoints or architecture decisions. Agent checkpoint attestations are attributed to the
  delegated review, never presented as operator approval
  ([ADR-063](decisions/ADR-063-controller-obligations-and-operator-questions.md)).

## Delegated work

- Saving a roadmap delegates nothing. Start, Resume and grants are owner or editor commands.
  Background work then acts as the recorded delegating user, without a browser session: the
  daemon rechecks on every pass that the user is active and still an owner or editor of the
  workspace, and each cycle keeps its own launch checks. Signing out leaves deliberate
  delegation running; Pause and Stop are the controls. While a cycle runs or awaits merge, or an
  integration resolution owns the worktree, a manual launch or a message to its agent is refused
  (the resolution's own current run excepted).
- Controller reviews of a slice cycle (checkpoint, reassessment, the source-required security
  review) run on its roadmap's saved reviewer delegation. A cycle no roadmap owns still owes the
  security review, which the operator who started the cycle authorizes; a roadmap that owns a
  cycle without a readable reviewer delegation authorizes none, and the cycle stops.
- A roadmap's agents are assigned separately from its saved definition, while scheduling is
  paused: an assignment carries backend, model and effort only, never permissions, reviewer
  responsibilities, budgets or merge authority, and runs keep the assignment they launched with
  ([ADR-064](decisions/ADR-064-agent-profile-delegation.md)). Permissions are saved with the
  definition, which needs step-up when it grants `unrestricted`.
- Standing decision preparation is granted per roadmap while scheduling is paused, audited, and
  revoked by the operator or by an applied amendment. Each preparation runs as the grantor, who
  must still be an active owner or editor at every launch stage; approving a decision stays the
  operator's alone ([ADR-065](decisions/ADR-065-future-delegation-and-decision-preparation.md)).
- Approvals grant only what they name. Adopting a map's scheduling proposals needs the exact
  binding, every proposal and a rationale, and grants no environment or merge authority
  ([ADR-048](decisions/ADR-048-cross-project-supervision.md)); early-development authorization
  applies only to a declared slice rule
  ([ADR-046](decisions/ADR-046-transition-gates-and-resource-reservations.md)); an amendment needs
  the current version, the exact impact digest and a rationale
  ([ADR-049](decisions/ADR-049-reviewed-map-amendments-and-finalization.md)); a dependency refresh
  rejects a stale preview and launches nothing
  ([ADR-058](decisions/ADR-058-reviewed-dependency-refresh.md)).
- Phase reservations, capacities and exclusion groups coordinate the daemon's own work. They do
  not confine an agent or bound the host.

## Untrusted input

- **Plan bundles** are parsed with a bounded YAML profile (aliases, depth and node count are
  capped) within upload limits, and served back only as escaped text or `text/plain`
  attachments.
- **ZIP packages** are bounded (8 MiB upload, 512 entries, 2 MiB per entry, 32 MiB expanded),
  read in memory and never extracted or executed. Unsafe paths, duplicates, links and special
  files, overlapping entries, encryption, ZIP64 and CRC mismatches are refused. Uploaded schemas
  and validators are inert data; a map is checked against the daemon's own closed schema
  ([ADR-043](decisions/ADR-043-package-imports-and-concurrency-previews.md)). Binding exact plans
  approves nothing and starts nothing.
- **Agent output** becomes bounded, normalized events; unknown shapes become notices, and
  oversized values are truncated before storage. The browser renders event text, patches and
  final messages as text: no agent HTML is evaluated, and there is no `dangerouslySetInnerHTML`.
- **Review reports** are a reviewer's assertions, validated by the daemon: an invalid report
  cannot supply a verdict, the final `VERDICT:` line must agree with the structured report, and a
  later review without a verdict clears an earlier one. Implementer claims never close findings.
  Handoff files are copies for the next agent's context, not an authorization surface
  ([ADR-024](decisions/ADR-024-complete-handoffs-and-review-findings.md)).

## Credentials and stored secrets

- The daemon never handles a model provider's credentials: Claude Code and Codex use their own
  logins as the daemon's OS account, and only the vendor login variables listed under
  [Agent processes](#agent-processes) pass through. CraftingTable records billing provenance, not
  account identities or tokens.
- Pushover application tokens and user keys are write-only through the API and kept in plaintext
  in `credentials.json` in the settings directory (`~/.config/craftingtable`, or
  `CRAFTINGTABLE_CONFIG_DIR`; a development daemon uses `craftingtable-dev` beside it): mode 0600,
  in a directory the daemon makes 0700 whenever it writes, written whole and renamed into place,
  outside the database and so outside its backups. Credentials still in an older database move
  there at start. A file the daemon cannot read stops delivery, and the Notifications page says
  so. They never appear in API responses, audit metadata, workspace events, logs or briefs.
- The database is mode 0600. Scheduled and manual backups are 0600 files in a 0700 directory, and
  contain accounts, sessions and settings. The daemon keeps one pre-migration copy: making one
  removes the one before, and at every start any other over 14 days old goes, never the newest.
- Sandboxed agents cannot read any of these ([denied reads](#agent-sandboxes)); an
  `unrestricted` run, or any process with the account's authority, can.

## The daemon's outbound requests

The daemon makes three kinds of request of its own:

- **Pushover**, for notifications: only its fixed HTTPS endpoint, with redirects refused, a
  10-second timeout and a bounded response. A push carries project and item names, short
  reasons, counts, branch names and a link to the private app, never conversations or finding
  text; provider error bodies are never shown or logged. Notifications grant no authority: their
  links open the authenticated app. Only workspace owners configure them, and delivery rechecks
  that the configuring owner is still an active owner
  ([ADR-070](decisions/ADR-070-attention-items.md)).
- **crates.io's index** (`https://index.crates.io/`), to verify the crates checks use: redirects
  refused, a timeout per request and at most 500 requests per ten-minute window.
- **PyPI** (R-G17, [ADR-074](decisions/ADR-074-python-toolchains-and-pypi-wheels.md)), for the
  wheels Python checks use: its JSON API (`https://pypi.org/pypi/<name>/<version>/json`) and the
  files it names on `https://files.pythonhosted.org/` only, with redirects refused, timeouts, a
  16 MiB answer and a 512 MiB file limit, at most 600 requests per ten-minute window, and a 20 GiB
  store, least recently used first. A wheel is kept, under its SHA-256 in `<data>/pypi-wheels`,
  only when its bytes match both PyPI's published digest and the adopted lock's hash.

The agents' own CLIs reach their vendors as the operator's account does.

## Installation storage

Storage settings belong to the installation: viewing or changing them needs an owner of every
active workspace (`installation` access), so creating a workspace grants no host-wide authority.
Locations are validated and canonicalized before directories are created, may not overlap the
database, sources, runs, backups or the outside sources' caches, and keep their device
identities. Changes apply to future work and never move or delete existing checkouts. Cleanup
deletes only what a daemon-held preview listed, after rechecking eligibility and file-system
identity under the worktree guard; recursive inventory does not follow links and stops at other
file systems. These checks prevent accidental deletion and stale paths, not a malicious concurrent
change to the host's file system. See [ADR-034](decisions/ADR-034-storage-placement-and-retention.md).

## Known limits

- **`unrestricted` is the operator's authority.** Such a run has no sandbox and no network limit,
  and nothing is denied it but a Claude run's file tools on the daemon's protected paths; the
  worktree is a convention. Step-up is the only gate before it.
- **Claude Code's own tools** are not sandboxed commands. Its file tools are held by permission
  rules (the denied-reads list, or on `unrestricted` the daemon's protected paths, then the
  posture's checks), not by the OS sandbox; WebFetch and WebSearch reach any host.
- **Claude's Git placeholder.** Claude Code 2.1.288 holds a denied path that does not exist with
  an empty placeholder while a sandboxed command runs, and the common directory's `commondir`
  is one. While it exists, Git in the primary checkout and the daemon's checks on a clone of the
  reviewed commit refuse ("failed to read .git/commondir"): they fail closed, and nothing is
  redirected. A refused check can be run again.
- **Git state Claude can still plant.** Claude Code binds a linked worktree's whole common
  directory writable, and only names that exist at launch, with the few listed above, are denied
  (operator decision 2026-10-13). A sandboxed command can therefore create Git's in-progress
  state for the primary checkout (`rebase-merge/`, `rebase-apply/`, `sequencer/`, `MERGE_HEAD`)
  and write the `HEAD` and `index` of a worktree entry created after it launched. The R-G16
  review showed the first: the operator's own `git rebase --continue` in the primary checkout
  then runs a planted `exec` line outside any sandbox, and `git rebase --abort` moves the
  checked-out branch. Codex runs cannot (their common directory is read-only). Until the
  operator decides otherwise, check `git status` in the primary checkout before continuing a
  rebase, merge or cherry-pick you did not start.
- **External Git.** The daemon's guards serialize its own Git work. A person or tool running Git
  outside it, including in a run's worktree, uses whatever `.git` pointer the agent left there;
  check it before running Git there by hand. External changes are detected by commit and
  cleanliness checks, not prevented.
- **Detection, not prevention.** The ref watch and the investigation worktree check report
  changes after the fact; a run can still create or move branches.
- **Process groups** do not contain work that deliberately leaves its session. The native unit
  and local CI's Docker keep the account's file-system and Docker authority, and a checked tree's
  build scripts, procedural macros and tests run with whatever the check's unit allows.
- **Native probes.** The native environment's fixed version probes (`native-environment.ts`)
  start with the daemon's whole environment, not the named variables agents and checks get; they
  run fixed commands with no agent input. The toolchain probes (`toolchains.ts`) start with a
  fixed `PATH`, locale and `UV_NO_CONFIG=1` only, in `/`.
- **Secrets at rest** are plaintext files protected by modes and the denied reads. Database
  copies made before the credentials moved still hold them, and clearing credentials does not
  securely erase SQLite pages or older backups.
- **Third-party features.** Codex's permission profiles and network proxy are Beta and
  experimental features, and its one-masked-file limit is why such a run is refused, not started.
