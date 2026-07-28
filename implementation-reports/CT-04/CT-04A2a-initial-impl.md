# CT-04A2a Initial Implementation Report

**Work item:** CT-04A2a — Repository domain, evidence model, and persistence
**Parent:** CT-04A2 — Repository registry and project binding
**Accepted plan:** `work-items/CT-04/CT-04A2a-accepted-implementation-plan.md`
**Accepted-plan SHA-256:** `e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747`
**Planning/review commit and implementation base:** `3f31aca7e43c502b58385e73e38f64e24d6908df`
**Accepted A1 runtime head:** `7313e81a56c0188574c436322d7fedc16e08bb70`
**Implementation head for independent review:** `e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`
**Protected-package commit:** `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
**Status:** initial implementation complete; deterministic, focused, scope, protected,
and browser gates pass; awaiting independent review

## 1. Summary

CT-04A2a adds the authority-free repository domain, public contract shapes, schema 3,
immutable inspection evidence, repository state persistence, environmental-baseline
adoption, and project-repository binding persistence.

```text
pure repository vocabulary + reducer
  → strict reader/administrative/mutation contracts
  → exact observation bytes + SHA-256 + bounded projections
  → immutable globally ordered inspections
  → trigger-guarded repository and binding lifecycles
```

The implementation commit contains 36 changed/new files, 5,079 insertions, and 40
deletions. The accepted plan predicted approximately 35 files. The one-file difference
is `apps/server/src/cli.test.ts`: schema 3 made its old literal future version collide
with the now-supported version, so the test fixture advances from 3 to 4. Both server
changes are tests; there is no server production change. The result remains below the
accepted 45-file replanning threshold.

There is one new migration and no new dependency. No A2 protected file or old migration
was edited.

## 2. Authority and dependency boundary

A2a production and test source does not import:

```text
@craftingtable/git
node:child_process or child_process
Fastify or @fastify/*
server production composition
routes
workspace event vocabulary
notifier code
React, @craftingtable/web, or browser code
```

The A2a-specific scope rule scans domain, contracts, storage repositories, support
surface, and tests. It also rejects literal current-migration assertions in server tests.
Domain owns copied durable vocabulary; it does not import A1. Domain-to-A1 package-root
parity and all Git adaptation remain A2b.

No Git subcommand, process execution, filesystem inspection, HTTP endpoint, browser
projection, or notification path was introduced.

## 3. Domain and reducer inventory

`packages/domain/src/repository.ts` adds:

- `RepositoryId`, `RepositoryInspectionId`, and `ProjectRepositoryBindingId`;
- six repository statuses and their exact status/reason coupling;
- registration, verification, and reaffirmation inspection kinds;
- active/retired binding status;
- exact 14 risk signals and 7/2/3 difference sets;
- the exact 35-code A1 error vocabulary plus a disjoint A2a
  `storage-integrity` digest-mismatch tuple;
- complete registered-repository, successful/failed inspection, and binding records;
- deterministic, total `normalizeRepositoryErrorEvidence`;
- evidence-bearing `reduceRepositoryState`.

The reducer validates status, command, assessment, reason, and sorted-unique difference
sets at runtime. Unknown values throw explicitly. `identity-mismatch` and
`evidence-blocked` are terminal except for retirement. Environmental reaffirmation
advances only from `identity-evidence-changed` when the carried assessment still proves
environmental difference.

`AUDIT_ACTIONS` gains six schema-3 actions:

```text
repository.register
repository.inspect
repository.reaffirm
repository.retire
repository.bind-project
repository.unbind-project
```

`AUDIT_ACTION_INTRODUCED_IN_SCHEMA` records the exact schema-1/2/3 introduction version
for all 19 actions.

## 4. Public contract inventory

`packages/contracts/src/repository.ts` provides strict Zod schemas and inferred types for:

- register and inspect requests;
- environmental reaffirmation;
- repository retirement;
- project binding and binding retirement;
- common reader repository identity;
- separate Owner-only administrative identity;
- repository/evidence/risk summaries;
- successful and failed inspection summaries;
- binding summaries with joined repository status/reason;
- list, detail, administrative detail, inspection list, and all mutation envelopes.

Every object and nested object is strict. Requested paths are bounded absolute-shape
strings, not claimed canonical or admitted. Unknown process/Git controls, raw evidence,
stderr/environment data, and readiness/review/merge claims are rejected.

Common reader identity exposes canonical top level, object format, and core fingerprint.
Only the separate administrative contract contains canonical Git and common-Git
directories. All four latest/latest-successful IDs and times are required.

No route or server response wiring was added in A2a.

## 5. Schema and migration inventory

Migration:

```text
packages/storage/migrations/0003-ct04a2a-repository-model.sql
SHA-256 526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
```

It creates exactly three strict domain tables:

| Table | Columns | Purpose |
| --- | ---: | --- |
| `registered_repositories` | 21 | immutable registered identity, current status/version, registration and accepted-environment links |
| `repository_inspections` | 36 | global sequence, exact successful evidence or exact bounded failure tuple |
| `project_repository_bindings` | 10 | project/repository association and retirement history |

The inspection `sequence INTEGER PRIMARY KEY AUTOINCREMENT` is the only latest-order
authority. Timestamps and UUID spelling never decide latest evidence.

The only deferred relationship is the composite inspection-to-repository parent:

```sql
FOREIGN KEY (workspace_id, repository_id)
  REFERENCES registered_repositories(workspace_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
```

Repository links back to registration and accepted-environment inspections are
immediate composite foreign keys. Registration therefore inserts inspection first,
inserts the coherent repository, and validates the reciprocal parent at outer commit.
Orphans fail at outer commit; missing, sibling, wrong-workspace, and wrong-parent links
fail closed.

The migration installs the reviewed 13-trigger inventory:

```text
registered_repositories_initial_state
registered_repositories_transition_only
registered_repositories_retirement_requires_closed_bindings
registered_repositories_no_delete
repository_inspections_record_shape
repository_inspections_parent_state
repository_inspections_arrays_valid
repository_inspections_failure_taxonomy
repository_inspections_no_update
repository_inspections_no_delete
project_repository_bindings_initial_state
project_repository_bindings_retirement_only
project_repository_bindings_no_delete
```

Partial global unique indexes reserve canonical top level, common Git directory, and
core fingerprint for every non-retired repository. Candidate keys and composite
foreign keys enforce workspace/project/repository/actor relationships.

Migration 0003 does not rebuild either journal. Populated schema-2 forward-migration
tests prove existing rows, journal SQL, sequences, catalogs, indexes, and triggers are
preserved. Synthetic interruption rolls back to intact schema 2.

Accepted old migration hashes remain:

```text
0001 42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273
0002 6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247
```

## 6. Evidence storage and integrity semantics

Successful observation storage uses:

```text
JSON.stringify once
  → retain that exact UTF-8 string
  → SHA-256 those exact bytes
  → store projections derived from the same value
```

Whitespace and key order are material. This is not canonical JSON. The digest detects
accidental stored-byte corruption; it is not authenticity against a database writer
able to alter both bytes and digest.

Success requires the complete observation/projection group and null failure fields.
Registration omits all three comparison arrays; verification/reaffirmation success
requires all three, including empty arrays. Failure requires null observation,
projection, and comparison fields plus a complete exact taxonomy and normalized JSON
evidence object. A1 and storage-integrity tuples are disjoint at SQL.

The exact risk pattern remains a domain constant. SQL enforces bounded non-empty shape,
while machine-readable migration markers prove set equality for error vocabulary, risk
signals, and 7/2/3 difference sets. A2b must compare the domain pattern and vocabulary
against A1.

## 7. Storage repository API and lifecycle

`StorageRepositories` and `CraftingTableStorage` expose:

```text
repositoryRegistry.repositories
repositoryRegistry.inspections
repositoryRegistry.bindings
repositoryRegistry.queries
```

Closed typed results distinguish created, existing, local conflict, foreign reservation,
version conflict, non-inspectable state, non-active repository, and binding collision.
Foreign identity collision is exactly:

```json
{"kind":"identity-reserved-elsewhere"}
```

It contains no foreign workspace, ID, path, Git directory, or fingerprint.

Registration, inspection append, binding insertion, reaffirmation, and retirement use
nested-safe immediate transactions or exact guarded updates. SQLite unique errors are
not parsed by message or index name; residual races are rolled back and reclassified.

Environmental-baseline adoption requires exact repository version, expected latest
successful inspection, a fresh latest successful reaffirmation, non-empty environmental
difference, immutable core projections, actor coherence, and version +1. A direct stray
reaffirmation can exist under the three-table model, but projection derives
`acceptedAsEnvironmentBaseline=false` unless the repository names it.

Binding status is history, not usability. An active binding remains active when its
repository becomes unavailable, evidence-changed, mismatched, or blocked; project
projections join current repository status/reason. Repository retirement retires all
active bindings first and the repository second in one transaction. Forced outer
failure rolls everything back. Repeated retirement is an application no-op.

## 8. Session, authorization, audit, and event semantics

A2a adds no session, cookie, CSRF, route authorization, or role-policy behavior.

The database proves actor user existence and historical membership in the named
workspace through user and composite membership foreign keys. Archived workspace or
revoked historical membership remains valid attribution; it does not authorize a new
action. A2b must authenticate, authorize current membership/role, and perform the
pre-inspection version check before creating or calling A1.

Migration 0003 registers the six audit action names, but A2a writes no audit event.
It adds no workspace-event kind, journal payload, notifier call, or SSE behavior.
State/audit/event composition and the registration two-inspection attestation remain
A2b.

## 9. Permanent proof and acceptance mapping

| Protected/review family | Permanent proof |
| --- | --- |
| `A2A-STATUS-001`–`015` | `packages/domain/src/repository.test.ts`: complete ordinary and reaffirmation matrices, terminal states, retirement, and explicit unknown-input failures |
| `A2A-REP-001`–`016` | schema/repository/transition tests: valid circular registration, deferred orphan failure, ownership, all identity reservations, typed local/foreign collision, immutability, exact versions, equal/backwards time, delete, and bounds |
| `A2A-INSP-001`–`018` | schema/repository/transition tests: success/failure null coupling, membership, arrays/bounds, append-only history, exact bytes, stale digest, disjoint taxonomy, fixed-time sequence, and registration comparison omission |
| `A2A-BASE-001`–`009` | repository/transition tests: initial baseline, fresh adoption, stale/version/core negatives, rollback/delete protection, and stray reaffirmation projection |
| `A2A-BIND-001`–`013` | repository/schema tests: same-workspace binding, missing/wrong/non-active parents, one active per project, multiple projects per repository, exact retirement, sibling survival, projection across non-active status, and delete/reverse rejection |
| `A2A-RET-001`–`008` | transition tests: atomic repository/binding retirement, forced rollback, idempotence, terminality, evidence preservation, identity reuse, unretire/delete rejection |
| `A2A-MIG-001`–`008` | migration 0003/0002/general migration tests and snapshot tests: exact objects, preservation, active old guards, checksum failure, interruption rollback, integrity checks, reconstruction, old-byte pins |
| `A2A-CON-001`–`010` | contract tests: minimal requests, strict hostile-field rejection, display-name bounds, complete summaries, false-claim/raw-evidence rejection, exact mutation shapes, reader/admin disclosure, required latest fields |
| `A2-PROC-001`–`004` | committed plan/review/disposition lineage, this real-head report, and protected hash/diff checks |
| `A2-SCOPE-001`, `A2-SCOPE-003`, `A2-SCOPE-004` | enhanced scope checker, no literal current-version pin, and domain-to-SQL literal-set parity |

The protected A2 supplement remains byte-identical:

```text
1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
```

The original protected specification remains byte-identical:

```text
ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
```

## 10. Adversarial relationship matrix coverage

| Relationship/case | Durable result |
| --- | --- |
| Same workspace and correct parent | composite candidates/FKs accept |
| Cross workspace | composite repository/project/membership keys reject |
| Same workspace and wrong parent | same-parent composite inspection and binding keys reject |
| Missing parent | immediate FK rejects; only registration inspection parent waits for outer commit |
| Retired or non-active parent | historical reads remain; new inspection/binding triggers reject by reviewed state |
| NULL/optional dimension | complete success/failure and active/retired coupling closes MATCH SIMPLE skips |
| Concurrent insert/update | immediate writer serialization, partial unique indexes, global sequence, typed loser |
| Update without exact version increment | repository/binding transition triggers reject +0/+2/bare bump |
| Direct delete or reverse transition | all three tables reject delete; reverse/unretire/post-retirement update fails |

Focused tests also cover fixed-clock order, opposite identifier order, stale expected
version/latest-success, foreign non-disclosure, two-binding retirement rollback,
same-time version progression, integrity failure plus evidence-blocking in one outer
transaction, `foreign_key_check`, and `integrity_check`.

## 11. Verification commands and results

The exact committed implementation head was verified with:

```text
pnpm check
```

Result:

```text
format:check  passed, 220 files
lint          passed, 221 files
typecheck     passed
build         passed
unit/integration:
  66 test files passed
  523 tests passed
Playwright:
  4 tests passed
check:scope   passed
check:protected passed
```

The accepted focused command was also run against the committed head:

```text
pnpm exec vitest run \
  packages/domain/src/repository.test.ts \
  packages/contracts/src/repository.test.ts \
  packages/storage/src/repository-schema.test.ts \
  packages/storage/src/repository-repositories.test.ts \
  packages/storage/src/repository-transitions.test.ts \
  packages/storage/src/migration-0003.test.ts \
  packages/storage/src/migration-0002.test.ts \
  packages/storage/src/migrations.test.ts \
  packages/storage/src/snapshot.test.ts \
  apps/server/src/restart.test.ts \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs
```

Result: 12 files and 90 tests passed.

Other completed deterministic gates:

```text
pnpm install --frozen-lockfile
  exit 0; lockfile already current; registry update-metadata lookup emitted EAI_AGAIN
  but no package download or dependency change was required

pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
node scripts/check-forbidden-scope.mjs
node scripts/check-ct04-protected-package.mjs
git diff --check
```

An initial sandboxed `pnpm test` run reported 495 passes and 11 failures: ten existing
SSE tests could not open loopback ports (`EPERM`), and the CLI future-schema fixture
still used version 3. The fixture was corrected to version 4, and the full suite was
rerun with loopback permission: all 523 tests passed. There is no unresolved test
failure.

Exact preservation checks:

```text
sha256sum \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml \
  protected/CT-04-protected-acceptance-spec.yaml \
  packages/storage/migrations/0001-ct02-foundation.sql \
  packages/storage/migrations/0002-ct03-planning.sql

git diff --exit-code 3f31aca7e43c502b58385e73e38f64e24d6908df -- \
  protected/ \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml

git diff --exit-code 3f31aca7e43c502b58385e73e38f64e24d6908df -- \
  packages/storage/migrations/0001-ct02-foundation.sql \
  packages/storage/migrations/0002-ct03-planning.sql
```

All passed.

## 12. ADR and documentation changes

Added:

```text
docs/decisions/ADR-017-repository-evidence-and-persistence.md
```

Amended ADR-002 for schema 3, the one deferred circular key, immediate reciprocal
inspection keys, sequence authority, and lifecycle triggers.

README, CLAUDE, architecture, security, and operations now describe A2a as an
uncomposed persistence slice; document reader/admin disclosure; avoid canonicalization
and hostile-database authenticity claims; distinguish persistence state from readiness;
and state that no repository operation becomes operator-usable before A2b.

## 13. Deliberately deferred to A2b

A2a does not implement:

- repository feature configuration, source/reserved roots, or executable/search path;
- inspector creation, A1 import, or domain-to-A1 parity adapter;
- authentication, current membership, Owner/Editor/Viewer policy, CSRF, or routes;
- pre-A1 expected-version service ordering;
- two-inspection registration/quiescence orchestration or audit attestation;
- stored digest-to-parse-to-projection-to-compare orchestration with A1;
- audit/event command transactions or denied/failed audit policy;
- schema 4, repository workspace events, notifier, SSE, activity text, or browser UI;
- startup reconciliation or scheduled inspection;
- remote Git, credentials, Git mutation, repair, worktrees, refs, diffs, artifacts,
  verification, readiness, review, remediation, merge, or delivery;
- rewriting CT-03 work-contract drafts or claiming repository/base resolution.

A2b must be replanned from implementation head
`e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`.

## 14. Known limitations and unresolved risks

- Exact-byte SHA-256 detects accidental corruption, not a writer able to alter both
  SQLite bytes and digest.
- JSON is deliberately noncanonical; whitespace and property order change the digest.
- SQL enforces bounded non-empty risk-pattern shape, while exact pattern ownership and
  A1 parity remain domain/A2b responsibilities.
- The three-table model permits a direct-SQL successful reaffirmation row not adopted
  as baseline. Projection correctly reports it as not accepted.
- Historical membership foreign keys prove attribution, not current authorization.
- Repository and binding `active` remain persistence states, not safety, readiness,
  approval, verification, review, mergeability, or executability.
- A2a exposes no composed product behavior. Independent review should not infer that
  repository registration is usable through the daemon or browser.

No unresolved implementation or gate failure is known at the reported head.

## 15. Scope confirmation

This implementation contains one repository/evidence/binding assurance domain, one
migration, and no competing persistence model. It does not expand into A2b.

Direct confirmation:

```text
no @craftingtable/git import
no child process
no Fastify/server production/route change
no workspace event or notifier
no browser code
no A2b configuration or composition
no protected-file edit
no change to migrations 0001 or 0002
```

The completion report is intentionally a separate record after the immutable
implementation head, so independent review must evaluate
`e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`, not the later report-only commit.
