# CT-04A2b2a design review

Reviewed proposed plan: `work-items/CT-04/CT-04A2b2a-proposed-implementation-plan.md`
sha256 `3ef9120e09a525a0f7d132979a713dda5ea215bcee054020bb6a0b5efa2f7ba1` (1,014 lines)
Review checkout: `4762c9f553fb7c45927c458810a92d551e63f1cd`, branch `ct-04a2b2a-repository-evidence-boundary`
Plan's planning checkout: `0c1918bafccc47e8d89599ab1486642f235a190e`
Pinned source archive head: `dd9c9699f0d86cae00fc1bf0d054224880c8dbed` (confirmed ancestor of the review checkout)
Worktree clean at review time. No file was modified by this review; the only write is this record.
No probes were run beyond the repository's own read-only gate commands (`pnpm check:scope`,
`pnpm check:protected`) and `git diff --name-only` / `git merge-base` queries.

**Verdict: revise.** Eight Blocking, three High, and four Medium findings. The proposal is
genuinely source-specific rather than contract paraphrase — its A1 error table, numeric bounds,
projection enumeration, and ID coverage all reproduce against the accepted source. The findings
concentrate in four places: where the plan *duplicates* an accepted authority instead of reusing
it, where it asserts a parity or fixture capability the accepted A1 package root does not expose,
where it adds a verification step the contract's stated order does not contain, and where it
anchors an operator-owned protected ID to a proof covering only part of that ID's expected outcome.

Recursive decomposition: **no further fan-out required.** See "Fan-out assessment".

## Verified declared facts

Every immutable pin the plan declares in its §1 reproduces exactly at this checkout:

```text
ce7a101c…  protected/CT-04-protected-acceptance-spec.yaml
1000d564…  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml
255fe8b6…  work-items/CT-04/CT-04A2b-protected-acceptance-supplement.yaml
526df194…  packages/storage/migrations/0003-ct04a2a-repository-model.sql
409553eb…  packages/storage/migrations/0004-ct04a2b-repository-journal.sql
```

Substantive source claims independently confirmed:

- **§12's 35-row error table is exactly right.** It matches `ALL_REPOSITORY_INSPECTION_ERROR_CODES`
  one-for-one, and *every* subject/category/retryability triple matches
  `REPOSITORY_INSPECTION_ERROR_SUBJECTS` composed with `categoryFor` and `retryabilityFor`
  (`packages/git/src/types.ts:209-352`) — including the two counter-intuitive rows: `aborted` is
  host-environment/configuration/retryable, and `observation-raced` is
  repository-unavailable/path-policy/retryable but is correctly resolved to
  `no-state-change-failure` by exact code rather than by subject.
- **§5.4's numeric bounds are exact**, including the asymmetric coherence rules:
  `inspectionTimeoutMs >= 2 * commandTimeoutMs` but `creationTimeoutMs >= commandTimeoutMs`
  (`packages/git/src/configuration.ts:264-302`).
- **§9's projection table is complete for the inspection row** — all 16 observation projections on
  `SuccessfulRepositoryInspection`, with `gitVersion` correctly excluded (no projected column,
  covered by the full-record digest) and the three optional comparison arrays correctly excluded
  as inspection interpretation rather than observation content.
- **The reservedRoots reasoning is correct.** `createRootPolicy` rejects intra-set overlap
  (`packages/git/src/path-policy.ts:222-241`), so a single `[dataDir]` reservation legitimately
  covers both child roots and passing all three would fail.
- **The ambient-`PATH` analysis is correct.** `resolveExecutableCandidates` falls back to
  `dependencies.ambientPath` only when both `gitExecutable` and `executableSearchPath` are
  undefined (`packages/git/src/configuration.ts:145-148`), and an explicit executable short-circuits
  the search path entirely.
- **ID coverage is complete and honest.** 38 acceptance cases carry `slice: CT-04A2b2a`; the
  protected supplement contains the same 38; the adversarial matrices contain 30 A2b2a cases across
  `B2-CONFIG`, `B2-ADAPTER`, `B2A-STORED-EVIDENCE`, and `B2A-ASSESSMENT`. All 38 and all 30 are
  mapped in §14. None invented, none dropped.
- **§2.5's gate claim reproduces.** `pnpm check:protected` fails with `B1-SCOPE-005` violations
  (11 at this checkout, 10 at the plan's checkout as the plan states — the difference is the
  proposal file itself). `pnpm check:scope` passes.
- **§4's budget is internally consistent**: the tree lists exactly 26 entries, the per-area file
  counts sum to 26, and the line ranges sum to 2,130–3,150.

## Findings

Severity meaning: **Blocking** — must be resolved in the accepted plan before implementation
begins. **High** — must be resolved before implementation, but does not change the slice's shape.
**Medium** — should be resolved in the accepted plan; a recorded deferral is acceptable.

---

### B2A-F-01 — Blocking — the proposed manifest gate rule contradicts accepted source

**Claim.** §15's rule that the `@craftingtable/git` workspace dependency must "occur only in
`apps/server/package.json`", with a negative fixture proving "a second server manifest
dependency/import fails", will make `pnpm check:scope` fail on unmodified accepted source.

**Evidence.** `packages/testing/package.json:18` already declares `"@craftingtable/git":
"workspace:*"`, consumed by `packages/testing/src/fake-git-service.ts:1` and
`fake-agent-backend.ts:4` under the accepted seam-package exemption
(`scripts/check-forbidden-scope.mjs:488`). Note also that `isForbidden()` — the predicate
`findManifestViolations` uses — tests `FORBIDDEN_PATTERNS`, which does **not** contain
`@craftingtable/git`; the manifest dimension of this rule does not exist today and is genuinely
new work, as the plan implies.

**Violated invariant.** B2-I01, A2B-I01. **Cases:** `B2-SCOPE-001`, `B2A-SRC-010`.

**Required design disposition.** Restate as: exactly one **composed application/production**
manifest edge (`apps/server/package.json`), with the accepted `packages/testing` seam edge
preserved. Assert the seam edge with a positive fixture so a later slice cannot delete it silently.

**Suggested adversarial case.** Add `@craftingtable/git` to `apps/web/package.json` and to
`packages/storage/package.json`; both must fail. Remove it from `packages/testing/package.json`;
that must also fail.

---

### B2A-F-02 — Blocking — duplicate digest and serialization authority instead of reusing the accepted A2a helpers

**Claim.** §9 steps 2–3 and §10 specify that the adapter serializes with `JSON.stringify` and
hashes the resulting UTF-8 bytes itself. That is a second implementation of an authority the
accepted source already owns.

**Evidence.** `packages/storage/src/repository-types.ts:19-37` exports `sha256ExactUtf8`,
`verifyExactUtf8Sha256`, and `serializeRepositoryObservation`, re-exported through `types.ts:24`
→ `index.ts:1` and therefore reachable from the server, which already depends on
`@craftingtable/storage`. These are the functions that produced every stored
`observationJson`/`observationSha256` pair the verifier must accept. A divergence — key ordering,
encoding, a future change to `serializeRepositoryObservation` — makes the daemon emit evidence
that fails its own verification and converts healthy repositories to `evidence-blocked`.

**Violated invariant.** B2-I04, A2B-I03. **Cases:** `B2-ADP-003`, `B2-ADP-004`, `B2A-EVID-001`,
`B2A-EVID-002`, `B2A-SRC-003`.

**Required design disposition.** Mandate reuse: `inspect()` obtains `{observationJson,
observationSha256}` from `serializeRepositoryObservation`; `verifyStored()` uses
`verifyExactUtf8Sha256`. Forbid a server-local hash construction.

**Suggested adversarial case.** A source-level assertion that
`repository-observation-adapter.ts` imports no hashing primitive (`node:crypto`, `createHash`)
and that the digest it produces for a fixture equals `sha256ExactUtf8` of the same bytes.

---

### B2A-F-03 — Blocking — no proof that `inspect()` output survives `verifyStored()`

**Claim.** A2b2a is the sole producer *and* sole verifier of stored observation bytes, yet
nothing in §9, §10, or §13 requires proving that the JSON `inspect()` emits is accepted by
`parseRecordedObservation` and passes all 16 projection comparisons. §13's positive fixture is a
hand-built synthetic record, not adapter output.

**Evidence.** The round trip happens to work today: `createParsedObservation`
(`packages/git/src/comparison.ts:352-372`) spreads the object literal built at
`repository-inspector.ts:461-486`, producing exactly the eleven keys `hasExactKeys`
(`comparison.ts:128-140`) demands. That is an unstated coincidence of A1 internals. A2b2a is
precisely the slice whose purpose is to convert it into a proof.

**Violated invariant.** B2-I04. **Cases:** `B2-ADP-003`, `B2A-EVID-001`.

**Required design disposition.** Add a permanent obligation: `inspect()` success → construct the
`SuccessfulRepositoryInspection` projection → `verifyStored()` returns a verified observation with
all 16 projections equal. This is the highest-value missing test in the slice.

**Suggested adversarial case.** The same round trip after mutating one byte of the serialized
JSON must fail with `stored-evidence-digest-mismatch` before any parse occurs.

---

### B2A-F-04 — Blocking — no permitted path to a valid observation fixture

**Claim.** §13's positive-path fixture strategy ("fixed synthetic observation JSON whose
fingerprint is calculated by the accepted length-prefixed algorithm") has no implementation the
plan's own constraints allow.

**Evidence.** `parseRecordedObservation` recomputes `calculateCoreIdentityFingerprint` and rejects
any record whose `coreIdentity.fingerprintSha256` disagrees (`comparison.ts:257-265`). But
`calculateCoreIdentityFingerprint`, `createParsedObservation`, and `currentInspectionPolicyVersion`
are **not** re-exported by `packages/git/src/index.ts`; only the parser, comparator, factory,
constants, and types are. The plan forbids deep A1 imports (§3) and states "No A1 source or test
file changes in A2b2a" (§2.1), matching the source map. The existing accepted A2a fixture is also
unusable: `packages/storage/src/repository-test-support.ts:39` sets `fingerprintSha256:
sha256ExactUtf8('fingerprint:' + suffix)`, a fabricated value `parseRecordedObservation` will
reject with `recorded-observation-invalid`.

**Violated invariant.** B2-I01 (no deep A1 import), B2-I04. **Cases:** `B2-ADP-003`,
`B2A-EVID-001`, `B2A-ASMT-002`, `B2A-ASMT-003`, `B2A-ASMT-004`.

**Required design disposition.** Resolve **D-1** and record the cost of the chosen option.

**Suggested adversarial case.** Whichever option is chosen, add a test that the fixture builder's
output is accepted by the real package-root `parseRecordedObservation` — so a fixture that drifts
from A1's algorithm fails loudly rather than quietly weakening every positive case.

---

### B2A-F-05 — Blocking — current-policy rejection at `verifyStored()` adds an unauthorized terminal state

**Claim.** §9 step 6 ("require parsed inspection policy to equal the current accepted policy") is
not in the contract's fixed verification order, and its failure mapping produces an unrecoverable
state on any future policy bump.

**Evidence.** CT-04A2b2a §4 fixes the order as load → recompute digest → `JSON.parse` →
`parseRecordedObservation` → compare projections → verify A1/domain semantic parity. Step 6 is an
addition. Its mapping to `evidence-invalid` routes through `reduceRepositoryState` to
`evidence-blocked`, which is **terminal**: `packages/domain/src/repository.ts:601-603` rejects
every subsequent `apply-assessment` and `reaffirm-environment` with `terminal-status`. A2a
deliberately typed `inspectionPolicyVersion` as `number` on both the inspection row and the
repository row (`repository.ts:261,288`; migration 0003 `CHECK (inspection_policy_version BETWEEN
1 AND …)`) precisely so historical policy versions remain representable — a rationale the plan
itself quotes in §8 item 2 and then contradicts in §9 step 6. Separately, because step 6 precedes
step 7, a *tampered* `inspectionPolicyVersion` column reports as a policy mismatch rather than a
projected-column integrity failure, conflating tampering with staleness. The comparison boundary
already owns this judgment: `compareRepositoryObservations` returns
`inspection-policy-version-mismatch` when recorded and current differ (`comparison.ts:279-287`).

**Violated invariant.** B2-I04, B2-I06. **Cases:** `B2A-EVID-004`, `B2-ADP-005`.

**Required design disposition.** Resolve **D-2**.

**Suggested adversarial case.** A stored record that is byte-exact, digest-valid, A1-parseable,
and projection-consistent, but recorded under policy version *N-1*, with the assertion pinning the
chosen behavior — and, if step 6 is retained, a test proving the repository is thereafter
unreachable by inspect and reaffirm.

---

### B2A-F-06 — Blocking — category/retryability parity is not statically provable, and the provider cannot leave `available` on drift

**Claim.** §8 item 8 asserts a startup parity proof that A1's public surface cannot support, and
§7's state machine has no transition out of `available` for the inspect-time drift that §8 item 9
detects.

**Evidence.** A1 exports `ALL_REPOSITORY_INSPECTION_ERROR_CODES` and
`REPOSITORY_INSPECTION_ERROR_SUBJECTS` as runtime values, so code and subject parity is genuinely
checkable at construction. **Category and retryability are not exported** — they are derived by
the unexported `categoryFor` and `retryabilityFor` (`types.ts:318-352`) and surfaced only as type
unions. A closed compile-time table therefore proves the *value sets* match the domain arrays but
cannot detect a change in A1's code→category or subject→retryability derivation; only §8 item 9's
per-error check can, at inspect time. §7's table then offers no arrow out of `available` ("every
caller receives the same port; no further creation"), while `permanently-unavailable` — whose
description includes "unexpected adapter invariant fault" — is reachable only from `creating`.

**Violated invariant.** B2-I01, B2-I05, B2-I06. **Cases:** `B2-ADP-002`, `B2A-SRC-002`,
`B2A-EVID-006`.

**Required design disposition.** (i) State that the category and retryability columns of §12 are
enforced per-error at runtime, not at construction, and that this follows from A1's public
surface. (ii) Define the behavior of an inspect-time invariant fault: either demote
`available → permanently-unavailable` (add the arrow, its concurrency rule, and its test) or
return it per call and say so. (iii) Do not leave it undefined — B2b would inherit an unspecified
systemic-drift behavior.

**Suggested adversarial case.** Package-root module replacement returning an error whose
`retryability` contradicts the policy table, injected *after* the provider reaches `available`;
assert the chosen behavior and that no assessment is guessed from the mismatched error.

---

### B2A-F-07 — Blocking — protected IDs anchored to partial proofs without recorded residual obligations

**Claim.** Several A2b2a-allocated protected IDs have expected outcomes whose operative half is
authorization or HTTP behavior that A2b2a cannot implement, and §14.1 anchors them without
recording the residue.

**Evidence.** The supplement is `authority: operator-owned-read-only` with the rule that
implementers "must not delete, weaken, reclassify, or amend these outcomes." Its A2b2a cases
include:

| ID | Protected expectation | §14.1 anchor | Unproved residue |
|---|---|---|---|
| `B2-CFG-002` / `A2B-CFG-002` | repository operation while disabled → **request** → actionable unavailable | provider `get()` returns bounded discriminant | the request/route half |
| `B2-CFG-003` / `A2B-CFG-003` | **authorized** first use → lazy A1 creation succeeds | first `get()` creates once | the authorization half |

A2B-I02 states the invariant these inherit: "Insufficient role, missing membership, and
foreign-workspace requests return before lazy inspector creation." A2b2a has no authorization
service. The plan already records residuals correctly for `B2-CFG-008` and `A2B-CFG-006`, which
shows the pattern is understood and simply applied inconsistently.

**Violated invariant.** A2B-I02, B2-I03, A2B-I15. **Cases:** `B2-CFG-002`, `B2-CFG-003`,
`A2B-CFG-002`, `A2B-CFG-003`.

**Required design disposition.** Add a deferral register to the accepted plan: for every
A2b2a-anchored protected ID, the portion proved here and the exact named residual carried to B2b.
The protected checker must record the residual so a B2b pass cannot treat these IDs as closed by
the A2b2a anchor alone.

**Suggested adversarial case.** A checker test asserting that an ID carrying a residual is not
reported as fully satisfied by its A2b2a anchor.

---

### B2A-F-08 — Blocking — the cumulative protected-checker transition is under-specified and can dissolve B1's containment proof

**Claim.** §15 states the checker "transitions from B1-only current-worktree inventory to a
cumulative exact A2b2a inventory while preserving B1 hashes/proof anchors" but prescribes no
mechanism. The lowest-effort repair silently destroys the B1 guarantee.

**Evidence.** `verifyCt04A2b1Inventory` (`scripts/check-ct04-protected-package.mjs:558-575`) diffs
the worktree against the fixed base `e3b69c6` and filters through the exact set
`CT04A2B1_ALLOWED_CHANGED_PATHS` (`:107-153`). Every A2b2a file will surface as a `B1-SCOPE-005`
violation. Appending A2b2a paths to that set would make B1's own "no repository service, no route,
no repository production source" inventory permanently admit repository lifecycle files. The plan
flags exactly this risk in its §20 item 6 and then leaves §15 silent on the remedy.

**Violated invariant.** A2B-I15, B2-I15. **Cases:** `B2A-SRC-010`, inherited `B1-SCOPE-005`.

**Required design disposition.** Adopt the two-part structure in "Gate repair strategy" below.
In short: convert B1's inventory to a **frozen pair** (`e3b69c6..b8a5493`) so
`CT04A2B1_ALLOWED_CHANGED_PATHS` never grows again, and add a separate live A2b2a inventory over
`b8a5493..worktree` with its own allowlist. Enumerate production and implementation paths by exact
filename; admit **process-artifact classes by slice-anchored regex**, following the accepted
pattern already in the checker
(`/^review-findings\/CT-04\/CT-04A2b1-(?:initial|remediation(?:-\d+)?)-review\.md$/`). A
slice-anchored regex is narrower than a directory glob and widens no containment.

**Suggested adversarial case.** With the repair in place, add a fabricated
`apps/server/src/routes/repositories.ts` and assert the A2b2a inventory rejects it; and assert
that `CT04A2B1_ALLOWED_CHANGED_PATHS` contains no A2b2a path.

---

### B2A-F-09 — High — `dataDir` is not required to be normalized, so an enabled feature fails late rather than closed

**Claim.** A structurally valid repository group combined with a `CRAFTINGTABLE_DATA_DIR` that is
legal today can start cleanly and then permanently disable repository operations at first use.

**Evidence.** `dataDirectory()` (`apps/server/src/config.ts:31-42`) validates only `isAbsolute`
for the override and does not normalize; a trailing slash or a `.`/`..` component passes. The plan
then passes `[dataDir]` verbatim as A1 `reservedRoots`, where `createRootPolicy` →
`validateConfiguredPath` → `isNormalizedAbsolutePath` (`path-policy.ts:94-99`) rejects it with
`invalid-root-policy` — subject `policy-configuration`, retryability `configuration-required` —
which the plan's own §7 policy caches as permanently unavailable until restart. That is fail-late,
not fail-closed. (The default and `XDG_DATA_HOME` paths are safe because `join` normalizes; only
the explicit override is exposed.)

**Violated invariant.** A2B-I13, B2-I02. **Case:** `B2-CFG-005`.

**Required design disposition.** When `repositoryFeature.enabled` is true, validate at startup
that `dataDir` satisfies the same normalized-absolute predicate the reserved root requires. Do not
change behavior when the feature is absent — CT-01..CT-03 startup must be untouched.

**Suggested adversarial case.** A valid repository group plus `CRAFTINGTABLE_DATA_DIR` with a
trailing separator and, separately, with a `..` component; both must fail `configFromEnv()`.

---

### B2A-F-10 — High — the Git-resolution rule is stated three times with two different meanings

**Claim.** §5.3 says startup fails for a group "without both `GIT_BIN` and `GIT_SEARCH_PATH`",
which reads as *both mandatory*. The next paragraph says "at least one explicit resolution
variable is mandatory". §14.1's `A2B-CFG-005` row says "adapter never omits both". This determines
whether a config supplying only `CRAFTINGTABLE_GIT_BIN` starts or fails.

**Evidence.** The accepted A1 semantics support the "at least one" reading:
`resolveExecutableCandidates` consults ambient `PATH` only when both options are undefined
(`configuration.ts:145-148`), so one explicit variable is sufficient to eliminate ambient
resolution.

**Violated invariant.** A2B-I13. **Cases:** `B2-CFG-004`, `A2B-CFG-005`.

**Required design disposition.** State once: an enabled group must supply at least one of
`CRAFTINGTABLE_GIT_BIN` or `CRAFTINGTABLE_GIT_SEARCH_PATH`; supplying both is legal and the
explicit executable wins; supplying neither is a startup error because A1 would otherwise consult
ambient `PATH`. Enumerate the resulting `B2-CFG-004` failure set.

**Suggested adversarial case.** Enabled group with only `GIT_BIN` (starts), only `GIT_SEARCH_PATH`
(starts), both (starts, executable wins), neither (startup error).

---

### B2A-F-11 — High — the internal stored-integrity reason union is never enumerated and B2b's durable tuple is left to invention

**Claim.** §6 promises a "closed stored-integrity reason" and §9 a "bounded field discriminator",
but neither enumerates the union, and nothing states what B2b must durably write.

**Evidence.** Guidance §2.4 requires the failure result to distinguish seven conditions. The plan
correctly collapses several at the *assessment* level — permitted by guidance provided the mapping
is documented, and §9 does document it — but leaves the internal union unnamed. This matters
because the accepted domain taxonomy is asymmetric: `FailedRepositoryInspection` carries
`errorOrigin: 'a1' | 'storage-integrity'`, subject `stored-evidence-integrity`, and operation
`verify-stored-record`, yet `STORED_REPOSITORY_INSPECTION_ERROR_CODES` adds exactly **one**
storage-integrity code, `stored-evidence-digest-mismatch` (`repository.ts:151-156`). A
projected-column mismatch or invalid stored JSON has no dedicated durable code, and migration 0003
does not constrain the value (`error_code` is unconstrained `TEXT`). B2b will otherwise invent the
tuple.

**Violated invariant.** B2-I04, B2-I06. **Cases:** `B2-ADP-005`, `B2-ADP-006`, `B2A-EVID-003`,
`B2A-EVID-004`, `B2A-EVID-005`.

**Required design disposition.** Enumerate the closed internal reason union and give a table
mapping each member to both the `RepositoryObservationAssessment` and the exact durable
`(errorOrigin, errorCode, errorSubject, errorCategory, errorOperation, errorRetryability)` tuple
B2b must write — widening no accepted vocabulary.

**Suggested adversarial case.** One test per union member asserting its assessment and its durable
tuple, and a test that no member maps to a code outside
`STORED_REPOSITORY_INSPECTION_ERROR_CODES`.

---

### B2A-F-12 — Medium — repository-row ↔ inspection-row projection agreement is unowned

**Claim.** `verifyStored(inspection)` cannot detect a repository row whose identity columns
disagree with its own accepted baseline inspection, so verification would report `same` on a
tampered identity of record.

**Evidence.** `RegisteredRepository` (`repository.ts:250-270`) duplicates **nine** observation
projections: `canonicalTopLevel`, `canonicalGitDirectory`, `canonicalCommonGitDirectory`,
`objectFormat`, `topLevelInode`, `commonDirectoryInode`, `coreFingerprintSha256`,
`observationVersion`, `inspectionPolicyVersion`. It carries no `observedAt`, no devices, and no
risk fields — the shared set is exactly the core-identity-plus-version subset, the identity of
record. That set is invariant by construction: A2B-I09 requires a core-matching observation for
reaffirmation, so baseline advance moves environmental evidence only. B2-I04's "compares every
projected identity, environment, risk, version, and policy field" and the contract's §2 outcome
"compare parsed observation fields against every accepted A2a projected field" both reach it. The
port's signature makes delegation impossible, so B2b would reimplement comparison outside the sole
adapter or skip it.

**Violated invariant.** B2-I04, B2-I01. **Cases:** `B2A-SRC-005`, `B2A-EVID-005`.

**Required design disposition.** Resolve **D-4**. If (a), prefer a *separate* port method over
widening `verifyStored`, with the results chained by type so skipping is structurally impossible:

```text
verifyStored(inspection)                  -> VerifiedStoredRepositoryObservation
verifyRegisteredIdentity(repo, verified)  -> VerifiedRepositoryBaseline
compare(baseline, current)                -> ...   // accepts only VerifiedRepositoryBaseline
```

This is the same construction the plan already uses to make `VerifiedStoredRepositoryObservation`
unforgeable. Map the new reason to `evidence-invalid / stored-evidence-invalid`, documenting the
reuse as guidance §2.4 requires. Do **not** extend the check to
`registrationInspectionId`/`acceptedEnvironmentInspectionId` referential integrity — migration
0003's composite foreign keys already enforce that structurally.

**Suggested adversarial case.** Single-field mutation over each of the nine shared columns on the
repository row, with the inspection row untouched and internally consistent; each must fail
without leaking the stored or parsed value.

---

### B2A-F-13 — Medium — `compare()`'s internal reparse-failure result is unspecified

**Claim.** §6 and §10 describe `compare()` reparsing both inputs through A1 as an anti-cast
defence, but never say what it returns when a value that already passed verification fails
reparse.

**Evidence.** Both inputs are server-owned types the adapter itself constructed, so a reparse
failure is an internal invariant violation, not evidence corruption. Unspecified, the defensive
check can itself manufacture `evidence-blocked`.

**Violated invariant.** B2-I06. **Case:** `B2A-EVID-006`.

**Required design disposition.** Name the internal reason and its assessment. It should be an
adapter invariant fault, not an identity judgment.

**Suggested adversarial case.** A structurally cast wrapper whose JSON no longer parses, passed to
`compare()`; assert the invariant-fault result and that no repository state judgment is produced.

---

### B2A-F-14 — Medium — `B2-CFG-005`'s startup failure set is deferred without enumeration

**Claim.** §5.3 moves existence, realpath, symlink-component, UID, executable, Git-version, and
colon-ceiling checks to lazy first-use. The decision is **correct** — duplicating filesystem policy
in `config.ts` would create a second path-policy authority against B2-I01 — but the plan does not
enumerate what remains provable at startup, and the load-bearing half of "fails closed" is only
implied.

**Evidence.** `isGitCeilingDirectoryRepresentable` rejects any source root containing `:`
(`packages/git/src/environment.ts:10-12`), and `validateConfiguredPath` requires source roots to
exist as real non-symlinked directories (`path-policy.ts:143-186`). Both fail at creation, not at
startup, producing `invalid-root-policy` — `configuration-required`, hence permanently unavailable.

**Violated invariant.** A2B-I13, B2-I02. **Case:** `B2-CFG-005`.

**Required design disposition.** Enumerate the exact startup-failing inputs (relative,
non-normalized, duplicate, ancestor-overlapping, dataDir-overlapping, more than 32, NUL,
over 4096 bytes, empty) and add tests proving that an environmentally invalid root yields
**permanently-unavailable**, never `disabled`.

**Suggested adversarial case.** Enabled config whose source root does not exist; whose root has a
symlinked ancestor component; and whose root contains `:`. Each must start the daemon and then
return a bounded permanent failure on first `get()` — never `feature-disabled`.

---

### B2A-F-15 — Medium — no provider or port injection seam is defined for composition

**Claim.** §7 says composition creates one provider per runtime; §13 says the provider test uses a
server-owned fake port factory and a monotonic fake clock. `ServiceOverrides`
(`apps/server/src/composition.ts:30-34`) has no entry for either, so it is unclear whether the
provider is constructible under test through composition or only directly.

**Evidence.** B2b will require this seam to test authorization-before-host-access with an injected
observation port, as guidance §8 anticipates.

**Violated invariant.** None directly; forward-compatibility with A2B-I02. **Case:** `B2-CFG-006`.

**Required design disposition.** State the seam now, or state explicitly that B2b adds it.

**Suggested adversarial case.** None required beyond the existing provider tests.

## Focus-area assessment

| Focus area | Assessment |
|---|---|
| optional feature configuration | Substantially complete; the 12-variable group is minimal and justified. Blocked by B2A-F-09, B2A-F-10, B2A-F-14. The deviation from guidance §2.1 — a server-owned config type instead of embedding `RepositoryInspectorOptions` — is **correct and should be preserved**: embedding the A1 type would place an A1 import in `config.ts` and break the single-adapter rule. |
| one and only one production A1 adapter | Correct in design: exact path, package root only, no barrel re-export, and type/dynamic/require/re-export variants all covered. The gate rule itself is wrong (B2A-F-01). |
| provider concurrency and failure cache | The strongest section. All six states carry concurrency, retry, and restart behavior; shared-promise fan-in, caller-cancellation independence, injected monotonic clock, no backoff, no stale-success eviction — all consistent with contract §4. Sole gap: no exit from `available` (B2A-F-06). |
| full A1/domain semantic parity | Code, subject, risk, difference, and version parity are genuinely startup-provable against exported runtime values, and ordered comparison with exact key sets correctly fails closed on both addition and removal. Category and retryability parity is asserted beyond what A1's package root exposes (B2A-F-06). |
| exact stored evidence integrity | Verification order and short-circuit-before-host-access are right. Undermined by B2A-F-02, B2A-F-03, B2A-F-04, and B2A-F-05. |
| projected-column completeness | **Verified complete** for the inspection row: all 16 projections enumerated, `riskSignals` ordered equality specified, `gitVersion` excluded with a stated reason, comparison arrays excluded as interpretation. Only the repository-row dimension is unowned (B2A-F-12). |
| repository-class assessment | Correct and complete. The six-reason closed variant matches exactly the six A1 codes with subject `repository-class-changed`; the `validateAssessment` extension follows the accepted `unavailable`/`evidence-invalid` pattern; the reaffirmation-switch placement at `repository.ts:614` is right; and `identity-mismatch / repository-class-changed` is already legal under `REPOSITORY_STATUS_REASON_SETS`. No status, reason, contract, or migration vocabulary changes. |
| operational failure mapping | Correct. All 35 codes mapped exactly once, `observation-raced` resolved by exact code over subject, class errors mapped before generic operational handling. |
| absence of lifecycle authority | Thorough. §18's negative list is comprehensive; `buildServer` takes no repository dependency; `createServices` does not call `provider.get()`; and §17's `git diff --exit-code` guards cover `protected/`, `packages/{git,contracts,storage}`, routes, `server.ts`, the route inventory, and `apps/web`. |

## Coverage gaps

Missing proof obligations, in rough order of value:

1. Round trip `inspect()` → `verifyStored()` (B2A-F-03).
2. Digest and serialization single-source assertion (B2A-F-02).
3. Environmental root invalidity → permanently-unavailable, never disabled (B2A-F-14).
4. Inspect-time vocabulary drift: resulting provider state and caller result (B2A-F-06).
5. `compare()` internal reparse failure (B2A-F-13).
6. Repository-row vs inspection-row projection disagreement (B2A-F-12).
7. Policy-version-bump behavior pinned by test (B2A-F-05).
8. B1 inventory preservation — the plan asserts it; nothing tests it (B2A-F-08).
9. `packages/testing` seam edge preserved by a positive fixture (B2A-F-01).

## Fan-out assessment

**No further fan-out required.** 26 files, 2,130–3,150 lines, two production layers, zero
migrations, zero persistence boundaries, zero HTTP or browser surface — well below the protocol §4
trigger of roughly 60 files, more than one new authority boundary, or a major schema plus
substantial browser surface. Port, policy, adapter, and provider are four modules of one evidence
boundary, not four authorities; the separation is justified by testability and by confining the A1
import to exactly one file.

Two observations. The remediations above add roughly 150–350 lines; the total stays inside the
3,150 ceiling and **the ceiling should not be raised** to absorb them. And D-1's recommended
resolution touches `packages/git/src/index.ts`, contradicting the plan's "no A1 source change" and
the source-map row — a one-line additive export, not a fan-out, but an operator-visible amendment.

## Operator decision points

**D-1 — Observation fixture provenance (B2A-F-04).**
(a) Re-export `calculateCoreIdentityFingerprint` (and optionally `createParsedObservation`) from
`packages/git/src/index.ts`, amending §2.1 and the source-map row — **recommended**: additive,
changes no A1 behavior, keeps one fingerprint authority.
(b) Re-implement the length-prefixed algorithm in server test code — a duplicated cryptographic
authority that rots silently.
(c) Derive fixtures from a real inspector against a temporary repository — adds host-Git
dependence to the adapter unit suite.

**D-2 — Stored evidence recorded under a superseded inspection policy (B2A-F-05).**
(a) Remove §9 step 6; let `compareRepositoryObservations` own policy comparability —
**recommended**.
(b) Retain step 6 and accept that a policy bump terminally blocks every registered repository,
with the migration story assigned to a named later slice.

**D-3 — Gate repair sequencing (B2A-F-08, plan §2.5).** See the dedicated section below.
**Recommended:** split, with the plan-independent half committed as a separate chore before the
plan-remediation turn.

**D-4 — Repository-row projection agreement (B2A-F-12).**
(a) A2b2a owns it, via a separate chained port method as sketched in B2A-F-12 — **recommended**.
(b) Defer to B2b with a recorded residual obligation and an explicit justification for comparing
outside the sole adapter.
*The operator indicated agreement with (a) at review handoff; the binding disposition remains the
operator's artifact.*

## Gate repair strategy (D-3)

`pnpm check:protected` is red at this checkout because of the already-merged planning-package
commit, before any A2b2a code exists. The repair splits cleanly along whether it needs the accepted
plan. Only the plan-independent half may precede the plan-remediation turn.

### Part 1 — plan-independent, restores green now

Freeze B1's inventory as a fixed historical assertion by diffing the **pair**
`e3b69c6..b8a5493` rather than `e3b69c6..worktree`. That comparison is a permanent fact about
committed history: it will always pass, and it will always prove B1's tree was exactly its
allowlist. `CT04A2B1_ALLOWED_CHANGED_PATHS` then never has to grow again.

Add a separate live A2b2a inventory over `b8a5493..worktree` with its own allowlist. Admit the
twelve committed A2b2-named planning files by exact filename; B1's two tail artifacts are already
matched by its existing regexes. Admit the A2b2a **process-artifact classes** by slice-anchored
regex — design review, disposition, accepted plan, implementation and remediation reports, code
reviews — following the pattern already accepted in the checker. Verified at this checkout:

```text
git diff --name-only e3b69c6 b8a5493   ->  55 paths   (frozen, always passes)
git diff --name-only b8a5493 HEAD      ->  14 paths   (all process artifacts)
git merge-base --is-ancestor b8a5493 HEAD  ->  true
git diff --name-only b8a5493 dd9c969   ->  2 paths    (the B1 remediation-2 artifacts)
```

Part 1 depends only on already-committed facts and carries no A2b2a production knowledge, so it
does not front-run the accepted plan.

### Part 2 — plan-dependent, inside the implementation commit

The A2b2a implementation-file allowlist and the 38 protected-ID anchor requirements. These *are*
the accepted plan's file tree and cannot be written before it exists.

### Sequence

1. Commit this review record. The gate is already red; one more red path costs nothing, and it
   makes Part 1's allowlist a complete enumeration rather than a prediction.
2. Operator disposition of all findings including D-1 through D-4 — protocol §5,
   `FindingsAdjudicated`. No code.
3. Part 1 as its own small chore commit. Restores green before the remediation turn.
4. Disposition artifact and accepted plan committed — stays green, because step 3 admitted them by
   pattern.
5. Part 2 inside the implementation commit, where the file tree is finally binding.

Doing Part 1 before step 1 inverts this: green would be restored, then immediately re-reddened by
the review file, then again by the disposition and accepted plan — three touches of the checker
instead of one.

### Constraints

- **Role separation.** Protocol §2 makes the independent design reviewer read-only. Part 1 is the
  implementer's or an operator chore, not this session's.
- **The accepted plan must be written against the post-repair baseline.** The proposal's §2.5
  describes the gate gap as future work; once Part 1 lands that narrative is stale, and the
  accepted plan must describe only the remaining Part 2 obligation. Otherwise it claims credit for
  committed work and the completion report's gate evidence (protocol §8, §12) is muddled.
- **Carry one obligation into the exact-head code review:** verify that B1's inventory was genuinely
  frozen rather than widened — that no A2b2a path was appended to
  `CT04A2B1_ALLOWED_CHANGED_PATHS`. This closes B2A-F-08 without an extra review round for the
  chore commit.

## Required plan changes

1. Restate the manifest gate rule to preserve the accepted `packages/testing` edge; add positive
   and negative fixtures (B2A-F-01).
2. Mandate reuse of `serializeRepositoryObservation` and `verifyExactUtf8Sha256`; forbid a
   server-local digest (B2A-F-02).
3. Add the `inspect()` → `verifyStored()` round-trip obligation and test (B2A-F-03).
4. Resolve fixture provenance per D-1; update §2.1 and the source map if (a) is chosen (B2A-F-04).
5. Resolve the current-policy check per D-2 (B2A-F-05).
6. State that category and retryability parity is runtime-only; define the `available` demotion or
   per-call return for inspect-time drift, with a test (B2A-F-06).
7. Add a residual-obligation register for every partially anchored protected ID (B2A-F-07).
8. Specify the cumulative checker per "Gate repair strategy": frozen B1 pair, separate A2b2a
   inventory, exact filenames for production paths, slice-anchored regexes for process artifacts
   (B2A-F-08).
9. Require a normalized-absolute `dataDir` when the feature is enabled; add a config test
   (B2A-F-09).
10. State the Git-resolution rule once, unambiguously; enumerate `B2-CFG-004`'s failure cases
    (B2A-F-10).
11. Enumerate the closed internal stored-integrity reason union and its durable tuple for B2b
    (B2A-F-11).
12. Resolve repository-row projection agreement per D-4 (B2A-F-12).
13. Specify `compare()`'s internal reparse-failure result (B2A-F-13).
14. Enumerate `B2-CFG-005`'s exact startup failure set; add the environmental-invalidity →
    permanently-unavailable test (B2A-F-14).
15. State the provider and port composition injection seam, or explicitly defer it to B2b
    (B2A-F-15).

## Process notes

- `B2-PROC-001` is satisfied by this review. The plan's §14.3 correctly declines to claim it as
  proved, and §1's refusal to create a disposition or accepted plan is right.
- §1's checkout reconciliation is accurate: `dd9c969` is an ancestor of the review checkout, and
  the descendant commits contain only the planning package and this proposal. All five declared
  immutable digests reproduce.
- The plan's §2 reconciliation is unusually good. Where prior slices asserted seam behavior, this
  one cites file and line and is correct on nearly every point I checked — including the two
  places where the accepted source is counter-intuitive (`aborted` classified as
  host-environment, `observation-raced` classified as repository-unavailable but mapped by exact
  code). §19's invariant-completeness pass is honest rather than decorative.
- Six of the fifteen findings (B2A-F-01, B2A-F-02, B2A-F-04, B2A-F-06, B2A-F-11, B2A-F-12) share
  one shape: the plan asserts a capability or guarantee that the *accepted source* silently does
  not provide, usually because a value is exported as a type but not as a runtime value, or is
  exported from a module but not from the package root. This is the same pattern the B1 design
  review named for A2a and CT-03, and it recurs here at the A1 package boundary. B2b's authorization
  and transaction work should be planned expecting it a third time.
- Two of my earlier statements to the operator are corrected in this record: the repository row
  shares **nine** projections with the inspection row, not ten (B2A-F-12); and the process-artifact
  half of the A2b2a inventory should use slice-anchored regexes rather than exact filenames, which
  is narrower than the directory glob B2A-F-08 rejects and matches the accepted B1 pattern.
