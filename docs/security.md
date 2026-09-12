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
