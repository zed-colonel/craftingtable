# CT-04A2a design review

Reviewed proposed plan: `work-items/CT-04/CT-04A2a-proposed-implementation-plan.md`
sha256 `67c6444ca23ba8d19902ad01a05ef4d31a5c990e4d8d02b1049cde458fcd2c81` (untracked at review time, 1,928 lines)
Review checkout: `599f3dedf406542cfda26bfecc25ffdc86e0c6d4`, branch `ct-04a2a-repository-model`, worktree otherwise clean
Accepted A1 runtime head: `7313e81a56c0188574c436322d7fedc16e08bb70`
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Local Git `2.54.0`; local SQLite (better-sqlite3 13.0.1) `3.53.3`.
Probes were run in the session scratchpad against `:memory:` databases. Nothing in the
repository was modified by this review.

## Verified declared facts

Every pinned fact in §2.2 is correct. All six local digests reproduce exactly:

```text
da26d6c8…  work-items/CT-04/CT-04A1-accepted-implementation-plan.md
f27ac10b…  review-findings/CT-04/CT-04A1-remediation-2-review.md
ce7a101c…  protected/CT-04-protected-acceptance-spec.yaml
1000d564…  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml
42ade0fe…  packages/storage/migrations/0001-ct02-foundation.sql
6d2789c5…  packages/storage/migrations/0002-ct03-planning.sql
```

`7313e81…` is an ancestor of `599f3de…`, and `git diff --name-only 7313e81 599f3de`
returns only the thirteen review/report/template/A2-planning artifacts — no `apps/`, no
production package, no script, no manifest, no migration. The runtime-clean claim holds.
`06abcffe…` exists. The plan correctly declines to recompute the absent source-bundle ZIP.

§3's A1 reconciliation is **exactly right** where it matters most, and I checked it
literally against `packages/git/src/types.ts`:

- 35 error codes, and the code → subject → category → retryability table in §6.2
  reproduces `REPOSITORY_INSPECTION_ERROR_SUBJECTS`, `categoryFor`, and `retryabilityFor`
  member-for-member across all eight subjects (1/4/7/3/6/11/2/1 = 35);
- the 14 risk signals match `REPOSITORY_RISK_SIGNALS` in order;
- the 7/2/3 difference names match `CoreEvidenceDifference`,
  `EnvironmentalEvidenceDifference`, `RiskScanDifference`;
- the four operations and three retryability values match;
- the fingerprint-input claim is right: `canonicalGitDirectory`, devices, `riskScan`, and
  `observedAt` are outside A1's core fingerprint;
- `observationVersion` is pinned to literal `1` in A1 while `inspectionPolicyVersion` is a
  plain `number`, and the plan's schema pins the former and bounds the latter. That
  distinction is easy to get wrong and the plan got it right.

The candidate keys A2b's journal will need (guidance §13) are all present:
`registered_repositories(workspace_id, id)`, `repository_inspections(workspace_id,
repository_id, id)`, `project_repository_bindings(workspace_id, project_id, repository_id,
id)`.

The 91-case A2a count is correct (86 domain + `A2-PROC-001..004` + `A2-SCOPE-001`), and
`CT-04A2-acceptance-matrix.yaml` contains exactly 91 `slice: CT-04A2a` cases.

Migration discovery is directory-scanned (`discoverMigrations`), so `0003-…` needs no
registration edit, and `ct04a2a-repository-model` satisfies `MIGRATION_FILE`. `foreign_keys
= ON` is verified at open in `configureDatabase`, so `DEFERRABLE INITIALLY DEFERRED` is
live.

### Probe results

I built the plan's core structures and executed them. All of these **work as the plan
assumes**:

| Probe | Result |
|---|---|
| Inspection-first insert of the reciprocal deferred-FK pair in one immediate transaction | commits |
| Lone inspection with no repository parent | statement succeeds, `FOREIGN KEY` at COMMIT |
| Repository-first order | rejected at statement time by the pre-existence guard trigger |
| `json_each` in a trigger body for allowlist, uniqueness, and sorted-order checks | all three negatives raise correctly |
| Partial `UNIQUE INDEX … WHERE status <> 'retired'` on a `STRICT` table | rejects the duplicate |
| Failed nested `register` (savepoint) after a live-identity uniqueness conflict | rolls back cleanly and does **not** poison the outer commit |

Two probes contradict plan text and are cited under findings A2a-F-02 and A2a-F-10.

## Verdict

**REVISE — do not produce the accepted implementation plan until A2a-F-01 through
A2a-F-04 are dispositioned.**

The split decision is affirmed. This is genuinely one persistence model and one assurance
domain; the A2a/A2b line is honest and I found no A2b behavior hiding in A2a (details in
[Scope assessment](#scope-assessment)). The plan is unusually careful, its declared facts
are true, and its SQLite mechanics are real rather than assumed.

It is not a pass because four findings are **model** defects, not text amendments: one
terminal repository state has no expressible evidence record (F-01), the append-only
evidence table has no total order and its "latest" projection demonstrably returns the
wrong row (F-02), the storage insert primitives cannot express any of the idempotency and
non-disclosure outcomes the parent contract requires (F-03), and the pure reducer will
bless a reaffirmation with no supporting evidence at all (F-04). Each changes a record, a
key, or a return type — the kind of change that must land before the accepted plan, not
during implementation.

The test inventory is large and specific. That is not why I am not approving it: eight of
the findings below identify invariants that **no** listed test can fail on, because the
design does not contain the thing the test would check.

## Findings

Each finding uses the protocol §5 structure.

---

### A2a-F-01 — High — A terminal repository state has no expressible inspection record: `stored-evidence-digest-mismatch` exists as a status reason but has no code, subject, or operation in the mirrored failure taxonomy

**Claim.** `RepositoryStatusReason` includes `stored-evidence-digest-mismatch`, and the
reducer transitions any of `active`/`unavailable`/`identity-evidence-changed` to
`evidence-blocked` on `{kind:'evidence-invalid', reason:'stored-evidence-digest-mismatch'}`.
No inspection row can record that. `FailedRepositoryInspection.errorCode` is restricted to
the closed A1 vocabulary, which contains only `recorded-observation-invalid`,
`unsupported-observation-version`, and `inspection-policy-version-mismatch` for the
evidence classes — the digest check is A2a's own invention and has no A1 code. §8.2's
`repository_inspections_failure_taxonomy` trigger enforces exact agreement with the A1
table, so no code can be added at the row level either. `errorOperation` is likewise the
four A1 operations; a pre-parse storage-integrity check is none of them, and labelling it
`parse-recorded-observation` would be false because §10's read protocol explicitly
rejects on digest **before** parsing.

**Evidence.** Plan §6.2 reason list; §6.3 `FailedRepositoryInspection`; §6.2 complete
mirrored error table; §8.2 failure rules ("code → subject → category/retryability agrees
with the complete accepted A1 table", "operation is one of create-inspector, inspect-path,
parse-recorded-observation, compare-observations"); §10 read protocol ("reject a digest
mismatch **before** JSON parsing"). `packages/git/src/types.ts:83-118` confirms no
digest-integrity code exists in A1.

**Violated invariant.** CT-04A2 §2: "Every explicit inspection becomes immutable
evidence." CT-04A2a exit gate: every status transition enforced by reducer **and**
triggers. A repository can reach a terminal state that its own evidence history cannot
explain. Protected `A2A-INSP-013` ("stale digest … returns an integrity failure") and
`A2B-INSP-009` ("evidence-blocked; A1 compare never called") have no durable landing
place.

**Required design disposition.** Add a durable non-A1 evidence-failure axis. Concretely:
introduce subject `stored-evidence-integrity` (category `observation`, retryability
`not-retryable`) with code `stored-evidence-digest-mismatch`, and an operation member such
as `verify-stored-record`, held in the A2a durable vocabulary and marked explicitly as
**A2a-owned, not mirrored from A1** so the A2b parity test does not flag it as drift. The
`repository_inspections_failure_taxonomy` trigger must then enforce two disjoint tables
(A1-mirrored and A2a-owned) rather than one. If instead the operator decides no inspection
row is written for a digest failure, the plan must say so explicitly and state where the
reason is durably recorded, because §6.2 currently implies otherwise.

**Operator Disposition: Keith** Use the reviewer's recommendation. Add a durable non-A1
evidence failure axis.

**Suggested adversarial case.** `A2A-INSP-015`: a stored row whose `observation_json` is
altered by one byte with a stale `observation_sha256` produces (a) an integrity failure at
read, (b) a durable failed inspection whose code/subject/operation are the A2a-owned
integrity members, and (c) a repository transition to
`evidence-blocked`/`stored-evidence-digest-mismatch` — with the direct-SQL negative that
an A1-mirrored code cannot be used for that row and the integrity code cannot be used for
an A1-originated failure.

---

### A2a-F-02 — High — `repository_inspections` is an append-only history with no total order; "latest" and "latest successful" are decided by a millisecond timestamp and a random UUID, and demonstrably return the wrong row

**Claim.** §8.2 gives `repository_inspections` a `TEXT` primary key and orders history by
`created_at DESC, id DESC` (`idx_repository_inspections_history`,
`idx_repository_inspections_success_history`). Timestamps in this repository come from
`new Date().toISOString()` (millisecond resolution — `packages/storage/src/migrations.ts:161`
and every service), and every identifier is `randomUUID()`
(`apps/server/src/services/*.ts`, ~30 call sites). Two inspections appended in the same
millisecond therefore tie on `created_at` and are broken by a **random** value.

**Evidence.** Probe (`probe2.mjs`, case 4): three rows sharing one `created_at`, inserted
in the order `ffff-1`, `0000-2`, `aaaa-3`; `ORDER BY created_at DESC, id DESC LIMIT 1`
returns `ffff-1` — the *first* row inserted. Every schema-1/2 append-only journal in this
codebase solves precisely this with `sequence INTEGER PRIMARY KEY AUTOINCREMENT` plus
`id TEXT NOT NULL UNIQUE` (`0001-ct02-foundation.sql:65,108`), and
`plan_import_diagnostics` uses an explicit `ordinal`. `repository_inspections` adopts
neither.

**Consequences.** (a) `reaffirmRepositoryEnvironmentRequestSchema.expectedLatestSuccessfulInspectionId`
is a concurrency guard against an ambiguous referent, so `A2B-REAFF-004` ("stale expected
inspection ID → conflict") can produce a false conflict or a false pass. (b)
`repositoryEvidenceSummarySchema.latestInspectionId` / `latestSuccessfulInspectionId` /
`latestInspectionAt` can flip between two reads with no state change. (c) `A2A-INSP-012`,
`A2A-BASE-006`, and any test asserting "the latest inspection" is order-flaky, and the
flake rate rises with test speed — exactly where it will be misread as a fixture problem.

**Violated invariant.** CT-04A2 §5.3: append-only attempt history. CT-04A2a §3: "append-only
history". A history you cannot totally order is not a history; the plan's §13
`latestForRepository` / `latestSuccessfulForRepository` primitives are unimplementable
deterministically as specified.

**Required design disposition.** Restructure `repository_inspections` on the established
journal pattern: `sequence INTEGER PRIMARY KEY AUTOINCREMENT`, `id TEXT NOT NULL UNIQUE
CHECK (length(id) > 0)`, retaining `UNIQUE (workspace_id, id)` and `UNIQUE (workspace_id,
repository_id, id)` as the composite candidate keys A2b's journal needs (unaffected by the
PK change). Define latest and latest-successful as `MAX(sequence)` and index
`(workspace_id, repository_id, sequence DESC)` plus the partial success variant. A
per-repository monotonic `ordinal` enforced by the insert trigger is an acceptable
alternative if the operator prefers not to add a global sequence.

**Operator Disposition: Keith** Use the reviewer's recommendation. A global sequence is
acceptable for this app considering the audience is only me.

**Suggested adversarial case.** `A2A-INSP-016`: append three inspections for one
repository inside a single transaction with an injected fixed clock so all three share
`created_at`; `latestForRepository` and `latestSuccessfulForRepository` must return the
third, and the assertion must hold for at least two distinct ID orderings (ascending and
descending) so a random-UUID tiebreak cannot pass by luck.

---

### A2a-F-03 — High — The storage insert primitives return bare records, so every idempotency, conflict, and non-disclosure outcome the parent contract requires collapses into a raw SQLite exception

**Claim.** §13 declares `repositories.register(input): RegisteredRepository`,
`inspections.append(input): RepositoryInspection`, and
`bindings.insert(input): ProjectRepositoryBinding`. Only the *update* primitives return
typed results (`RepositoryMutationResult`, `RepositoryRetirementResult`,
`BindingMutationResult`), and §11.5's "typed storage conflict/no-op result" is scoped to
"a zero-row result", i.e. updates. An insert therefore either returns a row or throws.
That single throw has to carry at least five distinguishable outcomes:

```text
same-workspace, same identity, still active   → idempotent existing (A2B-REG-005)
same-workspace, same identity, non-active     → conflict, guidance to inspect/reaffirm/retire (A2B-REG-006)
foreign workspace holds the live identity     → nondisclosing 409, no foreign audit (A2B-REG-007)
concurrent same-path registration             → one wins, other idempotent/conflict, no duplicate history (A2B-REG-009)
same project already actively bound elsewhere → conflict, not idempotent (A2B-BIND-004 vs A2B-BIND-005)
```

Three of the three global identity indexes and the active-project index all raise the same
`SQLITE_CONSTRAINT_UNIQUE`. Distinguishing them requires parsing SQLite error text for
index names.

**Evidence.** §13 signatures; §11.5 scope; §7.3 `registerRepositoryResponseSchema.created`
and `bindProjectRepositoryResponseSchema.created` — the plan already *reserves* the
idempotent result in the wire contract but provides no storage-layer type that can produce
it. §8.1 and §8.3 index definitions. Protected cases `A2B-REG-005/006/007/009`,
`A2B-BIND-004/005`.

**Violated invariant.** AGENTS.md: "Public contracts have runtime validation"; "Add
interfaces at real authority or dependency boundaries." CT-04A2 §7 requires exact mapping,
not message inspection. `A2B-REG-007`'s non-disclosure becomes an accident of error-string
formatting — the highest-consequence failure mode here, because a leaked owning
workspace or path is a cross-tenant disclosure, not a bug.

**Required design disposition.** `register`, `insert`, and `append` must return
discriminated results computed from explicit pre-checks inside the same immediate
transaction, e.g.

```ts
type RepositoryRegistrationResult =
  | { kind: 'created'; repository: RegisteredRepository }
  | { kind: 'existing'; repository: RegisteredRepository }          // same workspace, same identity, active
  | { kind: 'conflicting-local-state'; status: RepositoryStatus }   // same workspace, non-active
  | { kind: 'identity-reserved-elsewhere' };                        // carries NO workspace/repository/path
```

The `identity-reserved-elsewhere` variant must be non-disclosing **by construction** — no
foreign workspace ID, repository ID, canonical path, or fingerprint in the payload — so
A2b cannot leak it even by accident. The residual uniqueness index remains as the
fail-closed backstop for a lost race, and the accepted plan must state which
outcome a backstop violation maps to.

**Suggested adversarial case.** `A2A-REP-015`: for each of the three global identity
reservations and the active-project index, assert the typed result variant (not the
exception) for a same-workspace-active, same-workspace-non-active, and foreign-workspace
collision; plus a structural assertion that the `identity-reserved-elsewhere` value's
serialized form contains no substring of the colliding row's workspace ID, repository ID,
or canonical paths.

---

### A2a-F-04 — High — The pure reducer's `reaffirm-environment` command carries no evidence, so the domain layer will bless a reaffirmation of a core-mismatched or unchanged repository

**Claim.** §6.4 defines `RepositoryStateCommand` as `{kind:'reaffirm-environment'}` with no
payload. The reducer table maps `identity-evidence-changed` + reaffirm →
`active`/`environment-evidence-reaffirmed` **unconditionally**. The pure layer therefore
cannot distinguish a fresh core-matching observation from one whose core identity has
changed, or from one that is byte-identical to the accepted baseline. Both are governed by
the parent contract, and both are pushed entirely into A2b's sequencing discipline.

**Evidence.** §6.4 `RepositoryStateCommand` and reducer table row
"`identity-evidence-changed` | reaffirm | active / `environment-evidence-reaffirmed`".
Contrast CT-04A2 §6: "identity-evidence-changed | **Owner reaffirms a fresh
core-matching observation** | active with new environmental baseline", and A2B-REAFF-005:
"fresh core differs → identity-mismatch, no reaffirm", A2B-REAFF-006: "fresh evidence
matches old baseline again → ordinary inspect may restore active; **reaffirm not
needed**".

Note the database *does* block the worst version of this: §11.1's reaffirmation branch
requires the new baseline inspection to match every immutable core projection, so a
core-mismatched reaffirmation cannot advance the baseline. But the reducer — the artifact
`A2A-STATUS-014` is written against — returns a transition, and the two layers then
disagree.

**Violated invariant.** `A2A-STATUS-014`: "every unknown state, event, difference,
failure, or pairing is an explicit error, **never a default transition**." CT-04A2a §1:
"invalid … transitions impossible or explicitly detectable at the database/domain
boundary".

**Required design disposition.** Make the command evidence-bearing:

```ts
| { readonly kind: 'reaffirm-environment'; readonly assessment: RepositoryObservationAssessment }
```

and permit the transition only for `assessment.kind === 'environment-evidence-changed'`.
`core-identity-changed` under a reaffirm command must yield the `identity-mismatch`
transition; `same` must yield `rejected`/`reaffirmation-not-required` (which is also the
honest encoding of A2B-REAFF-006); `unavailable`, `evidence-invalid`, and
`no-state-change-failure` must each yield their existing reduction or an explicit
rejection. No branch may fall through.

**Suggested adversarial case.** `A2A-STATUS-015`: from `identity-evidence-changed`, drive
`reaffirm-environment` with each of the seven assessment kinds and assert the exact
reduction for all seven, including that `core-identity-changed` produces
`identity-mismatch` and `same` produces a rejection rather than a reaffirmation.

---

### A2a-F-05 — Medium — Two `apps/server` tests hard-assert schema version 2; migration 0003 breaks them, and they are absent from the target tree

**Claim.** `apps/server/src/restart.test.ts:123` and `:195` assert
`second.storage.migrationStatus.currentVersion).toBe(2)`. `migrationStatus` is computed
from `discoverMigrations()`, which scans the migrations directory, so the moment
`0003-ct04a2a-repository-model.sql` exists both assertions fail. Neither file appears in
§5's target tree, and §5/§19 claim "zero Git, process, HTTP, journal-event, notifier, or
browser authority" and "no server or browser layer".

**Evidence.** `apps/server/src/restart.test.ts:123,195`;
`packages/storage/src/migrations.ts:142-156`; plan §5 target tree; §17's planned commands
include `pnpm test`, which runs them.

**Violated invariant.** CT-04A2a exit gate: "All CT-01 through CT-04A1 tests remain
green." Protocol §4 item 2 (accurate target file tree) and item 12 (predicted scope).

**Required design disposition.** Add `apps/server/src/restart.test.ts` to the target tree
and state the edit (assert `>= 3`, or assert the discovered supported version rather than
a literal). Correct the file count and drop the unqualified "no server changes" phrasing
in §5 and §19 — the honest statement is "no server *production* change; two server
regression assertions are re-pinned." This is a small edit, but it is exactly the class of
omission that turns a green-gate claim into a false one, and the plan's own §19 leans on
the 33-file number.

**Suggested adversarial case.** `A2-SCOPE-003`: a check asserting that no test in the
repository pins `migrationStatus.currentVersion`/`supportedVersion` to a literal, so the
next migration cannot silently break the gate again.

---

### A2a-F-06 — Medium — The plan simultaneously widens `AUDIT_ACTIONS` and pins the schema-2 migration test to migrations 1–2, which makes that test's catalog-equality assertion false

**Claim.** `packages/storage/src/migration-0002.test.ts:231` asserts
`expect(actions).toEqual([...AUDIT_ACTIONS].toSorted())` — the `audit_action_kinds`
catalog equals the whole domain constant. §8.5 adds six actions to both the catalog (at
`introduced_in_schema = 3`) and `AUDIT_ACTIONS`. §14.1 then changes that test to "select
migrations 1 and 2 explicitly". Under that change the catalog has 13 rows and
`AUDIT_ACTIONS` has 19, so the assertion fails. The plan flags the "must not accidentally
apply 3" hazard but not this coupling, which is the reason the hazard exists.

**Evidence.** `packages/storage/src/migration-0002.test.ts:12,231`;
`packages/domain/src/audit.ts:17-32`; `0002-ct03-planning.sql:12-35` (the
`introduced_in_schema` column already exists); plan §8.5 and §14.1.

**Violated invariant.** Same exit-gate clause as F-05; ADR-013's migration-owned catalog
contract.

**Required design disposition.** State the exact reconciliation: the schema-2 assertion
becomes catalog rows with `introduced_in_schema <= 2` equal to the schema-1/2 slice of
`AUDIT_ACTIONS`, and `migration-0003.test.ts` asserts the full sorted `AUDIT_ACTIONS`
equals the whole catalog at schema 3. Do not leave this to implementation discretion — the
alternative fix (keep applying all migrations in the schema-2 test) silently defeats the
isolation §14.1 is trying to buy.

**Suggested adversarial case.** Extend `A2A-MIG-003`: at schema 2 the catalog contains
exactly the `introduced_in_schema <= 2` actions and none of the six repository actions; at
schema 3 it contains all nineteen and every `introduced_in_schema` value is unchanged for
pre-existing rows.

---

### A2a-F-07 — Medium — The transition trigger's timestamp rule rejects legitimate same-millisecond transitions and accepts timestamps that move backwards

**Claim.** §11.1 requires "the new status timestamp differs from the old timestamp". This
repository's clock is `new Date().toISOString()` — millisecond resolution. Two repository
transitions in the same millisecond are therefore **rejected by the database** even though
version `N → N+1` and the status pair are both valid; a retry loop, a batched fixture, or
a fast test will hit it. Simultaneously, `<>` permits a *decreasing* timestamp, so
direct SQL can rewind `status_changed_at` while satisfying every other rule.

**Evidence.** §11.1 transition rule; `packages/storage/src/migrations.ts:161` and the
service call sites establish the clock's resolution. No protected or adversarial case
requires timestamp inequality; `A2A-REP-011` and `A2A-REP-012` are about version and
status/baseline coupling.

**Violated invariant.** Own §11.1 intent (progress must be observable) versus the
invented rule's actual effect. Neither direction is what the plan wants.

**Required design disposition.** Replace with `NEW.status_changed_at >=
OLD.status_changed_at` (monotonic non-decreasing, ISO-8601 UTC strings compare
lexicographically) and rely on `NEW.version = OLD.version + 1` as the sole progress
proof. If the operator wants strict inequality, the accepted plan must first name a
monotonic timestamp source, because the current one cannot satisfy it.

**Operator Disposition: Keith** Use the replacement recommendation the reviewer states.

**Suggested adversarial case.** `A2A-REP-016`: two valid consecutive transitions performed
with one injected fixed clock both succeed and reach version 3; a direct-SQL update that
sets `status_changed_at` earlier than the previous value is rejected.

---

### A2a-F-08 — Medium — Eight A1 vocabularies are duplicated into TypeScript **and** SQL literals with the only parity test deferred to A2b, and the SQL copies can never be compared to A1 without importing Git

**Claim.** §6.2 copies 35 codes, 8 subjects, 4 categories, 4 operations, 3 retryability
values, 14 risk signals, and the 7/2/3 difference names into `packages/domain`. §8.2 then
embeds the same allowlists **again** inside migration SQL, plus a CHECK asserting
`risk_scanned_key_pattern` equals A1's exact `REPOSITORY_RISK_SCAN_PATTERN` and
`risk_scan_scope_version = 1`. §6.2 promises only that "A2b must provide an exhaustive
adapter test against the then-current package-root unions". Storage may not import
`@craftingtable/git`, so the SQL literals have **no** drift detector at all, in A2a or A2b,
unless one is specifically designed. A drifted SQL literal fails closed on every
inspection insert at A2b runtime — the whole feature, discovered late.

**Evidence.** `packages/git/src/types.ts:5-6` (the 190-character pattern is a pinned
literal type), `:8-23`, `:120-156`, `:237-273`; plan §6.2, §8.2 bounds and success rules,
§4.2 prohibited imports.

**Violated invariant.** AGENTS.md: "Shared wire contracts must be runtime-validated and
reusable"; the plan's own claim that these are "durable A2a vocabulary" rather than an
unverified transcription.

**Required design disposition.** Two changes. (1) Relax the SQL check on
`risk_scanned_key_pattern` to non-empty and bounded, and hold exact-value equality in the
domain constant plus the A2b parity test — a 190-character regex duplicated into SQL is a
transcription risk with no upside, since SQLite is not the layer that can meaningfully
validate it. (2) Name a concrete parity mechanism for the enum allowlists: the A2b adapter
test must compare the A1 package-root unions against the A2a domain constants **and**
against the allowlists actually present in the committed migration text (readable as a
string, no import required). Record it as a named deferred case so it cannot be forgotten.

**Suggested adversarial case.** `A2-SCOPE-004` (A2a-side, text-level): a test that reads
`0003-ct04a2a-repository-model.sql` and asserts its embedded code/subject/signal/difference
allowlists are set-equal to the exported A2a domain constants — closing the SQL-vs-domain
half of the gap without importing Git, and leaving only domain-vs-A1 for A2b.

---

### A2a-F-09 — Medium — The `error_evidence_json` key-shape constraint is enforced only in SQL, but A1 does not guarantee it; a non-conforming key converts a benign retryable Git failure into an aborted transaction

**Claim.** §8.2 requires evidence keys to match `[A-Za-z][A-Za-z0-9]*`, at most 16 keys and
8192 bytes, scalars only. A1's contract is
`evidence: Readonly<Record<string, string | number | boolean>>` — scalars are guaranteed
(good), key **shape** is not. Today's keys all conform (`commandKind`, `exitCode`,
`gitMajor`, `gitMinor`, `gitPatch`, `observationVersion`, `recordedPolicyVersion`,
`currentPolicyVersion`, `requestedPath`, `effectiveUid`, …). Nothing keeps it that way. If
a future A1 evidence key contains `.` or `_`, the insert raises, A2b's inspect transaction
aborts, and a `timed-out` or `observation-raced` — explicitly a *no-state-change,
retryable* failure — is escalated to a request failure with no durable evidence at all.

**Evidence.** `packages/git/src/types.ts:192`; `createInspectionError` call sites in
`configuration.ts`, `comparison.ts`, `repository-inspector.ts`; plan §8.2 failure rules and
§6.3 `errorEvidence: Readonly<Record<string, string | number | boolean>>`.

**Violated invariant.** CT-04A2 §6: "`observation-raced`, timeout, process failure … do
not by themselves change repository state. They create bounded failure evidence and audit
only." A hard SQL rejection is not "bounded failure evidence".

**Required design disposition.** Make normalization an explicit, tested A2a
responsibility, not an implicit A2b hope. The failed-inspection write input must take a
pre-normalized evidence map, and A2a must own the normalizer (drop or fold
non-conforming keys, cap count and bytes) with the SQL constraint retained as the
fail-closed backstop. The accepted plan must state that the normalizer never fails: an
unrepresentable evidence map yields a stored failure record with reduced evidence, never a
lost record.

**Suggested adversarial case.** `A2A-INSP-017`: a failure whose evidence contains a
dotted key, a 17th key, and an 8 KiB string is still recorded as a complete failed
inspection with correct classification and truncated/dropped evidence; the SQL backstop
separately rejects a hand-written direct-SQL row that bypasses the normalizer.

---

### A2a-F-10 — Medium — Both repository→inspection foreign keys are deferred although insertion order guarantees the parent already exists, which moves two protected rejections to commit time and hides them from the nested `register` primitive

**Claim.** §8.1 declares both `registration_inspection_id` and
`accepted_environment_inspection_id` links `DEFERRABLE INITIALLY DEFERRED`. Neither needs
to be. §9's order is inspection-first, and reaffirmation points the baseline at an
inspection that already exists. Only `repository_inspections.repository_id` genuinely
requires deferral.

Deferring them costs two things. First, `A2A-REP-003` and `A2A-REP-004` ("registration /
baseline inspection belongs to another repository → composite FK rejects") move from
statement time to commit time, so the reported error is detached from the offending
statement. Second — and this is the part §9's atomicity claim glosses — a deferred
violation inside a nested transaction is **invisible at the nested level**.

**Evidence.** Probe 1 case 5: an inner `db.transaction(...)` that leaves a deferred FK
violated **released without error**, and the violation surfaced only at the outer
`COMMIT`. Probe 2 cases 1–2: with an *immediate* `(ws, id, reg_insp)` FK, the coherent
inspection-first registration still commits, and the sibling-repository case is rejected at
statement time. Probe 2 case 3 confirms a rolled-back nested register does not poison the
outer commit, so the deferral is not needed for cleanup either.

**Violated invariant.** §9's "the storage `register` primitive wraps the pair in a
nested-safe immediate transaction, so it is atomic both standalone and inside A2b's later
outer audit/event transaction" — atomic, yes; locally *diagnosable*, no. Combined with
F-03, a deferred-FK failure inside `register` cannot be turned into a typed result at all,
because the primitive has already returned successfully.

**Required design disposition.** Declare both repository→inspection foreign keys
**immediate** and keep `DEFERRABLE INITIALLY DEFERRED` only on
`repository_inspections.repository_id`. Restate §9's consequences accordingly: the
repository side now fails at statement time, and only the orphan-inspection case is
commit-time. State explicitly in §9 and §11.5 that a deferred violation surfaces at the
**outermost** commit, so A2b never relies on `register` to report it.

**Suggested adversarial case.** Split `A2A-REP-002`: (a) lone inspection with no
repository — assert the insert succeeds and the **COMMIT** raises; (b) repository naming a
sibling repository's inspection — assert the **INSERT statement** raises; (c) `register`
invoked inside an outer transaction with a deliberately orphaned inspection — assert the
outer commit fails and that the primitive itself returned without error, documenting the
attribution boundary rather than pretending it does not exist.

---

### A2a-F-11 — Medium — Every repository response exposes all three canonical host paths to every role, including Viewer, and no reviewed document takes a position on that

**Claim.** §7.3's `repositoryIdentitySummarySchema` puts `canonicalTopLevel`,
`canonicalGitDirectory`, and `canonicalCommonGitDirectory` — absolute host filesystem
paths — inside `registeredRepositorySummarySchema`, which appears in the list response,
the detail response, and all five mutation responses. Per CT-04A2 §8, Viewers may
list/read. A2a is therefore fixing a host-filesystem disclosure surface for the whole
feature, silently, in a slice whose stated scope is persistence.

**Evidence.** Plan §7.3; CT-04A2 §8 authorization table (`List/read … Viewer: yes`).
`docs/security.md:56-67` currently states only that plan sources reject host paths and
that "CT-04A1 does not add a route" — there is no position on repository path disclosure
through an authenticated read. The plan modifies `docs/security.md` (§5) but §16 describes
the edit as "schema 3 is durable but still uncomposed".

**Violated invariant.** AGENTS.md: "the browser receives strict contracts, never A1
observation objects **or host paths as authority**" — displaying three paths is arguably
not authority, but the boundary is being drawn here without being named. CT-04A2's
repeated non-disclosure requirements (`A2B-REG-007`, `A2B-BIND-002`, `A2B-AUTH-005`) show
the contract cares about path disclosure across trust lines.

**Required design disposition.** Operator decision required (see
[Operator decisions](#operator-decisions)). Whatever is chosen, `docs/security.md` must
state it explicitly and a contract test must pin it, so the decision is reviewable rather
than implicit in a Zod object.

**Suggested adversarial case.** `A2A-CON-009`: the repository summary schema contains
exactly the approved identity fields and rejects any additional host-path-shaped field;
plus, if redaction is chosen, that a full `canonicalGitDirectory` fails to parse in the
Viewer-visible projection.

---

### A2a-F-12 — Medium — Nothing marks or closes bindings when a repository leaves `active`, and the binding summary carries no repository status, so a project-scoped projection reads as usable

**Claim.** `project_repository_bindings_initial_state` requires an active repository at
**insert**. No rule touches existing bindings when the repository later becomes
`unavailable`, `identity-evidence-changed`, `identity-mismatch`, or `evidence-blocked`;
only retirement closes them (§11.4). Meanwhile `projectRepositoryBindingSummarySchema`
carries `status: 'active' | 'retired'` and no repository status. A project view rendering
its binding therefore shows an active binding to a terminally mismatched repository with
nothing to indicate it.

**Evidence.** Plan §11.4, §8.3 index `uq_project_repository_bindings_active_project`, §7.3
`projectRepositoryBindingSummarySchema`, and §7.4's own commitment that "`active` means
only that the registered repository's current core and accepted environmental evidence
agree; it never means ready, approved, executable, verified, reviewed, or mergeable" —
which is asserted about the *repository* status and then not carried to the binding.

**Violated invariant.** `A2A-CON-005` (no false readiness claims) and CT-04A2a §1's
requirement that invalid graphs be "impossible or explicitly detectable". Keeping the
binding open is the right durable choice — history must not be rewritten by a status
change — but the *projection* must not read as readiness.

**Required design disposition.** Keep bindings open, and require any project-scoped
binding projection to carry the bound repository's current `status`/`statusReason` (or an
explicit derived `usable: false` discriminant) so a consumer cannot read binding
`status: 'active'` as repository usability. Add a §7.4 sentence stating that an active
binding to a non-active repository is a normal, expected state and what it does not imply.

**Suggested adversarial case.** `A2A-BIND-013`: bind an active repository, transition the
repository to `identity-mismatch`, then assert the binding remains active and immutable
**and** that its projection reports the repository's non-active status; plus a contract
negative that a binding summary without repository status is rejected wherever it is
returned outside a repository detail envelope.

---

### A2a-F-13 — Low — `latestInspectionId`/`latestInspectionAt` are modelled optional but are always present

Every repository is created with a registration inspection (§9), so
`repositoryEvidenceSummarySchema.latestInspectionId`, `latestInspectionAt`,
`latestSuccessfulInspectionId`, and `latestSuccessfulInspectionAt` can never legitimately
be absent. Dead optionality invites A2b to omit them and invites a consumer to handle a
branch that cannot occur. **Disposition:** make all four required, or state the concrete
case in which they are absent. **Case:** `A2A-CON-010` — an evidence summary omitting
latest-inspection fields is rejected.

**Operator Disposition: Keith** Make all four required.

### A2a-F-14 — Low — The double-inspection quiescence proof is nowhere durable

CT-04A2 §5.3 stores "the second of two matching successful inspections". §6.3 omits
comparison arrays for `kind='registration'`, so the first observation and the equality
proof survive nowhere in schema 3. `A2B-REG-002/003/004` are then provable only at the
service layer and unauditable afterwards. **Disposition:** state explicitly where the
quiescence proof is durably recorded (A2b audit metadata is acceptable) or acknowledge in
§6.3 that it is not, so a later reader does not assume the registration row proves
quiescence. **Case:** `A2A-INSP-018` — a registration inspection has all three comparison
columns NULL, and the plan text names the artifact that does record the equality.

### A2a-F-15 — Low — The inspection `kind` recorded when a reaffirm attempt discovers a core mismatch is unstated

`repository_inspections_parent_state` allows `kind='verification'` from
`identity-evidence-changed`, so A2b may append either kind during a reaffirm command. A
successful `kind='reaffirmation'` row that did **not** advance the baseline is therefore
storable and reads as an accepted reaffirmation. The transition trigger correctly blocks
the baseline advance (§11.1), so this is a legibility defect, not a state defect.
**Disposition:** state that `kind='reaffirmation'` is written only for an attempt that
advances the baseline in the same transaction, and that a reaffirm attempt which discovers
any other assessment records `kind='verification'`. Consider a trigger requiring every
successful `kind='reaffirmation'` row to be the repository's accepted baseline by the end
of its transaction. **Case:** `A2A-BASE-009` — a successful `kind='reaffirmation'`
inspection that is not adopted as the baseline is rejected (or, if permitted, is proven not
to be readable as an accepted reaffirmation).

### A2a-F-16 — Low — The scope assertion must cover A2a **test** files, which the existing checker exempts

`scripts/check-forbidden-scope.mjs` lists `@craftingtable/git` in
`NON_PRODUCTION_PACKAGES`, but `isTestModule` exempts every `*.test.ts`, so a storage or
domain **test** may import Git today. `A2-SCOPE-001` is production-scoped, while CT-04A2a
§4 forbids the import in "domain, contracts, or storage" without qualification. Separately,
`packages/storage/src/repository-test-support.ts` is neither a `.test.ts` file nor listed
in `EXISTING_TEST_CAPABILITY_MODULES`, so it will be classified as production — which is
correct here (it needs no capability) but should be deliberate. **Disposition:** the new
A2a assertion must forbid `@craftingtable/git` anywhere under
`packages/{domain,contracts,storage}`, tests included, and the plan must state the
classification of `repository-test-support.ts`. **Case:** extend
`scripts/check-forbidden-scope.test.mjs` with a fixture proving a *test* file importing
`@craftingtable/git` under those three packages is a violation.

### A2a-F-17 — Low — `sqlite_sequence` preservation must be stated as "existing rows unchanged"

§14.1 requires the migration to "preserve … sqlite_sequence values". Creating new tables
(and, under F-02, an `AUTOINCREMENT` table) legitimately adds `sqlite_sequence` rows on
first insert. **Disposition:** restate as "every pre-existing `sqlite_sequence` row is
unchanged and no pre-existing counter is reset", so the assertion is falsifiable and not
accidentally strict.

### A2a-F-18 — Low — Requiring `expectedVersion` on inspect is an invented strictness with unstated ordering

`inspectRepositoryRequestSchema` requires `expectedVersion`, yet §11.1 says the common
inspection paths (matching evidence, risk-only, repeated failure, `observation-raced`)
perform **no** repository update, so there is often no version to conflict with. Whether a
stale version rejects before or after the A1 subprocess runs is unstated, and no protected
case requires the field. **Disposition:** operator decision (below); whichever is chosen,
state the check's position relative to the A1 call, because that determines whether a stale
client can cause host inspection.

### Info

- **A2A-MIG-007** ("accepted snapshot/SSE reconstruction remains unchanged") has no named
  home in §5's target tree. Storage-level `packages/storage/src/snapshot.test.ts` is
  unlisted and server SSE tests are out of scope; §15 requires every protected ID to
  appear in a test name. Name the file.
- **Archived workspaces.** No A2a trigger checks `workspaces.status`, so a repository can
  be registered in and bound within an archived workspace at the database level. This
  matches CT-03 precedent (`projects` has no such check) and §12.1 gestures at it, but the
  accepted plan should state it as a deliberate structural choice deferred to A2b policy.
- **§3's export list reads as exhaustive but is a subset.** The real package root also
  exports `CoreEvidenceDifference`, `EnvironmentalEvidenceDifference`, `RiskScanDifference`,
  `RepositoryInspectionErrorCategory`, `RepositoryInspectionOperation`,
  `RepositoryInspectionRetryability`, `RepositoryObservationShape`,
  `RepositoryRiskScanObservation`, `RepositoryRiskSignal`, `RepositoryInspectionRequest`,
  `RepositoryInspectorCreationResult`, and `RepositoryObservationComparison`. Harmless, but
  §3 is the reconciliation of record and A2b will read it as complete.
- **New delete restriction.** The membership foreign keys mean a `workspace_memberships`
  row referenced by any repository, inspection, or binding can no longer be deleted
  (`ON DELETE RESTRICT`). Nothing deletes memberships today; worth one sentence in ADR-017.

## Violated invariants and unmet cases, by axis

| Axis | Status | Detail |
|---|---|---|
| A2a/A2b split honesty | **Affirmed** | Nothing in §5–§13 requires Git, process, HTTP, event, notifier, or browser authority. §18's deferral list is accurate against CT-04A2b and the source map. |
| Domain/storage independence from Git and server authority | **Affirmed, with F-08/F-16** | Dependency graph is clean; the vocabulary duplication has no drift detector and the scope assertion does not reach tests. |
| Complete repository status and reason semantics | **Gap (F-01)** | Six statuses × thirteen reasons are complete and exactly coupled, but one reason has no expressible evidence record. |
| Circular registration linkage and deferred-FK correctness | **Correct, over-deferred (F-10)** | Mechanism verified by probe. Two of three deferrals are unnecessary and degrade attribution. |
| Full-record integrity and exact-byte behavior | **Affirmed** | §10 is the strongest section: exact stored string, digest over those bytes, no canonicalization claim, explicit refusal of a hostile-database authenticity claim, and correct statement that SQLite can verify neither the digest nor projection semantics. |
| Structural workspace/repository/inspection/binding ownership | **Affirmed** | Composite keys throughout; the A2b journal candidate keys are all present. |
| `MATCH SIMPLE` and nullable dimensions | **Affirmed** | The only nullable FK column is `retired_by_user_id`; the composite membership key is correctly skipped when NULL and coupled to retired status by CHECK — the CT03-R2R1 lesson applied correctly. All other FK columns are `NOT NULL`. |
| Immutable inspection success/failure coupling | **Affirmed, with F-09** | All-or-nothing coupling, registration-vs-comparison coupling, and append-only triggers are complete; the evidence key constraint can reject genuine A1 evidence. |
| Environmental baseline and reaffirmation state | **Gap (F-04, F-15)** | Storage rules are sound and correctly distinguish reaffirmation from "evidence returned"; the reducer is not evidence-bearing and the recorded `kind` is ambiguous. |
| Retirement and binding-retirement invariants | **Affirmed, with F-12** | Bindings-first ordering, terminal retired, identity-reservation release, and independent binding retirement are all correct. Projection readability is the gap. |
| Exact version increments and concurrency | **Gap (F-02, F-03, F-07)** | Version arithmetic is exact and the concurrency table is right, but "latest" has no total order, insert conflicts have no typed result, and the timestamp rule misfires. |
| Migration preservation | **Gap (F-05, F-06, F-17)** | The preservation matrix is thorough; two existing test couplings are unaccounted for. |
| Strict contracts and false-readiness prevention | **Gap (F-11, F-12, F-13)** | `z.strictObject` throughout, no process/Git/argv fields, CT-03 draft literals preserved, `active` explicitly de-scoped from readiness. Host-path disclosure and binding-projection readability are unresolved. |
| Protected-case coverage | **91/91 mapped** | Every A2a ID appears with a named assertion and a file. Six IDs are weakened by the findings above (`A2A-INSP-013`, `A2A-REP-002/003/004`, `A2A-BASE-006`, `A2A-STATUS-014`). |
| Target-tree scope | **Understated (F-05)** | At minimum `apps/server/src/restart.test.ts` is missing. |

### Relationship-matrix audit (§12)

I re-derived all seven required cases for each of the six relationships. §12 covers them
and the answers are correct, with three exceptions already filed:

- **12.2 / 12.3 / 12.4 "same workspace, wrong parent":** the reasoning is right, but the
  *timing* is misstated as "statement/commit" without saying which — F-10.
- **12.1 / 12.6 "retired or non-active parent":** the historical-membership answer is
  correct and well-argued (`workspace_memberships` keeps revoked rows with
  `UNIQUE(workspace_id, user_id)`, verified in `0001-ct02-foundation.sql:23-36`), so a
  revoked member remains valid attribution. Archived *workspaces* are not addressed (Info).
- **12.5 "retired or non-active parent":** correct at insert; silent about existing
  bindings when the parent later leaves `active` — F-12.

Per-transition cases (stale version, reverse transition, self-update, delete) are covered
for repositories (§11.1, §14.2), bindings (§11.4), and inspections (§11.2 — no mutable
version, all updates rejected). The **self-update** case is the weakest: §11.1 says "No
same-status reason rewrite is a transition" and lists a no-op update as aborting, but the
mechanism is the same timestamp rule F-07 asks you to change. State explicitly which
predicate rejects a self-update once the timestamp rule is relaxed — `NEW.version =
OLD.version + 1` combined with the exact old/new/reason triple table does reject it, and
that should be the stated reason rather than the timestamp.

## Coverage gaps

1. **No test can fail on F-01 through F-04, F-12, or F-13** — the design does not contain
   the record, key, result type, command payload, or field the test would check. This is
   the substantive reason the 91-case inventory does not amount to approval.
2. **No total-order test.** Nothing in §15 exercises two inspections sharing a
   `created_at`, so the F-02 defect passes the entire listed suite. See `A2A-INSP-016`.
3. **No typed-conflict test.** §14.2's concurrency row asserts "one registration/binding
   winner" but never asserts *what the loser receives*. `A2B-REG-005` vs `006` vs `007`
   are distinguished nowhere in A2a, though A2a owns the primitive that must distinguish
   them. See `A2A-REP-015`.
4. **No SQL-vs-domain vocabulary parity test.** F-08. See `A2-SCOPE-004`.
5. **No evidence-normalization test.** F-09; §14.2 tests only that malformed evidence is
   *rejected*, never that a benign failure with awkward evidence is still *recorded*. See
   `A2A-INSP-017`.
6. **`A2A-MIG-007` has no named location.** Info.
7. **No test pins the disclosure surface.** F-11; `A2A-CON-004` accepts a repository
   response containing all three host paths without asserting that this is the intended
   boundary. See `A2A-CON-009`.
8. **Trigger-existence versus trigger-behavior.** §8.4 says "merely observing that a
   trigger exists is not proof of its behavior" and promises positive and negative paths
   for all thirteen. Hold the implementation to that literally: thirteen triggers with
   json_each-based allowlist, sort, and uniqueness logic is a large volume of SQL whose
   only proof is direct-SQL negatives. My probe confirms the *mechanism* works
   (`json_each` in a trigger body, including the `group_concat` sorted-order idiom), so
   there is no technical obstacle — only the discipline of writing every negative.

## Scope assessment

**The split is honest and A2a should not fan out further.**

I checked for A2b behavior hiding inside A2a and found none. There is no inspector
creation, no Git or `child_process` import, no route, no service, no audit or event write,
no notifier, no `workspace_events` change, no browser file. Migration 0003 adds three
tables and six catalog rows and touches no journal — which is exactly what guidance §6
asks for and is what keeps A2a independently buildable. The domain, contract, and storage
changes are three projections of one repository evidence model, and §19's argument that
splitting circular linkage from baseline from binding would leave an unusable intermediate
schema is correct: `registered_repositories` cannot commit at all without
`repository_inspections`, so there is no smaller coherent unit.

Two qualifications:

- **The file count is understated.** 33 becomes at least 34 (F-05), and F-01 through F-04
  each add production surface: a new vocabulary axis, a table restructure, new result types
  in `repository-types.ts`, and a reducer command shape. I would expect 35–37 files and the
  upper half of the 6,000–9,000-line band. That is still far below the ~45-file trigger and
  well below the protocol's 60-file threshold, so the conclusion does not change — but §5
  and §19 must be re-costed rather than restated.
- **The stop conditions in §5 and §19 are correctly framed** as conditional and
  falsifiable ("a second migration, more than roughly 45 files, Git/server/browser
  composition, a second persistence model, or inability to express the commit-time graph").
  None is triggered. The last one is now *positively* verified rather than assumed, by
  probe.

One genuine simplification is available and worth taking: adopting F-10 removes two of the
three deferred foreign keys, which shrinks the hardest-to-review part of §9 while making
two protected rejections statement-local.

## Operator decisions

These four require your judgement; the rest are technical dispositions the implementer can
carry out once accepted.

1. **Host-path disclosure (F-11).** Does the Viewer-visible repository summary expose all
   three canonical host paths, only `canonicalTopLevel`, or a redacted/basename form with
   full paths restricted to Owner? My recommendation: expose `canonicalTopLevel` to all
   readers and restrict `canonicalGitDirectory`/`canonicalCommonGitDirectory` to Owner —
   the two Git-directory paths are diagnostic detail whose only reader is an administrator,
   while the top level is what makes a repository recognisable in a list. Whatever you
   choose, `docs/security.md` must state it and a contract test must pin it.
   
   **Operator Disposition: Keith** Exposing `canonicalTopLevel` to all readers and restrict
   `canonicalGitDirectory`/`canonicalCommonGitDirectory` to Owner.

2. **F-01's shape.** Add an A2a-owned `stored-evidence-integrity` failure axis (my
   recommendation — it keeps the "every inspection becomes immutable evidence" invariant
   true), or accept that a digest-mismatch transition records no inspection row and say so
   explicitly in §6.2 and ADR-017.
   
   **Operator Disposition: Keith** Please add an A2a-owned `stored-evidence-integrity`
   failure axis.

3. **F-02's mechanism.** Journal-style `sequence INTEGER PRIMARY KEY AUTOINCREMENT` (my
   recommendation — it matches `audit_events`/`workspace_events` precedent exactly and A2b
   will want a stable cursor anyway), or a per-repository monotonic `ordinal` enforced by
   the insert trigger. The second keeps `id TEXT PRIMARY KEY` but adds trigger complexity
   and a per-repository serialization point.
   
   **Operator Disposition: Keith** Use the reviewer's recommendation.

4. **F-18: `expectedVersion` on inspect.** Keep it and reject stale versions **before** the
   A1 call (my recommendation — a stale client should not be able to cause host process
   execution), keep it and check after, or drop it since the common inspection paths change
   no version. If dropped, `A2B-INSP-016`'s serialization must be re-argued from the
   transaction alone.
   
   **Operator Disposition: Keith** Use the reviewer's recommendation. I agree with the take
   that a stale client hsould not be able to cause host process execution.

## Required design changes before the accepted plan

Blocking (must be dispositioned and reflected in the accepted plan and its reconciliation
appendix):

```text
A2a-F-01  add an A2a-owned stored-evidence-integrity failure axis, or state that no row is written
A2a-F-02  give repository_inspections a total order and define latest/latest-successful on it
A2a-F-03  typed discriminated results for register/insert/append; non-disclosing conflict by construction
A2a-F-04  make reaffirm-environment evidence-bearing; permit only environment-evidence-changed
```

Required amendments:

```text
A2a-F-05  add apps/server/src/restart.test.ts to the target tree; re-cost §5/§19
A2a-F-06  state the audit_action_kinds / AUDIT_ACTIONS reconciliation for the schema-2 test
A2a-F-07  replace the timestamp-inequality rule with monotonic non-decreasing
A2a-F-08  relax the SQL risk-pattern check; name a concrete vocabulary parity mechanism
A2a-F-09  make evidence normalization an owned, tested A2a responsibility that never fails
A2a-F-10  make both repository→inspection FKs immediate; state commit-time attribution in §9/§11.5
A2a-F-11  record the disclosure decision in docs/security.md and pin it with a contract test
A2a-F-12  carry repository status into project-scoped binding projections; add the §7.4 sentence
```

Clarifications (text-level):

```text
A2a-F-13  make the four latest-inspection fields required, or name the absent case
A2a-F-14  name where the double-inspection quiescence proof is durable, or state that it is not
A2a-F-15  state which inspection kind a non-advancing reaffirm attempt records
A2a-F-16  extend the A2a scope assertion to test files; classify repository-test-support.ts
A2a-F-17  restate sqlite_sequence preservation as "existing rows unchanged"
A2a-F-18  state where the inspect expectedVersion check sits relative to the A1 call
Info      name A2A-MIG-007's file; state the archived-workspace choice; correct §3's export list;
          note the new membership-delete restriction in ADR-017
```

New adversarial cases proposed for permanent inclusion:

```text
A2A-STATUS-015  seven-assessment reaffirmation matrix
A2A-REP-015     typed conflict variants for all four uniqueness surfaces + non-disclosure assertion
A2A-REP-016     two same-millisecond transitions succeed; backwards timestamp rejected
A2A-INSP-015    digest-mismatch produces a durable, correctly classified failure record
A2A-INSP-016    same-created_at total-order determinism, proven under two ID orderings
A2A-INSP-017    awkward evidence keys still produce a recorded failure with reduced evidence
A2A-INSP-018    registration inspection has NULL comparison columns; quiescence proof located
A2A-BASE-009    non-adopted successful reaffirmation inspection is rejected or provably not readable as accepted
A2A-BIND-013    binding survives repository mismatch and its projection reports repository status
A2A-CON-009     identity field set is exactly the approved disclosure surface
A2A-CON-010     evidence summary omitting latest-inspection fields is rejected
A2-SCOPE-003    no test pins a literal schema version
A2-SCOPE-004    migration SQL allowlists are set-equal to the A2a domain constants
```

`A2A-REP-002` should be split into three timing-explicit sub-cases per F-10.

## Process notes

- `A2-PROC-001` is satisfied by this review. `A2-PROC-002`, `A2-PROC-003`, and
  `A2-PROC-004` correctly remain open; §15's refusal to claim them is right.
- The protected supplement is unmodified: `1000d564…` reproduces, and the plan treats it as
  read-only throughout. No case was reclassified, weakened, or removed. The plan's
  statement that `A2-PROC-005` and `A2-SCOPE-002` are A2b cases rather than omitted A2a
  proofs is correct against the supplement.
- §20's self-nominated challenge list is honest — it names the seven areas most likely to
  be wrong, and four of my findings land inside it (items 1, 2, 4, 7). That is a good
  signal about the plan's self-assessment, and it is why the verdict is "revise" rather
  than "reopen the design".
- Filename note: this review was written to the requested path
  `review-findings/CT-04/CT-042a-design-review.md`. Existing convention is
  `CT-04A1-design-review.md`, so `CT-04A2a-design-review.md` may have been intended.
