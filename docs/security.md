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

Process authority is confined to three modules listed in
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
list bind each checkpoint; hooks run normally and unexpected drift stops advancement.
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

Parallel scheduling retains the same authority checks and review-gated merge command. Item
controls use authenticated, version-checked roadmap commands. Automatic integration refresh
requires an active parallel or automatic-integration delegation, the frozen branch binding, current initiating-user
permissions, and no live sessions. It merges integration into the item branch only. Review
context is invalidated durably before mutation; each refresh uses the repository and worktree
guards and rechecks delegation before Git and before reserving another review. Pause/stop
can supersede an in-flight update without permitting a late agent launch. Exclusion groups
and capacities coordinate daemon work; they do not constrain arbitrary external Git processes
or an agent running with the operator's OS authority.

## Integration resolution authority

An explicit owner/editor cycle command or saved roadmap conflict policy authorizes a pinned integration merge into the item
branch. Resolution agents edit, stage and verify; they receive no final-merge authority.
The controller checks HEAD, MERGE_HEAD, resolved index, staged tree and absence of unknown
files before completing a reserved two-parent commit. Normal source/target review freshness
and the configured integration merge authority still apply. While a resolution owns the worktree, unrelated
launches and branch mutations are rejected even while paused. Browser guidance addresses
only the existing owned run. Abandonment requires an explicit UI confirmation, aborts only
the recorded pending merge and never deletes arbitrary untracked files. Git hooks and
external tools still execute with the existing workstation trust model; these guards do
not sandbox an agent or external Git process. See ADR-032.


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
and oversized trees. Cargo is an explicit adapter: argument arrays, no shell, same supervised
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
verification milestone. Map decision adoption and protected final promotion remain separate.
