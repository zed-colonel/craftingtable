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
- Claude Code uses its own login on the workstation. The daemon never handles API keys;
  it records only whether the backend reported a subscription login or an API key.
- Changing a password requires the current one and revokes every other session.

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
- `edit-only`: file edits are pre-approved, prompts are denied.
- `unrestricted`: no permission checks. The worktree is the only boundary.

None of these confine the agent to the worktree at the OS level. The brief instructs it
to stay there, and the diff makes deviations visible, but an unrestricted run has the
operator's full local authority. Treat `unrestricted` as you would running the agent by
hand.

## Untrusted input

Plan bundles, agent output, and Git output are untrusted. Plan bundles are parsed with a
bounded YAML profile and served back only as escaped text. Agent output is translated
into bounded normalized events; unknown shapes become notices, oversized values are
truncated before storage, and the browser renders event text and patches as text, never
as HTML.
