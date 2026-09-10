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
- a worktree to merge, optionally with a target branch name. The daemon validates the
  name, refuses unless that worktree's most recent run is a review whose final message
  carried a `mergeable` verdict and no run is live in it, and performs the merge in a
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
