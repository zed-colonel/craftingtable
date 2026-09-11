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
  agent never holds merge authority; a review agent only produces the verdict the
  operator acts on.

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
Review approval requires a clean managed branch at the recorded commit; operator merge
rechecks it and pins the Git source commit. A shared daemon guard keeps agent launches
and cycle resumes out of an in-flight merge or removal. Only the operator merge route
has merge authority; quality thresholds never grant it to the controller or an agent.

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

## Delegated sequential roadmaps

Saving a roadmap does not delegate execution. Start/resume are owner/editor commands
with the normal authenticated session, CSRF, and origin checks. The daemon rechecks the
recorded delegating user's active account and workspace membership before preparing a
worktree; each cycle retains its own existing launch checks. Internal admission, worktree,
and cycle commands accept a user-attributed command context without inventing a browser
session. HTTP routes still require authenticated sessions. Merge remains exclusively an
operator command. Pause/stop supersede pending preparation; a Git operation already in
flight may finish creating a recorded worktree, but cannot launch a superseded cycle.
