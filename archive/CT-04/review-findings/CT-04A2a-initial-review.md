# CT-04A2a independent code review

Reviewed implementation head: `e49a5aafeeeb73eacea25c70d0b1ef9d44cb5a0c`
Report-only commit at review time: `ae883ed96dba528ca896d3e62365e7d90acde51a`
Base / planning commit: `3f31aca7e43c502b58385e73e38f64e24d6908df`
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Accepted implementation plan: `work-items/CT-04/CT-04A2a-accepted-implementation-plan.md`
(SHA-256 `e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747`)
Completion report: `implementation-reports/CT-04/CT-04A2a-initial-impl.md`
Review checkout: `ae883ed9…`, branch `ct-04a2a-repository-model`, working tree clean
before and after. `git diff e49a5aa ae883ed` touches only the completion report, so the
reviewed code head is `e49a5aa`.
Local environment: Node `v26.2.0`, better-sqlite3 `13.0.1`, POSIX, effective UID `1000`
(non-root). Every probe ran from a scratch directory outside the repository against
temporary SQLite databases. Nothing in the repository was modified by this review.

## Verdict

**CHANGES REQUIRED**

One blocking finding, `A2a-R-01`, and it is not a correctness defect: 66 of the 91
protected CT-04A2a acceptance cases, plus 7 of the 13 review-added cases, have no
test-title anchor, contrary to the accepted plan's binding statement at §15 that "Every
original A2a protected ID remains a test-title prefix." The behaviour those cases
describe is genuinely covered — I reproduced substantially all of it independently — so
this is a failure of the operator-owned traceability control, not a false green. The
remediation is mechanical and confined to test titles plus one check.

Everything else in the slice is faithful to the accepted plan, and the SQL invariant
layer is materially stronger than the plan's minimum. The authority boundary, circular
registration graph, deferred-key placement, transition and version triggers, exact-byte
digest semantics, identity reservation non-disclosure, binding lifecycle, migration
preservation, and strict contract disclosure boundary all hold under independent
adversarial probing. No CT-04A2b behaviour leaked in.

## Verification performed

**Checkout and provenance.** `git rev-parse HEAD` = `ae883ed9…`; `git status --porcelain`
empty; `git diff --check` clean. `e49a5aa` is the implementation commit with 36
changed/new files, 5,079 insertions and 40 deletions, matching the report's §1 claim and
the accepted plan §5 target tree file-for-file (the one extra file, `cli.test.ts`, is the
disclosed schema-version fixture repair). No `package.json` or lockfile appears in the
diff. `apps/web` is untouched. The only `apps/server` changes are two test files —
`cli.test.ts` advances a future-version fixture from 3 to 4, and `restart.test.ts`
replaces two literal `toBe(2)` assertions with the discovered `supportedVersion`. There
is no server production change.

**Protected and pinned artefacts.** Live SHA-256 values reproduce the report exactly:
supplement `1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c`, protected
spec `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`, migration 0001
`42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273`, migration 0002
`6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247`, migration 0003
`526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4`. Accepted plan hash
matches. `git diff --exit-code 3f31aca -- protected/ …supplement.yaml` and the same
against both old migrations are empty.

**Full gate.** `pnpm check` run end to end at head, exit 0: format 220 files, lint 221
files, typecheck, build, **66 test files / 523 tests**, 4 Playwright tests, `check:scope`,
`check:protected`. The report's §11 figures reproduce exactly.

**Authority boundary.** Every import in `packages/domain/src/repository.ts`,
`packages/contracts/src/repository.ts`, `packages/storage/src/repository-types.ts`,
`packages/storage/src/repository-test-support.ts`, and
`packages/storage/src/repositories/repository-registry/{index,rows}.ts` resolves to
`@craftingtable/domain`, `zod`, `better-sqlite3`, `node:crypto`, or a local sibling. No
Git package, child process, Fastify, route, workspace-event, notifier, React,
`node:fs`, or `node:net`. `isA2aSource` in `scripts/check-forbidden-scope.mjs` matches
all eleven A2a TypeScript files including the tests, and `isForbiddenInA2a` flags each
forbidden specifier family.

**Adversarial probes.** Roughly 110 direct-SQL, storage-API, and contract probes written
independently of the repository's own suite, run against fresh temporary databases with
`foreign_keys = ON` (verified at `packages/storage/src/database.ts:14`, with a hard
pragma assertion at `:25-32`).

- *Circular graph.* An orphan registration inspection is accepted inside the transaction
  and rejected only at the outermost `COMMIT` (`0003-…sql:59-61`). Repository-before-
  inspection and a repository naming another repository's inspection both fail at the
  statement via `registered_repositories_initial_state` (`:282`) and the immediate
  three-column keys at `:214-217`. A second registration inspection for one repository is
  rejected.
- *Transitions and versions* (`:314-385`). Rejected: `+0`, `+2`, bare version bump,
  reason-only rewrite, core-identity rewrite, display-name rewrite, backwards
  `status_changed_at`, reverse transition out of `retired`, and `DELETE`. Accepted: an
  equal-millisecond transition. `identity-mismatch` and `evidence-blocked` leave only to
  `retired`, and neither admits a new inspection (`repository_inspections_parent_state`,
  `:431`). Two connections applying the same transition at the same expected version
  yield one `changed` and one `version-conflict`.
- *Baseline* (`:348-372`). After a genuine API advance, direct-SQL rollback to the
  registration inspection is rejected both as `evidence-matches` and as
  `environment-evidence-reaffirmed`; adopting a *verification* row is rejected; adopting a
  non-`MAX(sequence)` successful row is rejected; an evidence-free reaffirmation
  (`environmental_differences_json = []`) is rejected and the whole transaction rolls
  back, leaving no orphan inspection and no version drift. A stray direct-SQL
  reaffirmation is visible history but projects `acceptedAsEnvironmentBaseline = false`
  (`repository-registry/index.ts:742`).
- *Inspections.* Update and delete rejected. Failed registration rejected. A failed row
  carrying observation bytes rejected by the success/failure `CHECK` (`:62-113`). Both
  cross-origin taxonomy tuples rejected, as is a wrong subject for a valid A1 code
  (`repository_inspections_failure_taxonomy`, `:541`). Dotted evidence keys and nested
  evidence values rejected. Unsorted, duplicate, unknown, over-bound, and non-text array
  members rejected (`repository_inspections_arrays_valid`, `:470`); risk classification
  must agree with signal presence in both directions.
- *Total order.* Three appends under a fixed clock with **descending** identifiers still
  order by `sequence`; `latestForRepository` and `latestSuccessfulForRepository` both
  return the last inserted row.
- *Bytes and digest.* Stored `observation_json` is byte-identical to the written string;
  a one-byte change breaks `verifyExactUtf8Sha256`; a storage-integrity failure append
  and the `evidence-blocked` transition commit together in one outer transaction, and a
  forced outer failure rolls both back.
- *Bindings and retirement.* Rejected: a second active binding per project, a
  foreign-workspace project, a binding born retired, a binding born at version 2, a
  binding to a nonexistent repository, retarget, unretire, `+2`, retirement leaving the
  actor NULL, delete, and repository retirement while an active binding remains
  (`:387`). Accepted: many projects binding one repository. An active binding survives an
  `identity-mismatch` transition and `projectBindingSummaries` reports the real
  repository status and reason. `retireWithBindings` retires both bindings then the
  repository atomically, is idempotent, releases all three identity reservations, and
  rolls back completely on forced outer failure.
- *Identity reservation.* A cross-workspace collision returns exactly
  `{"kind":"identity-reserved-elsewhere"}` — one key, no foreign workspace, ID, path, or
  fingerprint — both from a single connection and from a genuinely separate second
  connection. Identity is reusable under a new ID after retirement.
- *Historical attribution.* A referenced `workspace_memberships` row and a referenced
  `users` row are both undeletable, matching the plan's `ON DELETE RESTRICT` claim. A
  non-member actor on an inspection is rejected by the composite membership key.
- *Display-name bounds* (`:167-171`). Empty, untrimmed, 121-character, C0-control, and
  DEL names rejected; a legitimate name accepted.

**Reducer.** I encoded the accepted plan's §6.4 tables independently and compared:
all 42 ordinary matrix cells and all 7 reaffirmation cells match, `baselineAdvanceRequired`
is set only for environmental reaffirmation, reaffirmation from every other status is
rejected with the plan's exact reason, retirement behaves correctly from all six statuses,
and unknown status, command, assessment, reason, or an unsorted/duplicate difference set
each throws rather than defaulting.

**Contracts.** 44 independent probes pass. Hostile fields (`command`, `argv`,
`environment`, `gitExecutable`, `worktree`/`branch`/`ref`/`remote`, `allowedSourceRoots`)
rejected; relative, NUL-bearing, and oversize requested paths rejected; reader identity
rejects both Git-directory fields while the administrative schema accepts them;
`ready`/`mergeable`/`verified`/`approved` rejected; each of the four latest and
latest-successful fields is individually required; registration-versus-verification
comparison-array coupling enforced in both directions; failed summaries reject leaked
evidence and reject `kind: 'registration'`; a retired binding without `retiredAt` is
rejected.

**Migration.** A hand-built populated schema-2 database migrated forward with every prior
table, trigger, and index SQL preserved, every pre-existing `sqlite_sequence` row and
counter unchanged, every prior audit action's `introduced_in_schema` unchanged, exactly
the three new tables and six schema-3 actions added, and `foreign_key_check` and
`integrity_check` clean. A drifted recorded checksum fails closed with
"Applied migration 3 checksum mismatch".

**Vocabulary parity.** Beyond the repository's own marker-comment test, I compared the
**executable trigger SQL** against the domain constants: 14 risk signals, the 7/2/3
difference sets, 35 A1 error codes, 8 subjects, 4 operations, 4 categories, and 3
retryabilities are all set-equal, and every A1 code maps to the same subject in SQL as in
`A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE`. The marker comments agree with both.

**Documentation.** `docs/security.md`, `docs/operations.md`, `docs/architecture.md`,
README, and CLAUDE explicitly disclaim canonical JSON, hostile-writer authenticity, and
any readiness, executability, approval, review, or mergeability meaning for repository or
binding `active`, and state that no repository operation is operator-usable before A2b.
No overclaim found.

## Blocking finding

### A2a-R-01 — 66 of 91 protected acceptance cases have no test-title anchor

**Severity:** blocking (process/traceability; no behavioural defect)
**Files:** the twelve nominated proof files, chiefly
`packages/storage/src/repository-schema.test.ts`,
`packages/storage/src/repository-repositories.test.ts`,
`packages/storage/src/repository-transitions.test.ts`,
`packages/storage/src/migration-0003.test.ts`,
`packages/contracts/src/repository.test.ts`;
`scripts/check-forbidden-scope.mjs`

The accepted implementation plan states at line 1444: *"Every original A2a protected ID
remains a test-title prefix. The reviewed 91 protected cases are not renumbered or
edited."* Section 15.1 then presents that prefixing as the permanent proof for each
protected family.

Scanning every `it(` and `describe(` title across all twelve nominated files, and
expanding the compact notations the implementation does use — the range form at
`packages/domain/src/repository.test.ts:20` (`A2A-STATUS-001..014`) and the slash forms at
`packages/storage/src/repository-transitions.test.ts:137` (`A2A-RET-003/006`) and
`packages/contracts/src/repository.test.ts:109` (`A2A-CON-004/010`) — only **25 of the 91**
protected CT-04A2a case IDs appear anywhere in a test title.

Unanchored protected IDs (66):

```text
A2A-REP-001 … A2A-REP-014
A2A-INSP-001 … A2A-INSP-012, A2A-INSP-014
A2A-BASE-001 … A2A-BASE-008
A2A-BIND-001 … A2A-BIND-012
A2A-RET-001, A2A-RET-004, A2A-RET-005, A2A-RET-007, A2A-RET-008
A2A-MIG-001 … A2A-MIG-004, A2A-MIG-006, A2A-MIG-007, A2A-MIG-008
A2A-CON-001, A2A-CON-002
A2-PROC-001 … A2-PROC-004
A2-SCOPE-001
```

Unanchored review-added IDs named in accepted plan §15.2 (7):

```text
A2A-REP-015  A2A-INSP-016  A2A-INSP-018  A2A-BIND-013
A2A-CON-009  A2-SCOPE-003  A2-SCOPE-004
```

**What this is not.** The behaviour these cases describe is genuinely covered. The test
titles that exist are descriptive and accurate, and I reproduced substantially all of the
underlying invariants independently — see "Adversarial probes" above, which exercises the
circular graph, ownership keys, identity reservations, immutability, exact versions,
success/failure coupling, array bounds, append-only history, exact bytes, stale digest,
disjoint taxonomy, baseline advance and rollback, binding uniqueness and survival, atomic
and idempotent retirement, migration preservation, and checksum drift. There is no false
green here and no reason to doubt the suite.

**Why it blocks.** The prefixing is the mechanism by which the operator-owned,
`protected: true`, `required: true` supplement is discharged, and the accepted plan makes
it binding. With 66 cases unanchored there is no mechanical way to confirm that each
required case has live proof, no gate that would notice one silently losing coverage, and
no path for CT-04A2b to map a regression back to a protected ID. The completion report's
§9 "Permanent proof" table presents family-level ranges that read as though per-case proof
exists.

**Required outcome.** Every protected CT-04A2a case ID in
`work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml`, and every review-added ID
named in accepted plan §15.2, is discoverable from the test suite by ID, together with a
check that fails when one is not. The compact range and slash notations already in use are
acceptable provided the check expands them. Confine the change to test titles and the
check script: no schema, migration, domain, contract, or storage change is warranted for
this finding, and none should be made. If any case turns out to have no behavioural proof
once the mapping is made explicit, report it rather than writing a test that merely
satisfies the checker.

## Advisory findings

These are not blocking and need not be remediated for this slice, but each should be a
deliberate decision rather than an accident.

### A2a-A-01 — `appendVerification` reports a nonexistent repository as `retired`

`packages/storage/src/repositories/repository-registry/index.ts:452-455` returns
`{kind: 'repository-not-inspectable', status: 'retired'}` when `find` yields `undefined`.
Verified: an identifier that was never registered returns exactly that. The response is
usefully non-disclosing, but the `status` is fabricated. The plan's
`InspectionAppendResult` union has no `not-found` variant, so this is within the accepted
shape; the risk is downstream. CT-04A2b must not surface this `status` as a claim that
the repository exists and is retired.

### A2a-A-02 — a bind racing behind retirement returns `repository-version-conflict`

`index.ts:546-551` checks the expected repository version before status, and retirement
bumps the version, so a bind carrying the pre-retirement version trips the version guard
first. Accepted plan §11.5 describes this case as "binding is included in retirement or
sees retired". The binding is correctly refused and the outcome fails closed — only the
discriminant differs. Worth pinning CT-04A2b's error mapping deliberately rather than
inferring repository state from this variant.

### A2a-A-03 — the A2a scope rule allows `node:fs`, `node:net`, and `node:http`

`scripts/check-forbidden-scope.mjs:69-80`. No A2a source imports them today — verified by
enumerating every import in all eleven files — but `CT-04A2a.md:88` forbids performing
filesystem or Git inspection, and only the Git and child-process halves of that are
structurally enforced. A future A2a edit could add filesystem access without tripping the
gate. This is a gate gap, not a code defect.

### A2a-A-04 — `applyTransition` is the one mutator that does not open its own transaction

`index.ts:265-301` performs a read, then a guarded `UPDATE`, then a read-back, without
`.immediate()`, unlike `register`, `reaffirmEnvironment`, `retireWithBindings`,
`appendVerification`, and `insert`. The single `UPDATE … WHERE workspace_id = ? AND id = ?
AND status = ? AND version = ?` makes it fail closed under concurrency — verified with two
connections — and CT-04A2b will compose it inside `storage.transaction`. The residual is
that the read-back at `:296` can reflect a later committed state than the one this call
produced when it is invoked outside an outer transaction.

## Scope confirmation

The slice contains one repository/evidence/binding assurance domain, one migration, and
no competing persistence model. Confirmed absent at this head: `@craftingtable/git`
import, child process, Fastify or server production change, route, workspace-event kind
or journal rebuild, notifier call, browser change, new dependency, protected-file edit,
and any edit to migrations 0001 or 0002. No CT-04A2b protected case ID is claimed by any
CT-04A2a test.

## Reviewer notes for remediation

- Any remediation commit invalidates this verdict; re-review is required against the new
  exact head, per `work-items/CT-04/CT-04-process-protocol.md` §8.
- `A2a-R-01` should be remediable without touching
  `packages/storage/migrations/0003-ct04a2a-repository-model.sql`,
  `packages/domain/src/repository.ts`, `packages/contracts/src/repository.ts`, or
  `packages/storage/src/repositories/repository-registry/`. A remediation diff that
  reaches into those files needs an explicit justification.
- Do not edit, renumber, or reclassify
  `work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml`.
- The completion report's §9 proof table should be restated in per-case terms once the
  anchoring exists, so the report no longer implies coverage the suite cannot demonstrate.
