# CT-04A proposed implementation plan

Status: proposed for independent design review; not accepted for implementation

Scope: CT-04A — Trusted Git boundary and repository registration

Source baseline: `abc5f37815ad76430cae989224afde817d77a047`

Protected acceptance checksum observed during planning:
`ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`

## 1. Stage boundary

This document is the only Stage 1 write. It is a source-specific proposal, not
authorization to implement. The next action is an independent design review.
After the operator returns accepted findings, the implementer will write the
review disposition and accepted plan, then stop again for explicit permission
to commit the accepted plan. No production code may be changed before that
permission and plan commit.

CT-04A is one host-authority slice: discover, validate, register, inspect,
retire, and bind an existing local primary Git repository. It does not admit
any CT-04B-or-later execution behavior.

## 2. Checkout and baseline reconciliation

Planning was performed on branch `ct-04a-git-foundation` at
`06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`. The checkout descends directly
from the pinned baseline `abc5f37815ad76430cae989224afde817d77a047`:

```text
abc5f37  Merge CT-03: plan import and dashboard into main
06abcff  CT-04: add decomposed source-grounded package
```

`git merge-base --is-ancestor <baseline> HEAD` succeeded. The one descendant
commit adds only the CT-04 work contracts, matrices, source assessment,
guidance, process protocol, and protected specification. It does not change
the CT-03 runtime source. The initial worktree was clean.

The accepted CT-03 implementation and all three remediation/re-review rounds
were inspected. The last accepted implementation head was `195dd8d`; the
subsequent CT-03 record commit and merge form the pinned baseline. The most
important inherited constraint is that SQLite composite foreign keys use
`MATCH SIMPLE`: a nullable child column can bypass a composite parent check.
CT-04A therefore uses explicit null-coupling checks/triggers and tests every
nullable parent dimension rather than relying on a nullable composite FK.

Existing migration checksums, to remain unchanged:

```text
0001-ct02-foundation.sql
42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273

0002-ct03-planning.sql
6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247
```

## 3. Exact current seams

- `packages/git/src/index.ts` contains only the CT-01 simulated
  `RepositorySnapshot` and `GitService`. There is no real process boundary.
- `packages/testing/src/fake-git-service.ts` owns the fake implementation.
  `FakeAgentBackend` consumes it only to provide the simulated branch name.
  Production does not currently import `@craftingtable/git`.
- `packages/domain` owns branded IDs and audit/event vocabularies and has no
  infrastructure dependencies.
- `packages/contracts` depends only on domain and uses strict Zod objects for
  all public request, response, error, and event payloads.
- `packages/storage` owns SQLite, migrations, repositories, and transaction
  orchestration. Migration 0002 introduced catalog-backed audit and workspace
  event kinds plus the planning relationship pattern.
- `apps/server/src/services/*` performs authorization before authority-bearing
  side effects, writes state/audit/event in one transaction, commits, and only
  then notifies SSE listeners.
- `apps/server/src/routes/planning.ts`, `routes/http.ts`, and
  `routes/request-security.ts` are the route/authentication/CSRF patterns.
- `apps/server/src/route-inventory.test.ts` is a closed route allowlist.
- `scripts/check-forbidden-scope.mjs` currently rejects
  `node:child_process` in all production source and rejects production imports
  of the Git seam. It must be narrowed to permit only the reviewed Git package
  boundary.
- Server tests use isolated data directories and real SQLite through
  `apps/server/src/test-support.ts`; migration tests construct an accepted
  earlier schema and migrate forward.

## 4. Target dependency direction and internal interfaces

The dependency direction will be:

```text
domain
  ↑
contracts        git
  ↑               ↑
storage          server
  ↑               ↑
server ───────────┘
```

`domain` remains unaware of paths, Git, SQLite, HTTP, and process execution.
`contracts` remains unaware of Git and storage. `git` may depend only on
`domain` plus Node standard-library modules. `storage` may depend on `domain`
but not `git`. `server` composes contracts, storage, and the Git boundary.
`testing` may fake either interface for unit tests, but production will never
import it.

`@craftingtable/git` will replace the broad simulated seam with these focused
internal interfaces:

```ts
interface BoundedCommandRunner {
  run(request: FixedGitCommand): Promise<BoundedCommandResult>;
}

interface RepositoryPathPolicy {
  admit(requestedPath: string): Promise<AdmittedRepositoryPath>;
}

interface RepositoryInspector {
  inspect(path: AdmittedRepositoryPath): Promise<RepositoryInspection>;
}

interface RepositoryIdentityVerifier {
  verify(recorded: RepositoryIdentity): Promise<IdentityVerification>;
}
```

`FixedGitCommand` is a closed internal discriminated union for `version`,
`identity`, and `local-feature-names`; it is not a public `{command, argv,
env}` carrier. Only the boundary maps a variant to an executable and fixed
argument vector. User input is used as the child's `cwd` only after path
admission; it never selects a subcommand or occupies an option-bearing argv
position.

The package will export result and error types needed by composition, but will
not export the raw runner from the server's public surface. Expected failures
are discriminated as configuration, invalid path, unsupported repository
class, unavailable, identity mismatch, timeout, stdout overflow, stderr
overflow, spawn failure, unsupported Git version, and malformed Git output.
No partial stdout is interpreted after any failure.

The old simulated `GitService` and its testing-package fake stay as unchanged
legacy exports only where the CT-01 fake agent requires a branch label. They
are not used by repository registration. This avoids silently coupling an
agent simulation to the trusted host boundary or expanding CT-04A into agent
fixture cleanup.

## 5. Git executable, commands, environment, and bounds

### 5.1 Executable resolution and version

At startup, the operator-only `CRAFTINGTABLE_GIT_BIN` may name an absolute
executable. If unset, configuration scans only absolute entries in `PATH` for
`git`. The selected file is `realpath`-resolved, checked as a regular
executable, and stored as one canonical absolute path. Repository HTTP values
cannot affect it. Relative paths, path entries that are not absolute, missing
files, directories, and non-executables fail startup.

The startup probe is exactly:

```text
<canonical-git> --version
```

The parsed version must be at least Git 2.31.0, the declared floor for
`rev-parse --path-format=absolute`. Nonstandard or unparseable version output
fails startup. All subsequent invocations reuse the resolved executable.

### 5.2 Fixed repository commands

Identity inspection, with `cwd` equal to the admitted canonical top-level:

```text
<canonical-git> -c core.fsmonitor=false rev-parse \
  --path-format=absolute \
  --show-toplevel \
  --absolute-git-dir \
  --git-common-dir \
  --is-bare-repository \
  --is-inside-work-tree \
  --show-object-format=storage
```

The result must have exactly six newline-delimited fields, no extra bytes
after the final optional newline, booleans exactly `true`/`false`, and object
format exactly `sha1` or `sha256`. The three returned paths are
`realpath`-resolved and compared to the admitted path and expected `.git`.

Local external-execution feature-name inspection, with the same `cwd`:

```text
<canonical-git> -c core.fsmonitor=false config \
  --local \
  --no-includes \
  --null \
  --name-only \
  --get-regexp \
  '^(core\.hooksPath|core\.fsmonitor|diff\.external|diff\..*\.(command|textconv)|filter\..*\.(clean|smudge|process)|include\.path|includeIf\..*\.path)$'
```

Exit 0 means the NUL-delimited key names are recorded. Exit 1 with empty output
means no matches. Every other exit/result is failure. `--no-includes` prevents
included config from being followed; the presence of an include directive is
itself restrictive. Values are never fetched or executed.

These are the only Git invocations introduced by CT-04A. There is no
`status`, `diff`, `show`, `show-ref`, `fetch`, remote, branch, checkout,
worktree, commit, hook, filter, textconv, or arbitrary-command invocation.

### 5.3 Clean environment

Every Git child receives a newly constructed environment containing only:

```text
LC_ALL=C
LANG=C
GIT_TERMINAL_PROMPT=0
GIT_PAGER=cat
PAGER=cat
GIT_OPTIONAL_LOCKS=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_ATTR_NOSYSTEM=1
```

The implementation does not clone and scrub `process.env`. Consequently
inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
object-directory, namespace, config count/key/value, askpass, SSH, proxy,
credential, pager, and trace variables are absent. `HOME` is neither passed
nor repurposed. The absolute executable means the child needs no `PATH`.
`shell` is always `false`; stdin is closed; stdout and stderr are separate.

### 5.4 Deadline and output limits

Operator-only startup configuration:

| Setting | Default | Accepted range |
| --- | ---: | ---: |
| `CRAFTINGTABLE_GIT_TIMEOUT_MS` | 5000 | 100–30000 |
| `CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES` | 65536 | 1024–1048576 |
| `CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES` | 65536 | 1024–1048576 |

The limits apply independently to every version, identity, and config
invocation. Byte counters are checked before concatenation or decoding. On
deadline or either overflow, the runner stops reading as success, sends
`SIGTERM`, waits at most 250 ms, then sends `SIGKILL` if the process remains.
Completion is awaited and classified; captured partial output is diagnostic
only and never parsed. Diagnostics are truncated to the bound and do not
include environment or repository config values.

## 6. Allowed roots and path admission

`CRAFTINGTABLE_REPOSITORY_ROOTS` is a required, nonempty,
platform-`path.delimiter`-separated operator setting. Each root must:

- be absolute and already lexically normalized;
- exist as a directory;
- have no symbolic-link component;
- have `realpath(input) === input`;
- be distinct and neither equal to, an ancestor of, nor a descendant of
  another allowed root.

The data root is the canonical configured `dataDir`. Two CT-04 reserved roots
are configured in the same startup object:

- `CRAFTINGTABLE_ARTIFACT_ROOT`, default `<dataDir>/artifacts`;
- `CRAFTINGTABLE_MANAGED_WORKTREE_ROOT`, default `<dataDir>/worktrees`.

CT-04A treats these as reserved path names only; it does not create either
directory, store artifacts, or create worktrees. The artifact and
managed-worktree paths must be absolute, normalized, strict descendants of the
canonical data root, and disjoint from each other. Their existing ancestor
components are checked with `lstat` and `realpath`, and no symlink may alter
their meaning. Every allowed source root must be disjoint from the entire
data-root subtree. Configuration fails closed on any other equality or
ancestor overlap.

A registration path is admitted in this order:

1. Authorize the workspace Owner before any filesystem or Git inspection.
2. Strictly validate one string: nonempty, no NUL, at most 4096 UTF-8 bytes,
   absolute, and lexically normalized. Relative paths are rejected; there is
   no implicit current directory.
3. Walk with `lstat` from its matching allowed root through every component.
   Reject a symbolic link, missing component, or non-directory final node.
4. Resolve `realpath` and require equality with the request.
5. Require the path to be strictly below exactly one allowed root, never equal
   to it.
6. Reject equality, ancestry, or descendancy overlap with the data, artifact,
   or managed-worktree roots.
7. Run fixed identity inspection with the path as `cwd`.
8. Require returned top-level to equal the exact admitted request. A
   repository subdirectory is rejected.
9. Require non-bare and inside-work-tree.
10. Require `<top>/.git` to be a real directory, not a symlink or `.git` file,
    and require both absolute Git dir and common Git dir to equal the
    canonical `realpath(<top>/.git)`.

Step 10 admits only a primary non-bare checkout. It intentionally rejects bare
repositories, linked worktrees, submodules, `--separate-git-dir` layouts, and
other `.git` indirections. A path containing leading dashes, spaces, shell
metacharacters, or newlines is accepted if it otherwise passes because it is
never shell-interpreted or placed in argv.

Admission is run once to build the candidate and repeated in full immediately
before the storage transaction. Both snapshots must match. This closes normal
validate/use gaps without claiming that a local operator cannot race the final
check; the residual host-local race is documented as an operational trust
limit.

## 7. Repository identity, replacement, and feature policy

The durable immutable identity evidence is:

- canonical top-level path;
- canonical Git common-directory path;
- decimal-string `dev` and `ino` from `bigint` `stat` for both locations;
- Git object format (`sha1` or `sha256`);
- `sha256` digest of a versioned, length-prefixed encoding of those fields.

Stat identity is required on the supported Node/POSIX runtime. A platform that
cannot provide stable device/inode evidence is rejected at startup rather
than silently weakening policy.

An inspection repeats path admission, Git identity inspection, and stat
collection. Matching evidence is `match`. A missing/inaccessible path is
`unavailable`; it does not retire the row. A changed canonical path result,
Git/common directory, object format, device/inode evidence, or digest is
`identity-mismatch`. Mismatch is sticky and terminal except for Owner
retirement. `unavailable` may transition back to active only when the complete
recorded identity reappears. Active, unavailable, and mismatched rows continue
to reserve their paths and identities. Retirement is the explicit release.

Registration also inspects repository-local external-execution features:

- matching local config key names from the fixed command;
- any non-sample entry in `<top>/.git/hooks`, inspected with `lstat` and a
  maximum of 256 directory entries.

No hook content or config value is read. If neither is present, policy is
`no-known-external-execution`. If any is present, registration is permitted
but policy is `later-mutation-blocked`, with sorted feature-name categories
stored in a strict JSON array. CT-04A is read-only and never activates these
features. Any future mutating slice must re-inspect, explicitly review or
reject the restrictive state, and cannot treat the registration snapshot as a
permanent safety claim.

## 8. Domain records and wire contracts

New branded IDs:

- `RepositoryId`
- `ProjectRepositoryBindingId`

New domain records/enums:

- `RegisteredRepository`
- `RepositoryIdentity`
- `RepositoryStatus`: `active | unavailable | identity-mismatch | retired`
- `RepositoryExternalExecutionPolicy`:
  `no-known-external-execution | later-mutation-blocked`
- `ProjectRepositoryBinding`
- `RepositoryInspectionOutcome`

No domain record contains `Stats`, `Buffer`, SQLite rows, HTTP status, or child
process types.

Strict public contracts:

- `RegisterRepositoryRequest`: `{ path: string; displayName?: string }`
- `RepositoryResponse` and `RepositoryListResponse`
- `RepositoryInspectionResponse`
- `BindProjectRepositoryRequest`: `{ repositoryId }`
- `ProjectRepositoryBindingResponse`
- strict event payloads for `repository-registered`,
  `repository-status-changed`, and `project-repository-bound`

Unknown keys are rejected at every object level. In particular registration
rejects `command`, `argv`, `env`, `cwd`, `gitDir`, `worktree`, `branch`,
`remote`, and nested variants rather than ignoring them. The existing common
error contract gains only typed repository failure codes needed to distinguish
invalid path (400), identity/conflict (409), and bounded Git/unavailable
failure (503); authentication/authorization semantics remain unchanged.

Proposed routes:

```text
POST /api/workspaces/:workspaceId/repositories
GET  /api/workspaces/:workspaceId/repositories
GET  /api/workspaces/:workspaceId/repositories/:repositoryId
POST /api/workspaces/:workspaceId/repositories/:repositoryId/inspect
POST /api/workspaces/:workspaceId/repositories/:repositoryId/retire
GET  /api/workspaces/:workspaceId/projects/:projectId/repository-binding
PUT  /api/workspaces/:workspaceId/projects/:projectId/repository-binding
```

There is no browser UI in CT-04A.

## 9. Migration 0003

`0003-ct04a-repositories.sql` will preserve migrations 0001/0002 byte-for-byte
and add catalog entries plus these tables.

### 9.1 `registered_repositories`

Columns:

```text
id, workspace_id, display_name,
canonical_top_level, canonical_git_common_dir,
top_device, top_inode, common_device, common_inode,
git_object_format, identity_digest, identity_policy_version,
status, status_reason,
registered_by_user_id, registered_at,
status_changed_by_user_id, status_changed_at,
version
```

Guarantees:

- primary key `id`;
- `UNIQUE(workspace_id, id)` for composite ownership children;
- checks for nonempty canonical absolute-path strings, decimal stat strings,
  64-lowercase-hex digest, object format, policy version, status/reason
  coupling, actor/time coupling, and positive version;
- plain existence and composite membership FKs for actor IDs;
- global partial unique indexes on canonical top-level, common Git directory,
  and identity digest where status is not `retired`;
- triggers permitting only:
  `active -> unavailable`, `unavailable -> active`,
  `active|unavailable -> identity-mismatch`, and
  `active|unavailable|identity-mismatch -> retired`;
- identity, workspace, registration actor/time, and repository ID are
  immutable; no delete trigger permits erasure.

### 9.2 `repository_policies`

Columns:

```text
workspace_id, repository_id, policy_version,
external_execution_policy, detected_features_json, inspected_at
```

The composite primary key is `(workspace_id, repository_id)`, with a composite
FK to the repository. A JSON-validity/shape trigger plus storage parsing
requires a sorted unique string array; policy and empty/nonempty feature list
must agree. The row is immutable and non-deletable. It is registration-time
evidence, not authorization for future mutation.

### 9.3 `project_repository_bindings`

Columns:

```text
id, workspace_id, project_id, repository_id,
status, bound_by_user_id, bound_at,
retired_by_user_id, retired_at, version
```

Guarantees:

- primary key `id`;
- `UNIQUE(workspace_id, id)`;
- composite FKs `(workspace_id, project_id)` and
  `(workspace_id, repository_id)`;
- plain existence plus composite membership FKs for both actor columns;
- partial unique index allowing at most one active binding per project;
- insert trigger requires an active repository;
- explicit checks couple `retired_by_user_id` and `retired_at` to retired
  status, closing the nullable-composite-FK hole;
- only `active -> retired` is allowed; ownership and target IDs are immutable;
  deletion is forbidden.

Binding the same repository to the same project is idempotent. Binding a
different repository while an active binding exists returns conflict. There
is no implicit replace or unbind. Owner repository retirement atomically
retires its active bindings; a later explicit registration/bind creates new
records.

### 9.4 Catalog additions

Audit actions:

```text
repository.register
repository.inspect
repository.identity-mismatch
repository.unavailable
repository.available
repository.retire
repository.bind-project
```

Workspace event kinds:

```text
repository-registered
repository-status-changed
project-repository-bound
```

The event IDs are carried in strict payloads; project-binding events also use
the existing structural `project_id` correlation. Migration 0003 does not
rebuild the append-only `workspace_events` journal merely to add nullable
correlation columns. Catalog immutability triggers continue to protect old and
new values.

The forward-migration test will create a real accepted schema-2 database,
insert users/workspaces/memberships/planning rows/audit/events with meaningful
sequence values, apply only migration 0003, and prove all rows, sequences,
indexes, triggers, and old/new catalogs remain valid. Fresh migration and
checksum/tamper tests remain in the deterministic gate.

## 10. Authorization and information disclosure

| Operation | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Register host path | yes | 403 before filesystem/Git | 403 before filesystem/Git |
| List/read stored repository state | yes | yes | yes |
| Inspect/reinspect host path | yes | yes | 403 before filesystem/Git |
| Bind active repository to project | yes | yes | 403 |
| Retire repository | yes | 403 | 403 |

Every operation first resolves authenticated membership without touching the
host. Missing workspace/resource and a resource owned by a workspace in which
the caller is not a member both use the existing indistinguishable 404. A
known member with insufficient role gets 403. Cross-workspace repository and
project IDs are never disclosed by conflict details. List/read operations use
stored evidence and do not inspect host paths.

## 11. Command, transaction, audit, event, and notifier ordering

Registration:

```text
authenticate -> authorize Owner -> strict request/path validation
-> inspect candidate -> inspect candidate again
-> transaction(recheck duplicate; repository + policy + audit + event)
-> commit -> notifier
```

Validation/Git failure creates no row, success audit, success event, or
notification. A database rollback calls no notifier.

Explicit inspection or pre-bind verification:

```text
authenticate -> authorize -> load stored record -> host verification
-> transaction(re-read record; update status if changed + audit + event)
-> commit -> notifier only when an event was appended
```

An unchanged inspection records `repository.inspect` audit in a transaction
but appends no state-change event and sends no notifier. If bind verification
finds unavailable/mismatch, that status transition/audit/event commits first,
notifies, and the binding is rejected. The rejected binding itself creates no
success journal entry.

Binding:

```text
authenticate -> authorize Owner/Editor -> load project and repository
-> verify identity -> transaction(re-read both; insert/idempotency check
   + audit + event) -> commit -> notifier
```

Retirement:

```text
authenticate -> authorize Owner -> transaction(re-read; retire bindings;
   retire repository + audit + status event) -> commit -> notifier
```

An already-retired request is idempotent and emits no duplicate event. SSE
remains a notification optimization: a missed notifier is recovered by the
durable workspace-event query, and existing workspace membership filtering
prevents cross-workspace replay.

## 12. Real Git fixtures and fault fixtures

`@craftingtable/git` tests will use temporary directories and the same resolved
real Git executable to create:

- a primary non-bare repository with a commit;
- SHA-1 and, where the installed Git supports it, SHA-256 repositories;
- a bare repository;
- a linked worktree;
- a repository subdirectory;
- a `--separate-git-dir` checkout;
- a symlink component;
- valid top-level names containing a leading dash, spaces, metacharacters, and
  a newline;
- local fsmonitor/filter/diff/textconv/include config names;
- a non-sample hook entry;
- unavailable and in-place replacement cases.

Fixture setup may use real mutating Git commands only inside its own fresh
temporary directory. The production inspector uses only the fixed read
commands above. Tests skip only the optional SHA-256 variant if the installed
Git explicitly lacks it; all required primary-repository cases remain
mandatory.

A purpose-built fake executable is used only for process-control faults that
real Git cannot deterministically produce: stdout overflow, stderr overflow,
hang/timeout, prompt attempt, signal handling, malformed output, exit codes,
and environment capture. It verifies that inherited Git overrides are absent.
No mock substitutes for real repository-class or identity semantics.

## 13. Exact target file tree

The implementation is expected to touch the following source-specific tree.
Files marked `+` are new; `~` are modified. Independent review may reduce this
set, but implementation must not expand it without reconciling the accepted
plan.

```text
~ README.md
~ CLAUDE.md
~ pnpm-lock.yaml
~ scripts/check-forbidden-scope.mjs
~ scripts/check-forbidden-scope.test.mjs

~ docs/architecture.md
~ docs/security.md
~ docs/operations.md
~ docs/decisions/README.md
+ docs/decisions/ADR-016-trusted-local-git-boundary.md
+ docs/decisions/ADR-017-repository-identity-and-registration.md

~ packages/domain/src/ids.ts
~ packages/domain/src/ids.test.ts
~ packages/domain/src/audit.ts
~ packages/domain/src/event-kinds.ts
~ packages/domain/src/event-kinds.test.ts
~ packages/domain/src/workspace-events.ts
~ packages/domain/src/workspace-events.test.ts
~ packages/domain/src/index.ts
+ packages/domain/src/repository.ts
+ packages/domain/src/repository.test.ts

~ packages/contracts/src/ids.ts
~ packages/contracts/src/auth.ts
~ packages/contracts/src/auth.test.ts
~ packages/contracts/src/workspace-event.ts
~ packages/contracts/src/workspace-event.test.ts
~ packages/contracts/src/index.ts
+ packages/contracts/src/repository.ts
+ packages/contracts/src/repository.test.ts

~ packages/git/src/index.ts
+ packages/git/src/command-runner.ts
+ packages/git/src/command-runner.test.ts
+ packages/git/src/path-policy.ts
+ packages/git/src/repository-inspector.ts
+ packages/git/src/repository-inspector.test.ts
+ packages/git/src/test-support.ts

+ packages/storage/migrations/0003-ct04a-repositories.sql
~ packages/storage/src/migrations.ts
~ packages/storage/src/storage.ts
~ packages/storage/src/types.ts
~ packages/storage/src/index.ts
+ packages/storage/src/repositories/repository-registry/index.ts
+ packages/storage/src/migration-0003.test.ts
+ packages/storage/src/repository-schema.test.ts
+ packages/storage/src/repository-repositories.test.ts
+ packages/storage/src/repository-transactions.test.ts
+ packages/storage/src/repository-test-support.ts

~ apps/server/package.json
~ apps/server/tsconfig.json
~ apps/server/src/config.ts
~ apps/server/src/config.test.ts
~ apps/server/src/composition.ts
~ apps/server/src/server.ts
~ apps/server/src/test-support.ts
~ apps/server/src/e2e-entry.ts
~ apps/server/src/route-inventory.test.ts
~ apps/server/src/services/errors.ts
+ apps/server/src/routes/repositories.ts
+ apps/server/src/services/repository-service.ts
+ apps/server/src/server-repositories.test.ts
```

Predicted scope is 60 changed/new files and approximately 4,500–6,000 lines
including tests and documentation. Although it crosses five packages, it is
one cohesive authority boundary with one production process implementation
and no browser surface. If accepted review requires materially more than 60
files or a second authority, stop and re-slice rather than expand silently.

## 14. Acceptance, adversarial, and protected case map

Each protected CT-04A case is listed individually. The permanent test names
below are target locations; equivalent source-specific consolidation is
allowed only if the accepted plan records it.

| ID | Permanent proof |
| --- | --- |
| REG-PATH-001 | `server-repositories.test.ts`: Owner registers a real canonical primary repository once and reads immutable identity. |
| REG-PATH-002 | `server-repositories.test.ts`: Editor receives 403 and spy inspector has zero calls. |
| REG-PATH-003 | `repository-inspector.test.ts`: relative input fails before runner invocation. |
| REG-PATH-004 | `repository-inspector.test.ts` plus server journal case: nonexistent path yields no runner, row, audit, event, or notify. |
| REG-PATH-005 | `repository-inspector.test.ts`: canonical directory outside every allowed root is rejected. |
| REG-PATH-006 | `repository-inspector.test.ts`: real repository subdirectory is rejected because returned top-level differs. |
| REG-PATH-007 | `repository-inspector.test.ts`: real bare repository is rejected. |
| REG-PATH-008 | `repository-inspector.test.ts`: real linked worktree and `.git` file are rejected. |
| REG-PATH-009 | `repository-inspector.test.ts`: managed-worktree-root equality/descendant/ancestor overlap is rejected. |
| REG-PATH-010 | `config.test.ts` and `repository-inspector.test.ts`: data/artifact equality and both overlap directions are rejected. |
| REG-PATH-011 | `repository-inspector.test.ts`: symlink at each component position is rejected by the declared no-symlink policy. |
| REG-PATH-012 | `repository-inspector.test.ts`: metacharacter/newline/leading-dash top-level succeeds as one `cwd`, with no shell. |
| REG-ID-001 | `server-repositories.test.ts`: unchanged real repository reinspects as match without identity mutation. |
| REG-ID-002 | `server-repositories.test.ts`: replaced path becomes sticky identity-mismatch and bind is blocked. |
| REG-ID-003 | `repository-schema.test.ts`: global active identity/path uniqueness rejects a second workspace directly. |
| REG-ID-004 | `server-repositories.test.ts`: duplicate same-workspace registration is idempotent, with one active row/event. |
| REG-ID-005 | `server-repositories.test.ts`: missing path transitions to unavailable, not retired. |
| REG-ID-006 | `repository-inspector.test.ts`: changed common Git directory fails identity verification. |
| REG-ID-007 | `repository-inspector.test.ts`: changed device/inode evidence fails under the required POSIX policy. |
| REG-ID-008 | `repository-inspector.test.ts`: config/hook features produce recorded `later-mutation-blocked` state and no execution. |
| REG-GIT-001 | `command-runner.test.ts`: each fixed command returns a structured bounded result. |
| REG-GIT-002 | `repository-inspector.test.ts`: leading-dash user path remains `cwd` and cannot alter argv. |
| REG-GIT-003 | `command-runner.test.ts`: inherited `GIT_DIR`/`GIT_WORK_TREE` and config overrides are absent; intended cwd wins. |
| REG-GIT-004 | `command-runner.test.ts`: fake credential prompt sees closed stdin/disabled prompt and fails within deadline. |
| REG-GIT-005 | `command-runner.test.ts`: stdout overflow terminates and cannot parse partial success. |
| REG-GIT-006 | `command-runner.test.ts`: stderr overflow is independently classified and terminated. |
| REG-GIT-007 | `command-runner.test.ts`: hung process receives TERM/KILL and is classified timeout. |
| REG-GIT-008 | `repository.test.ts`: strict HTTP schema rejects command/argv/env/cwd/worktree/remote fields. |
| OWN-REP-001 | `server-repositories.test.ts`: Owner/Editor binds same-workspace active repository and project. |
| OWN-REP-002 | `server-repositories.test.ts`: foreign-workspace repository/project combination is indistinguishable 404. |
| OWN-REP-003 | `server-repositories.test.ts`: same-workspace missing project is rejected without binding journal. |
| OWN-REP-004 | `repository-schema.test.ts`: direct cross-workspace binding fails composite FK/trigger. |
| OWN-REP-005 | `server-repositories.test.ts`: Viewer bind returns 403. |
| OWN-REP-006 | `server-repositories.test.ts`: nonmember repository read matches missing 404 body/status. |
| JRN-REP-001 | `server-repositories.test.ts`: registration state, audit, and event are atomic; notifier occurs after commit. |
| JRN-REP-002 | `server-repositories.test.ts`: pretransaction validation failure leaves no success artifacts. |
| JRN-REP-003 | `repository-transactions.test.ts`: forced rollback suppresses notifier and all writes. |
| JRN-REP-004 | `server-repositories.test.ts`: dropped notify still replays durable event on polling/reconnect. |
| JRN-REP-005 | `server-repositories.test.ts`: cross-workspace reader cannot query or replay event. |
| A-API-001 | `repository.test.ts`: unknown authority-bearing request fields are rejected strictly. |
| A-MIG-001 | `migration-0003.test.ts`: accepted schema 2 migrates with all rows, sequences, triggers, and catalogs preserved. |
| A-NOTIFY-001 | `server-repositories.test.ts`: post-commit registration notification reaches SSE before fallback poll. |
| A-ROLE-001 | `server-repositories.test.ts`: only Owner introduces a host path; Editor and Viewer cause zero inspection. |
| A-DOC-001 | README/CLAUDE/doc assertion plus review: active references say CT-04A/accepted CT-03, not CT-02. |
| P-PROCESS-001 | After review, accepted plan is created, operator-approved, and committed before the first code commit. |
| P-PROCESS-002 | Independent findings and every disposition are recorded before implementation. |
| P-PROCESS-003 | Completion report records the real stable implementation head only after it exists, otherwise an explicit operator placeholder. |
| P-PROCESS-004 | Gate compares protected spec to the observed SHA-256 and proves no diff from baseline. |

## 15. Invariant-completeness pass

### 15.1 Every new child/parent relationship

Permanent storage and service tests will cover:

| Relationship | Same parent | Cross workspace | Same workspace, wrong parent | Missing parent | Optional/NULL |
| --- | --- | --- | --- | --- | --- |
| repository → workspace | register succeeds | global identity cannot be re-owned | wrong workspace lookup is 404 | FK rejects | workspace never nullable |
| repository actor → membership | Owner succeeds | composite FK/service 404 | user exists but lacks membership is rejected | missing user rejected | status actor/time pair both null or both present |
| policy → repository | same composite owner succeeds | composite FK rejects | wrong repository rejected | missing repository rejected | neither key nullable |
| binding → project | same workspace succeeds | composite FK/service 404 | another same-workspace project is a distinct valid parent, unknown requested project fails | FK rejects | never nullable |
| binding → repository | active same-workspace succeeds | composite FK/service 404 | wrong repository is conflict, not silent replacement | FK rejects | never nullable |
| binding actor → membership | Owner/Editor succeeds | composite FK rejects | same workspace nonmember rejected | missing user rejected | retirement actor/time null-coupled |
| event → workspace/project | same workspace event/query succeeds | storage/service isolation rejects | project correlation must belong to event workspace | missing project rejects where present | repository events without project use the existing legal NULL project dimension |

This explicitly tests the CT-03 `MATCH SIMPLE` trap: every optional actor/time or
event-project dimension gets both legal all-NULL and illegal partially-NULL
cases, and no nullable composite FK is treated as sufficient validation.

### 15.2 Every host path

- canonical exact top-level under exactly one allowed root: accepted;
- outside root, equal root, relative, missing: rejected;
- symlink in allowed root, intermediate component, final component, `.git`, or
  reserved root: rejected;
- replacement between first and second inspection: rejected before commit;
- replacement after registration: unavailable or identity-mismatch, never
  silently rebound;
- equality/ancestor/descendant overlap with data, artifact, and managed
  worktree roots: startup or registration rejection;
- exact primary top-level: accepted;
- subdirectory, bare repository, linked worktree, submodule, separate Git
  directory: rejected.

### 15.3 Every Git invocation

The startup version, identity, and local-feature commands each share runner
tests proving:

- user values beginning with `-` never enter command selection or argv;
- inherited Git/config/worktree/index/askpass/SSH overrides are absent;
- independent stdout and stderr overflow terminates with no partial success;
- deadline terminates and classifies;
- stdin is closed and terminal prompting is disabled.

Identity and feature parsing add exact field/NUL framing tests, nonzero exits,
invalid UTF-8, and extra-output rejection.

## 16. Documentation and architectural decisions

- ADR-016 records the absolute executable, three fixed Git commands, clean
  environment, no-shell rule, bounds, process termination, local-feature
  inspection, and no remote access.
- ADR-017 records root admission, primary-checkout-only policy, immutable
  identity evidence, global uniqueness, unavailable/mismatch/retired states,
  binding lifecycle, and replacement policy.
- `docs/architecture.md` records the new dependency direction and daemon
  authority.
- `docs/security.md` records host-path authorization, symlink/TOCTOU limits,
  external-execution restrictive state, environment isolation, and
  missing-versus-forbidden behavior.
- `docs/operations.md` records every environment variable, Git floor, reserved
  directories, time/output bounds, status recovery, and migration 0003.
- `README.md` and the noncanonical `CLAUDE.md` bridge identify accepted CT-03
  as the inherited implementation and CT-04A as the active slice. The work
  contract and protected files are not edited.

## 17. Deterministic verification planned for Stage 2

The exact final commands will be fixed in the accepted plan after review and
only commands actually run will appear in the completion report. The proposed
gate is:

```text
corepack pnpm install --frozen-lockfile
pnpm check
pnpm --filter @craftingtable/git test
pnpm --filter @craftingtable/storage test
pnpm --filter @craftingtable/server test
node --test scripts/check-forbidden-scope.test.mjs
sha256sum protected/CT-04-protected-acceptance-spec.yaml
git diff --exit-code abc5f37815ad76430cae989224afde817d77a047 -- protected/CT-04-protected-acceptance-spec.yaml
git status --short
```

The Git-package test command contains the real temporary-Git fixtures. The
scope checker will allow `node:child_process` only in reviewed
`packages/git` source/test support, allow `apps/server` to import the typed Git
package, and continue rejecting child-process imports elsewhere, production
imports of testing fakes, arbitrary process routes, remote Git, branch/worktree
mutation, Exo Stack runtime dependencies, agent/check/review/merge routes, and
CT-04B nouns in the CT-04A route inventory.

## 18. Explicit forbidden-scope confirmation

This proposal implements no change request, target ref, branch creation or
mutation, checkout, commit, merge, linked or managed worktree, diff or patch
generation, artifact store, artifact ingestion, agent execution, arbitrary
process execution, verification/check/review/readiness workflow, remote Git
operation, fetch/push/pull, hosted provider integration, ActionQueue,
WorldInterface, Exoskeleton, or Observatory dependency.

CT-04A creates no repository-side file or directory. The only production child
process is the bounded local Git inspector with the three fixed read-only
commands listed above.

Implementation must stop and seek direction if independent review or coding
would require CT-04B-or-later behavior, a new major dependency/framework,
another process authority, or expansion beyond the accepted file/scope
budget.
