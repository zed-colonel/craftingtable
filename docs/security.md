# Security model

CraftingTable is a single-operator tool for a trusted home network. Authentication,
CSRF, origin policy, and process containment are kept intact even though only one
person uses it, because the daemon can spawn a coding agent with write access to
your repositories.

## Network exposure

- The daemon listens on loopback by default.
- A non-loopback `CRAFTINGTABLE_HOST` is refused unless TLS is configured
  (`CRAFTINGTABLE_TLS_CERT`/`KEY`) or the public origin is HTTPS behind a proxy.
- The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` whenever the public
  origin is HTTPS. Mutations require the session-bound CSRF header and an exact origin
  match; cross-site fetch metadata is rejected.
- The built browser app can be served by the daemon so one TLS origin carries UI and API.

## Route access

Every API route declares who may call it where it is registered (`config.access` in
`routes/route-access.ts`):
- `public`: health and login only.
- `session`: any signed-in user, outside a workspace.
- `member`, `editor`, `owner`: the least workspace role.
- `installation`: host-level settings; the user must own every active workspace.

The daemon refuses to start when a route has no declaration, when a workspace mutation admits
viewers, or when a mutation other than login is public. One guard runs the declared check before
the handler validates input:
- no session: 401;
- a mutation without the CSRF header or from another origin: 403;
- a non-member: 404, recorded as a denied access;
- a member below the declared role: 403.

Handlers and services keep their own checks. `route-access.test.ts` requests every live route as
each kind of caller and compares the answer with the declaration.

## Secrets and credentials

- Bootstrap is interactive and refuses password arguments; there is no registration route.
- Passwords are Argon2id hashes; session tokens are stored as SHA-256 digests.
- Logs redact cookies and authorization headers; audit metadata excludes bodies and tokens.
- Claude Code and Codex use their own logins on the workstation. The daemon never handles API keys;
  it records only billing provenance or an environment-based API-key hint.
- Changing a password in the browser requires the current one and revokes every other session.
- Forgotten-password recovery is an interactive local CLI command: `admin reset-password`.
  Its authority is the OS user's existing database access. It revokes every login session
  and records the password change atomically. No unauthenticated web reset route exists.
  Login and browser password changes recheck credentials after asynchronous hashing so
  requests already in flight cannot restore access with a password that was reset.

## Delegation surface

The browser never submits a shell command, a path the daemon will execute, or an argv.
It submits:

- a repository root to register, which the daemon verifies is the top level of a Git
  working tree before storing;
- a work item and repository to create a worktree for; the daemon derives the branch
  name and path under its managed worktree root;
- a role, permission posture, optional model name, and free text that becomes the brief
  or a follow-up message to the agent;
- explicit plan branch settings, a selected starting branch when creating an integration
  branch, or an existing worktree to adopt, retarget, or update. Git references are validated
  through bounded argument-array operations; no rebase or force-push is exposed;
- a worktree to merge into its recorded target. The daemon refuses unless its most recent
  run is a review whose final message carried a `mergeable` verdict, both source and target
  commits still match its recorded context, and no run is live in it. It performs the merge in a
  scratch worktree unless the primary checkout already has the target checked out. The implementation
  agent never holds merge authority; a review agent supplies evidence for the daemon
  command under operator approval or explicit integration delegation.

Process authority is confined to the adapter modules listed in
`scripts/check-forbidden-scope.mjs`. Every spawn uses argument arrays with `shell: false`,
a detached process group that is terminated as a group, and bounded output.

The agent's permission posture is chosen per run:

- `auto` (default): Claude Code's own classifier approves routine actions; anything that
  would need a human prompt is denied.
- `edit-only`: Claude file edits are pre-approved, prompts are denied.
- Codex `auto` uses workspace-write with `on-request` and `auto_review`: Codex's
  reviewer decides requests to expand permissions. `edit-only` uses workspace-write
  with `never`, denying escalation. These overrides apply to new and resumed threads
  and every turn. Unexpected client approval requests are declined; the browser has
  no generic permission-grant or RPC surface.
- `unrestricted`: approval checks and any backend sandbox are disabled.

Claude's permission modes do not confine the agent to the worktree at the OS level.
Codex app-server communicates only over the supervised process's stdio. Authentication
remains in Codex; CraftingTable reads the account type but does not persist account
identities, credentials or raw authentication responses.

Codex's workspace-write mode applies its own sandbox; unrestricted removes it. The brief instructs it
to stay there, and the diff makes deviations visible, but an unrestricted run has the
operator's full local authority. Treat `unrestricted` as you would running the agent by
hand.

## Daemon Git

Every Git command the daemon runs (R-G5, SEC-03, GIT-08) passes `core.fsmonitor=false` and
`core.hooksPath=/dev/null`, so repository hooks and fsmonitor commands never run in the daemon's
context, and every diff passes `--no-ext-diff --no-textconv`. It starts from named variables only
(PATH, HOME, a C locale), reads no system configuration, and as global configuration reads only a
daemon-written file holding the operator's `user.name` and `user.email`
(`<data>/git-identity.gitconfig`): the operator's aliases, rerere and diff settings do not apply.
A repository's own configuration still does, including its identity, merge drivers, signing
program and filters. A sandboxed agent cannot write it: Codex runs use Codex's sandbox, and since
R-G5 Claude runs' Bash runs in Claude Code's OS sandbox (every posture but unrestricted), writing
only the worktree, the run's directories, its scratch space, the temporary directory Claude
Code gives its commands beneath the run's own short private one (`<data>/t/<12 hex>`, 0700,
removed when the run ends; Claude's TMPDIR, short so its sandbox's sockets fit, LIVE-31) and
Cargo's `registry` and `git` caches in the daemon's own Cargo home (`<data>/cargo-home`; never the operator's `~/.cargo`, so a
crate an agent plants never runs in the operator's own builds, R-G5 review; check units do not build
from it either: each gets a fresh Cargo home of its own, a local registry of crates.io's published
index entries and only the downloads whose SHA-256 matches them, which the daemon reads from
crates.io's index over HTTPS, runs offline, and cannot see the shared one; operator decisions
2026-09-29), reaching nothing but loopback and the crates.io
registry's index and downloads (`index.crates.io`, `static.crates.io`, a strict allowlist, so
that `cargo fetch` can download dependencies; operator decision 2026-09-28; not the `crates.io`
API, which publishes), unable to read Cargo's registry tokens, the user's runtime directory (the rootless Docker socket
and session bus), system Docker sockets or the operator's credentials, and with no way to leave
it. Claude loads no settings file from any scope, not even the repository's, so a worktree cannot
widen its sandbox or add hooks. Claude's Edit and Write tools stay under the permission posture,
and the network allowlist gates sandboxed commands only: Claude Code's own in-process tools
(WebFetch, WebSearch) are not gated by it. Checks the daemon runs on a worktree use the git
directory it resolved before the agent started, never the worktree's `.git` pointer (R-G4).
The daemon also records a run's repository's branch heads when it starts and compares them when it
ends (R-G5, SEC-02d): a branch no managed worktree owns that moved, and that none of the daemon's
own Git operations left there, is noted in the run's journal and audited as
`agent-run.protected-ref-moved`. The move is also kept in `protected_ref_moves` (schema 35) and
shows in the inbox, one item per repository, until an owner or editor acknowledges exactly the
moves the item listed (`protected-refs.acknowledged`). A move is never changed or deleted; the
acknowledgement is added once. It detects; it does not prevent.

## Untrusted input

Plan bundles, agent output, and Git output are untrusted. Plan bundles are parsed with a
bounded YAML profile and served back only as escaped text. Agent output is translated
into bounded normalized events; unknown shapes become notices, oversized values are
truncated before storage, and the browser renders event text and patches as text, never
as HTML.

Structured review reports are untrusted reviewer assertions validated by the daemon.
Invalid reports cannot supply a verdict, and a follow-up review without a verdict clears
an earlier one. Legacy unstructured reviews retain the manual verdict path. Materialized
handoff files are copies for agent context, not a new authorization surface; the durable
report source remains the daemon's event journal. Source runs are checked against the
child's workspace, work item, and worktree before their conversations are copied.
An explicit owning-slice repair command can additionally pin complete review turns from
that work item's independent verification and parent-acceptance scopes, at the exact
map binding. This separate packet retains source run IDs and journal sequences, gives
colliding finding IDs distinct names, and cannot authorize scope changes or merges.
It does not relax ordinary same-worktree run lineage checks. The server requires a
supported disposition for every pinned open finding in subsequent repair reviews.

## Delegated work-item cycles

Starting a cycle is an owner/editor command protected by the existing session, origin,
and CSRF checks. Background launches derive authority from that recorded initiating
user and current workspace membership, without manufacturing browser sessions. Logout
or session expiry leaves deliberate delegation active; pause/stop are explicit controls.
Manual launches and steering require takeover while automation owns the worktree.

A cycle reserves run IDs before launch and never resumes automatically after restart.
Review approval requires a clean managed branch at the recorded commit; the shared merge
command rechecks it and pins the Git source and destination commits. A shared daemon guard keeps agent launches
and cycle resumes out of an in-flight merge or removal. Quality thresholds alone grant
no merge authority: integration requires explicit operator approval or a saved roadmap
delegation; protected destinations always require explicit approval.
Automated finalization may commit tracked edits and explicitly staged new files on the
managed item branch after the implementation session ends. It cannot stage arbitrary
untracked files or merge. A reserved content fingerprint, parent commit and explicit path
list bind each checkpoint; repository hooks do not run for it (R-G5) and unexpected drift stops advancement.
Repository and worktree guards serialize it with other daemon mutations. External Git
processes remain outside these guards. Negative review findings can request remediation on
a dirty tree without granting merge approval. Scratch directories live under private run
storage and are granted through the existing run-file scope. See ADR-031.

## Pushover delivery

Only workspace owners can view notification settings, configure a recipient, or request
a test; mutation routes retain session, CSRF, and origin checks. Background delivery
rechecks the configuring owner's active account, active workspace, and current owner
membership. Session expiry or logout does not revoke that standing configuration.

Application tokens and user keys are write-only and stored as plaintext in the existing
private SQLite database (0700 data directory, 0600 database). They are omitted from API
responses, audit metadata, workspace events, logs, briefs, and spawned-agent environments.
This uses the existing OS-user trust boundary: a process running with that user's full
filesystem authority can read the database. Backups require the same care. Clearing
credentials removes the active values but does not securely erase SQLite pages or backups.

The daemon sends only to Pushover's fixed HTTPS endpoint, rejects redirects, bounds the
response, and times out requests. Notifications expose project/item names, short workflow
reasons, findings counts, branch names, and a private application link to Pushover and the
configured recipient; they do not include full conversations or findings text. Provider
error bodies are never surfaced or logged. Notifications grant no workflow or merge
authority; links open the existing authenticated UI.

## Delegated roadmaps

Saving a roadmap does not delegate execution. Start/resume are owner/editor commands
with the normal authenticated session, CSRF, and origin checks. The daemon rechecks the
recorded delegating user's active account and workspace membership before preparing a
worktree; each cycle retains its own existing launch checks. Internal admission, worktree,
and cycle commands accept a user-attributed command context without inventing a browser
session. HTTP routes still require authenticated sessions. Integration merges may be
delegated through the saved roadmap policy; final promotion remains an operator command. Pause/stop supersede pending preparation; a Git operation already in
flight may finish creating a recorded worktree, but cannot launch a superseded cycle.

Independent scope-recovery delegation is separately recorded by an owner/editor while the
roadmap is idle. It grants a bounded number of source-repair attempts per parent, never a
waiver of review, phase evidence or protected-target requirements. Recovery reservations
bind to the original slice definition, and all asynchronous Git/review commands recheck
current delegation before launch. Complete question-free reports can route only to an
unambiguous owning slice. Original independent reviewer assignments remain unchanged.
Paused/stopped roadmaps cannot dispatch recovery; restart retains reservations and used
allowances and still requires explicit Resume. Main promotion is never delegated.

Parallel scheduling retains the same authority checks and review-gated merge command. Item
controls use authenticated, version-checked roadmap commands. Automatic integration refresh
requires an active parallel or automatic-integration delegation, the frozen branch binding, current initiating-user
permissions, and no live sessions. It merges integration into the item branch only. Review
context is invalidated durably before mutation; each refresh uses the repository and worktree
guards and rechecks delegation before Git and before reserving another review. Pause/stop
can supersede an in-flight update without permitting a late agent launch. A running cycle
whose roadmap is paused or needs attention, or whose entry the operator paused, refreshes the
same way just before its review launches or is approved (R-C4). It is running only because
the operator resumed it, requested it as a recovery round, or delegated the repair the roadmap
later adopted (R-C5); the refresh touches only its own branch, under the roadmap delegator's
authority, rechecked. A stopped or
completed roadmap has ended its delegation, and a hold the system placed stays in force.
Awaiting-merge refreshes and merges still wait for the roadmap to run. Exclusion groups
and capacities coordinate daemon work; they do not constrain arbitrary external Git processes
or an agent running with the operator's OS authority.

Controller reviews of a slice cycle (checkpoint, reassessment and the source-required
security review) run on its roadmap's saved reviewer delegation. A cycle no roadmap owns still
owes the security review the merge gate requires; the operator who started the cycle authorizes
that one review, rechecked as an active owner or editor at start and launch (LIVE-02). A roadmap
that owns a cycle without delegating a reviewer, or whose saved delegation can no longer be
read, authorizes no controller review: the cycle stops for the operator (ADR-063, amended
2026-09-27).

## Decision preparation

A decision preparation is a read-only investigation of one shared architecture decision
(ADR-065). It runs in a separate plan worktree at a pinned integration commit, reads only the
exact imported archives and recorded decisions, and proposes: it cannot merge, start a cycle or
approve anything. Its record binds the exact map, binding revision and digest, and its deadline.

An owner or editor starts one by command, or grants a roadmap standing preparation (R-C3b). The
grant is changed only while scheduling is paused, is audited, and is revoked by the operator or
by an applied planning amendment. Under it, each pass of the running roadmap starts the
preparations its selection needs as the grantor: the grantor must still be an active owner or
editor of the workspace, and the grant must still name them, at every launch stage. Such a
preparation is audited as the controller's, naming the grantor. Revoking the grant stops future
launches; a preparation already running finishes within its time limit. Approval stays the
operator's alone, with scheduling paused.

## Integration resolution authority

An explicit owner/editor cycle command or saved roadmap conflict policy authorizes a pinned integration merge into the item
branch. Resolution agents edit, stage and verify; they receive no final-merge authority.
The controller checks HEAD, MERGE_HEAD, resolved index, staged tree and absence of unknown
files before completing a reserved two-parent commit. Normal source/target review freshness
and the configured integration merge authority still apply. While a resolution owns the worktree, unrelated
launches and branch mutations are rejected even while paused. Browser guidance addresses
only the existing owned run. Abandonment requires an explicit UI confirmation, aborts only
the recorded pending merge and never deletes arbitrary untracked files. External tools
still execute with the existing workstation trust model; these guards do not sandbox an
agent or external Git process. See ADR-032.


## Final promotion authority

Finalization starts through an authenticated, CSRF/origin-checked command after validating
plan completion and integration evidence. It creates a managed candidate branch from a
pinned integration snapshot. Agent runs retain existing permission postures and cannot
approve promotion. The daemon holds integration merges while the candidate is active or
paused; external Git remains outside this coordination and invalidates the snapshot.

`main`, `master`, registered defaults, additional plan protections and recorded finalization
destinations cannot be automatic roadmap targets. Promotion requires a separate authenticated
operator command carrying the exact reviewed source and destination commits. Questions,
missing reports and exhausted budgets do not relax that gate. Durable reservations permit
reconciliation of an already-approved commit after restart, without authorizing a new merge.
Cleanup does not force-remove dirty checkouts or unexpected later commits. See ADR-033.


## Storage maintenance

Installation-wide storage routes require an authenticated owner of every active workspace;
mutations also require the existing CSRF and origin checks. A workspace owner cannot gain
host-wide storage authority by creating a new workspace. Paths are validated/canonicalized
before directories are created, must not overlap database/source/run/backup roles, and retain
device identities. Location changes apply to future work and never move or delete existing
checkouts. Browser cleanup supplies only an opaque daemon preview ID, never deletion paths.

Recognized Cargo caches become eligible after finished, failed or cancelled runs with no live
siblings, independently of merge. Runs interrupted on restart remain protected. Full scratch
expiry still requires merged, removed worktrees. Cleanup is serialized with launches and Git
mutations; eligibility and filesystem identity are checked again under the worktree guard.
Recognized Cargo caches use exact structural markers under registered scratch directories;
30-day scratch expiry also requires old contents. Cleanup rejects changed canonical parents,
symlinks at authority roots, and nested filesystems; recursive inventory does not follow links.
These checks prevent accidental deletion and stale-controller paths, not malicious concurrent
host filesystem mutation. Coding agents and the OS account retain their existing trust boundary.
Audit records identify authorized cleanup paths and backups. SQLite snapshots contain accounts,
sessions and notification credentials: private modes protect them like the live database.


## Background completion recovery

An incomplete background exit keeps the run reserved until its owned process group drains
or deadline/cancellation terminates it. Recovery uses the existing cycle delegation and
launch authorization, with two persisted attempts and the original step deadline. An
incomplete review cannot supply merge authority or close findings. Review recovery requires
the original branch context and no tracked/index changes or pending Git operations. Untracked
files are inspection candidates, not automatic deletion targets: the reviewer must establish
verification provenance and preserve artifacts in scratch before cleanup. Unknown files stay
for guidance or remediation. Merge still requires a clean worktree and current review.
No additional process
authority or browser shell endpoint is introduced. Process-group supervision does not
contain commands that deliberately create a new session or external service; the existing
OS-user and agent permission boundaries still apply. See ADR-037.


Operator nit deferrals preserve reviewer-owned findings as open. Exemptions match the recorded
source/destination commits and exact finding details; changed severity, details or commits
invalidate them. Only current, complete successful reviews can supply selected findings.
Authenticated editor commands record rationale and guidance, recheck authority and Git state,
and atomically reserve independent review or bounded focused remediation. Neither action
supplies merge authority or excuses technical failures and genuine unanswered questions.
Final promotion rechecks the current review and effective completion policy. See ADR-038.

Finalization agent changes use the existing authenticated, version-checked recovery commands.
They require an idle checkpoint and an available backend, cannot change permission posture,
and persist with the next run reservation and attributed audit record. A backend switch
receives the existing durable handoff in a new run; it grants no finding waiver, allowance
reset, or final promotion authority. Pending conflicts use their separate recovery controls.

Integration branch removal is an explicit authenticated owner/editor finalization command,
or an opt-in recorded with the exact merge reservation. It only targets the completed attempt's
local integration branch at its pinned snapshot. The controller requires retained promotion
ancestry in the destination and rejects protected branches, active worktree/merge use, active
finalization holds and other plan bindings. Git checks all linked checkouts and uses a
compare-and-delete ref operation, preserving a concurrently advanced branch. Remote refs and
source checkout contents are untouched. Cleanup failure leaves the plan completed with an
independent retry; these daemon checks do not lock out external Git processes.


Staged finalization uses the same authenticated, role-checked, CSRF/origin-protected and
optimistically versioned controls. The server validates stage order, mandatory whole-plan gates,
slice membership, selected finding IDs and current review commits. Browser selections cannot
edit findings or verification verdicts. Plan adjustments approve a specific reviewer-proposed
requirement replacement, record the actor and rationale, and trigger revalidation. Required
checks, genuine questions, correctness/conformance findings and blocking/major findings cannot
be waived by an optional-batch decision or a nit allowance. Evidence reuse requires completed
matching-commit provenance; final promotion rechecks all stage completion and current full-review
evidence before the existing exact-commit merge authority check. No stage grants merge authority.

## Planning ZIP and concurrency-map input

ZIPs are bounded, parsed in memory and never extracted or executed. The daemon validates
paths, links, entry overlap, decompression size and CRC, and applies its own closed map
schema and source/graph checks. Uploaded validators and schemas are inert data. Raw ZIPs
and failed import diagnostics remain workspace-scoped, with inert authenticated downloads.
Exact plan binding does not approve proposals, grant environment authority, pass a checkpoint
or start execution. Activating a revised plan requires an explicit version-checked command
and idle project; old history is retained and branch settings are not inherited. See ADR-043.


Scope scheduling authorization is an authenticated, CSRF/origin-checked owner/editor command
for an immutable map/binding/slice identity. It applies only to declared early-development rules
without unresolved decision references, never to parent acceptance, evidence or protected merge
authority. Atomic phase reservations coordinate this daemon's runs and Git commands; they do not
sandbox agents, bound host CPU, grant credentials, qualify external hosts or constrain external
processes. Native/Kata profiles remain closed until their enforcing adapters exist. See ADR-046.


Pinned dependency generations accept registered repository aliases and local refs, never a
browser-supplied command or filesystem path. Git exports reject links, submodules, unsafe names
and oversized trees, and read the exact commit through a pack fetched into a daemon-private
repository, which Git hashes on receipt, so an object rewritten in a repository's store fails the
export (R-G13); a pin's export must also hold the pin's tree. Cargo is an explicit adapter: argument arrays, no shell, same supervised
process group, controller-supplied patches and source-path verification. It records clean source
commits and toolchain observations. This detects accidental fallback under the existing trusted
OS-user model; it cannot sandbox a malicious agent or prevent deliberate absolute-path bypass.
Reviews without a successful frozen pinned-build record cannot authorize integration.

External qualification identities and independent reviewer roles are operator-reviewed
attestations, not daemon authentication of remote people/hosts. Evidence is inert bounded text,
rendered as text and scoped by workspace, definition, binding and runtime generation. Actual Kata
requires host/VM/image/configuration observations and explicit no-native-fallback evidence.
Selecting an external environment grants no credentials, host provisioning or local execution
rights. Native/Kata process dispatch remains closed; reviewed external evidence can satisfy a
verification milestone. Adoption of a map's scheduling proposals and protected final promotion remain separate.

Candidate checkpoint preparation (ADR-060) reads only the registered slice's latest successful
scoped review and frozen controller receipts. Its provenance marker is server-only; uploads
cannot manufacture it. Explicit authenticated acceptance records the operator's attestation for
every required checkpoint reviewer responsibility, separately from the supporting agent review.
Before merge, acceptance is usable only for the originating slice's exact candidate and target.
After merge, Git must confirm the reviewed tree at the recorded integration merge. Changed
relevant inputs, policy, source or review expire the evidence. Future baseline cases remain
required at their assigned slice verification; no case, native/Kata qualification, parent
acceptance or final-promotion authority is inferred from preparing this packet.


Map adoption requires an authenticated owner/editor, exact current bindings, every declared proposal ID
and a rationale; immutable records preserve attribution. It only authorizes source-declared scheduling
exceptions. Plan/architecture checkpoints still require independently reviewed evidence, and adoption
confers no environment or final-merge authority. Cross-project roadmap creation computes scope on the
daemon. Start rechecks adoption/bindings; changing target scope requires a reviewed amendment. Review-only
cycles cannot transition to implementation; they use current-generation build provenance, exact review
commits and normal workspace authorization before evidence recording. ADR-058 permits reuse across
generations only when the exact relevant inputs match, retaining original provenance. Delegated parent acceptance is
separate from protected promotion and is bound to the attempt's saved revision. Ordinary scope review
findings and questions pause for recovery; restart never silently resumes agents. See ADR-048.

Operator-designated agent reviewer responsibilities are explicit settings, bound to the attempt's
saved revision and recorded on scope receipts. They are responsibilities under the existing trusted
agent model, not authentication of a human maintainer or a sandbox qualification. The exact supervised
review run must match the assigned backend/model/permission profile and report all scope evidence.
Assignments do not bypass resource authorization, native/Kata execution boundaries or checkpoint
attestations; qualified external reviews remain available.


Planning amendments require owner/editor authority, CSRF, a current roadmap version, an exact impact
digest and an attributed rationale. Pending proposals hold workspace delegation; apply waits for affected
sessions and phase/Git reservations. Retired identities cannot launch, merge or approve receipts. Code
reuse verifies unchanged source-bound obligations, matching repository/branch and Git ancestry; no
approval transfers. Exact revised plan activation is part of the reviewed transaction. Finalization freezes
map/runtime context, uses enforcing pinned builds and rechecks authority before operator-only promotion.
Shared normalized-definition validation bounds and hashes snapshots for future authoring transports.
Publication and remote qualification remain separate evidence authorities. See ADR-049.

Local runtime discovery is an authenticated, CSRF/origin-protected owner/editor preview.
It resolves only registered repository refs and runs bounded Cargo/rustc version probes through
the existing process supervisor, with toolchain auto-installation disabled. Captured workstation,
imported source-manifest and toolchain inputs accompany their SHA-256 fingerprints. These are
local development observations, not test results, qualification attestations or execution grants.
Explicit save checks their hashes, rejects external qualification kinds for discovery captures,
and rechecks exact pin commits, binding and generation. No approval, adoption or launch occurs
through discovery. Later native/Kata evidence retains its existing independent review gates.


For the supported `STACK-PLAN-ACCEPTED` setup contract, an authenticated owner/editor can
explicitly generate an immutable package of daemon-collected saved facts. It contains no
invented reviewer identity or test results. The separate attributed operator acceptance and
rationale supply independent plan review as stack-integration-owner. Generation is bound to
the exact roadmap definition revision, map/source identities, binding, adoption, runtime and
resource settings; all are rechecked at acceptance, including after asynchronous Git checks.
The server-only generated marker is rejected by the public evidence-upload schema. Unknown
plan obligations and technical/native/Kata/publication checkpoints retain their external
independent-evidence requirements. See ADR-050.

Design recovery is an authenticated owner/editor command with CSRF/origin and cycle-version
checks. It reserves one same-design continuation on the existing idle worktree. Discovery
reads only exact bound plan versions and their preserved archives, with bounded parsing,
matching and materialization; uploaded helpers remain inert. Snapshot hashes bind the source
report, saved worktree identity, map binding, runtime and selected source hashes. Reservation
and launch recheck these facts. Supporting text is operator-supplied, not independently
verified; materialized filenames are daemon-generated. A selected recovery model retains
the design permission posture. Investigation always pauses for review and confers no
checkpoint, repository-administration, plan-amendment or merge authority.


Historical baseline preparation requires an idle design cycle, owner/editor authority, CSRF/origin,
expected version and exact binding digest. Browser input is limited to bound aliases and local Git refs;
application commits and proposed tag names are checked against the bound source plan. Tags use
create-only compare-and-swap and never overwrite, publish, protect branches or grant merge authority.
Reservations and partial failures are retained; restart requires explicit retry. Repository and worktree
mutation guards exclude concurrent daemon mutations and launches, with authority/binding rechecks.
Historical exports reject links and unsafe paths through the existing Git adapter. Run copies are
regenerated from exact objects. The historical Cargo adapter enforces original lockfiles, verifies
source hashes before/after collection, rejects path dependencies outside the prepared sources, bounds command duration/output and keeps both failures and
successes outside current verification receipts. It uses configured storage for downloads and targets.
The existing trusted OS-user boundary still applies: imported build scripts execute with agent permissions.
Historical log previews use registered run directories, fixed filenames, byte/count limits and link checks;
no browser-supplied filesystem path or command is accepted. Genuine design decisions remain operator-owned.


Scoped verification (ADR-053) never waives map requirements or treats historical builds as current
integration. `ct-check` commands originate inside an already authorized agent process, not HTTP.
Since R-G4 (2026-09-28) the agent's `ct-check` only leaves a request in its run's spool. The daemon runs
the command outside the agent's process tree, in a transient systemd user unit (read-only file system
except the worktree, the run directory and Cargo's download caches; private /tmp; no network; no new
privileges; a named environment), observes HEAD and cleanliness itself, keeps the log under
`<data>/check-logs`, and records the receipt in its database while the run is live. A run prepared this
way freezes its build record from those rows; a line written to the launcher file is not read as a
`scoped-check` receipt. The spool is agent-owned, so the daemon never follows a link or reads a FIFO
there and creates each reply file exclusively. `CRAFTINGTABLE_CHECK_CONFINEMENT=none` runs checks as a
plain process group instead (tests, or a host without a user manager). `ct-act` goes the same way: act
runs in a daemon unit with the same file-system limits plus the CI cache, network allowed (act fetches
actions itself; job containers reach Docker's network regardless), and a HOME and working directory the
daemon owns, so an agent cannot plant an `.actrc`. It refuses a workflow whose jobs declare `container`,
`services` or a reusable workflow, or use a `docker://` step, because those can bind host paths through
Docker. One act per workflow and Docker host runs at a time
through an in-daemon queue; the wait counts against the check's time limit. `ct-native` is a request
too: the daemon starts the approved native unit (ADR-054's limits, unchanged) with a HOME and TMPDIR it
owns. Pinned Cargo's build commands are requests too: the daemon checks the resolved graph and runs the
build in a confined unit, without network (fetch first), under the check time limit. For a run prepared
since R-G13's second increment, a build of a clean worktree compiles a daemon-private clone of the
committed head against daemon-private, verified checkouts of the pinned upstream commits, into a target
per commit, in a unit that sees no root agents write (as declared checks do); a build of uncommitted
work, which no gate accepts, still runs in the worktree. Such a run's current-upstream gate also needs
every adopted check, run the same way against the pins, so the agent cannot choose the whole gate: a
committed Cargo configuration other than the root `.cargo/config.toml` is refused, and each manifest
the check names must take every pinned crate from the daemon's checkouts. Finalization runs are
held to adopted checks too, and every run held to them needs them even where no build is required.
Every adopted check runs the commit's rustup-managed toolchain (a `path` toolchain is refused), with
the tree's rustc wrappers cleared, and is refused if the tree has a Cargo configuration or toolchain
file, at any depth, that the check was not adopted with. A pinned build also clears its rustflags,
builds for the host with the daemon's own `cc` and no runner, and runs Clippy directly, past any
alias. The tree's `[env]`, build scripts and procedural macros remain its own code, for the reviewer. Other Cargo commands
still run in the agent's tree and record nothing. A daemon-recorded run's build record therefore reads
no file the agent can write, and the daemon runs every check from the manifest text it verified at
launch, never the published copy. Claude runs have no OS sandbox, so for them the database itself stays
writable by the agent until R-G5's sandbox increment.
Declared checks are adopted only by a person (R-G13). An owner or editor adopts a repository's
`.craftingtable/checks.json` on the Repositories page, read by the daemon's Git at a branch or exact
commit; the preview warns when that commit is not on an integration branch of the repository, or its
definition files differ from that branch's head. Since increment 5 (operator decision 2026-09-30) a
slice that changes a definition file or the checks file is merged only by a person: the merge
approval shows the definitions the merge would adopt, and its request must name that proposal's
digest. Before any ref moves, the daemon predicts the merge's tree (`git merge-tree`) and applies every
adoption rule to it; after the merge it reads the merge commit again and records the adoption, at the
merge commit and in the merge's own transaction, only if the commit proposes exactly what was approved
(otherwise the merge stands and the refused adoption is audited). A roadmap never merges such a slice,
whatever its merge policy, and an agent never adopts. A change the operator already adopted leaves the
merge nothing to adopt. Who asked for a check (`origin`) is shown only for runs whose receipts the
daemon recorded; a run that wrote its own receipt file could claim either.
`ct-act` restricts its input to one ordinary repository workflow and optional job; host configuration
selects the local socket, image digest and storage. Rootless Docker retains ordinary user authority.
Job containers have no mounted daemon socket or implicit host credential files. These are cooperative
workflow controls, not a hostile-code sandbox. CI logs cannot replace pinned integration Cargo receipts
or native/Kata evidence. Run-owned container cleanup is label-specific and outside DB transactions;
unfinished CI collection invalidates its frozen build record.

ADR-054 adds an explicit managed native exception to the earlier closed native dispatch policy.
Authenticated, CSRF-protected approval binds daemon-collected host/toolchain observations to
an exact map binding and runtime. It never grants Kata/root-daemon authority. Commands originate
in the already supervised agent; the browser cannot supply shell commands or executable paths.
Fresh independent native evidence is required after integration. Native processes use bounded
systemd user services and minimal environment variables, with retained command provenance and
per-run cleanup; filesystem access still follows the trusted OS-user model. The separate Kata
service uses root-owned non-user-replaceable storage and a private socket. Its smoke receipt is
historical readiness, not an application pass or permission for agents to dispatch workloads.

Dependency refresh preview/apply requires owner/editor authorization and the usual CSRF/origin
checks. Apply re-inspects exact commits and rejects stale preview digests, changed bindings, live
runs, active scheduling, outstanding Git operations or finalization. It cannot invent new crate
mappings, change the captured environment, approve evidence or launch agents. An existing native
approval remains applicable across pin generations only for the same binding, host and complete
environment/fixture/toolchain/authorization inputs, with no intervening revocation. Source evidence
separately compares each consumer's exact upstream inputs; unknown scopes compare conservatively.
Old runs, manifests and receipts are never rewritten. Saved-plan acceptance always binds the new
generation, and finalization retains its strict generation gate. See ADR-058.


Controller obligation reviews (ADR-063) use the running roadmap attempt's saved responsibilities
and review profile. Technical checkpoint acceptance is attributed to the delegated agent review,
with immutable run/role/definition provenance; it is not operator architecture approval. The
server validates every checkpoint requirement/case, frozen build and current candidate, rejects
unqualified or unsupported evidence, and rechecks delegation after asynchronous inspection.
Shared decisions and final promotion retain explicit operator authority. Required security
review receipts remain merge gates even after a cycle is stopped. Unclassified questions can
cause bounded read-only reassessment, never silent approval or source mutation.

## Operational agent selections

A model-only roadmap update requires owner/editor authority, CSRF protection and the current
roadmap version. It accepts only backend, model and bounded effort values for named
entries, rejects unavailable backends and running scheduling, and writes audit/event records
atomically. It cannot edit permission postures, reviewer responsibilities, budgets, dependency
pins, gates or merge authority. Existing runs retain their launch selection and assignment ID;
review evidence matches that historical assignment rather than the latest preference. An
operator may switch the model delegated to future reviews without re-accepting unchanged plan
requirements. Final promotion still requires explicit operator approval. See ADR-064.
