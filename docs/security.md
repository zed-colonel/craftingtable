# Security model (accepted CT-03 plus CT-04A2b1 foundation)

CraftingTable is authenticated but remains loopback-only. Authentication does
not make LAN exposure safe; TLS and deployment hardening remain CT-08.

## Secrets and credentials

- Bootstrap is interactive and refuses password arguments. There is no
  registration endpoint.
- Passwords are Argon2id hashes at rest.
- Session cookies contain a 256-bit random token; SQLite stores only SHA-256.
- CSRF tokens are session-bound and sent only in authenticated JSON responses
  and the custom mutation header.
- Logs redact cookie, authorization, and set-cookie headers. Error responses
  are generic. Audit metadata uses explicit allowlists and excludes passwords,
  tokens, cookies, and request bodies.

## Request controls

- Cookies are `HttpOnly`, `SameSite=Strict`, `Path=/`, explicitly expiring,
  and `Secure` for HTTPS origins.
- Login accepts JSON only and rejects cross-site origin/fetch metadata.
- Logout and session revocation require exact same-origin policy plus a
  timing-safe CSRF comparison.
- Every workspace snapshot, audit query, and event stream performs
  service-layer membership authorization. Missing and unauthorized workspaces
  return the same public response.
- Sessions are server-side, expiring, revocable records. Stream loops
  revalidate sessions and membership.

## Untrusted planning input

Imported planning files are untrusted. The importer:

- accepts only an authenticated multipart request from an Owner or Editor, with
  a session-bound CSRF token and the existing origin/fetch-metadata policy;
- bounds the request at 12 files, 2 MiB per file, and 8 MiB total, and never
  buffers past those limits;
- treats the multipart field name as the artifact role, so a role is never
  inferred from a filename or from prose;
- derives the canonical media type from a validated extension, and rejects any
  filename containing a path separator, control character, traversal segment, or
  character outside `[A-Za-z0-9._-]`;
- parses YAML with the 1.2 core schema, no custom tags, unique keys, and a
  bounded alias count, treating any parser error *or warning* as fatal;
- rebuilds parsed output as provably JSON-serialisable data with bounded depth
  and node count, rejecting `__proto__`, `constructor`, and `prototype` keys;
- verifies any submitted checksum manifest against the submitted bytes.

Source artifacts are served as `text/plain; charset=utf-8` attachments with
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src
'none'; sandbox`, regardless of the stored media type. The browser renders them
as escaped text inside `<pre>`; there is no Markdown renderer, no
`dangerouslySetInnerHTML`, and no remote content loading.

ZIP archives, host filesystem paths, and external URLs are not accepted as plan
sources, and no route accepts a path, URL, shell string, or archive.

## Local Git inspection

CT-04A1 does not add a route. Its uncomposed library accepts repository paths
only from a future trusted service and applies these controls:

- source and reserved roots are explicit, canonical, symlink-free, and
  pairwise non-overlapping;
- a request must be an exact primary checkout strictly below one source root;
- symlinked path components, linked worktrees, bare repositories, separate Git
  directories, ownership mismatch, unsupported extensions, and layout
  replacement are refused;
- effective UID 0 is unsupported, and no `safe.directory` escape exists;
- the executable is absolute, canonical, executable, versioned, and
  revalidated before every spawn;
- argv comes from three closed variants, `shell` is false, stdin is closed, and
  no user value becomes an option or command;
- child environments contain only the ten fixed locale/prompt/pager/lock/config
  fields, plus a per-repository discovery ceiling;
- stdout, stderr, per-command lifetime, and total inspection lifetime are
  bounded without exposing raw diagnostics.

The risk scan records names from one literal local-config regex plus hook
presence. It reads no config value or hook content and says
`no-signals-in-scanned-set`, never “safe repository.” Alias, merge driver,
credential, SSH, template, upload-pack, alternate-ref, editor, signing,
trailer, submodule-update, attributes, include-target, and hook-content
surfaces remain outside this read-only scan because the A1 commands cannot
invoke them. Any future mutation requires a newly reviewed policy.

The boundary does not defend against root, a mount administrator, or a
malicious concurrent local owner. Postflight detects structural and inode
replacement, not same-inode content edits. A detached child orphaned by a hard
daemon kill has no claimed lifetime bound; later mutating work cannot inherit
that assumption.

## Planning authorization and retention

- Every planning read and write authorizes workspace membership in the service
  layer. Import and admission additionally require Owner or Editor.
- Ownership is enforced by the schema, not only by queries. Composite foreign
  keys tie each record to its parent's `(workspace_id, id)` and, where a chain
  exists, to `(project_id, id)` or `(plan_version_id, id)`. A project cannot
  point its active version at another project's or another workspace's plan, a
  work item cannot be reassigned to a project that does not own its version, and
  a workspace event cannot correlate to a foreign project or work item.
- Ownership keys are coherent, not merely workspace-scoped. Evidence must name
  the version its import attempt actually resolved to, and a workspace event
  correlating both a project and a work item must describe the same project
  graph. Same-workspace cross-project mixtures are rejected by the database.
- Imported planning content is immutable. Plan versions, artifacts, drafts,
  import attempts, diagnostics, and dependency edges reject update and delete
  outright; a work item accepts only the single proposed-to-admitted transition,
  carrying its actor attribution and exactly one version increment, and is
  terminal afterwards. Its controller version cannot be changed on its own, so
  audit attribution cannot be fabricated ahead of a later admission. Rewriting an already-imported plan version is
  impossible without creating a new version.
- A non-member receives the same 404 a missing resource does. A member with an
  insufficient role receives 403, since the workspace's existence is not secret
  from them.
- Artifact retrieval resolves ownership through parent joins, never through the
  workspace route parameter alone.
- Audit metadata for planning commands is built from an allowlist of derived
  counts and identifiers. It never contains source artifacts, cookies, tokens,
  or headers.
- Artifacts from a **failed** validation attempt are retained so the failure
  stays diagnosable. They carry no plan version and are reachable only through
  authorized diagnostics views. There is no retention or deletion feature yet;
  a future work item must decide one.

## Repository evidence and disclosure

- A2a adds no filesystem, Git, process, route, notifier, or browser authority.
  A scope gate scans its production and test sources for those imports.
- Global partial unique indexes reserve each non-retired canonical top level,
  common Git directory, and core fingerprint. A collision in another workspace
  returns only `identity-reserved-elsewhere`, with no foreign ID, workspace,
  path, or fingerprint.
- Reader contracts expose canonical top level, object format, and core
  fingerprint. Canonical Git and common-Git directories exist only in a
  separate Owner-only administrative contract for A2b to authorize.
- Exact stored observation bytes and their digest detect accidental corruption;
  they do not authenticate a hostile database writer. Normalized failure
  evidence is scalar-only, deterministic, and bounded.
- Repository `active` and binding `active` are persistence states. They do not
  mean ready, executable, approved, reviewed, verified, mergeable, or safe.
- Archived workspaces and revoked membership rows remain structurally valid
  history. Their foreign keys do not authorize a new action; A2b must require
  current workspace and role state before invoking any repository mutation.
- Schema 4 correlates repository journal rows through composite workspace
  foreign keys. The database proves ownership, while strict Zod contracts,
  append assertions, and fail-closed row mapping prove semantic agreement.
  Payload JSON contains display and lifecycle summaries only: no raw
  observation, Git directory, command output, environment, error evidence, or
  readiness claim.
- Repository display names are rendered as React text children. Activity
  descriptions use no raw HTML and make no ready, verified, reviewed,
  approved, executable, mergeable, or safe claim.

## Remaining boundary

The composed product exposes no shell, SQL, filesystem, process-control, Git,
agent, or verification endpoint. CT-04A1's process authority and A2a's
repository persistence remain private and uncomposed. B1 adds durable
correlation and bounded browser invalidation vocabulary, but no repository
service, route, command, notifier producer, fetch, or view. A work-contract draft is
data, not authority: it carries
no field that can be read as approval, and nothing in the system can approve,
execute, or merge it. Users, memberships, and roles establish only a future
schema seam; the product does not yet activate collaborative account
administration.
