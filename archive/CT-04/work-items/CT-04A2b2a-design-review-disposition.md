# CT-04A2b2a design-review disposition

**Status:** Operator decisions recorded; accepted-plan reconciliation authorized

**Adoption date:** 2026-08-11

**Slice:** CT-04A2b2a — Repository feature and evidence boundary

**Reviewed proposal:** `work-items/CT-04/CT-04A2b2a-proposed-implementation-plan.md`

**Proposal SHA-256:** `3ef9120e09a525a0f7d132979a713dda5ea215bcee054020bb6a0b5efa2f7ba1`

**Independent review:** `review-findings/CT-04/CT-04A2b2a-design-review.md`

**Review SHA-256:** `aacedcb46718ec719f32ae7f5d94c03449e681325b94720dc91132d73cd900bf`

**Review commit:** `ce15a994a67a39176dd9f02290ea8dea10bfa12c`

**Pinned source archive head:** `dd9c9699f0d86cae00fc1bf0d054224880c8dbed`

## 1. Purpose and authorization boundary

This disposition records the operator's adjudication of all 15 findings and all four
decision points in the independent CT-04A2b2a design review. `AGENTS.md`, the active
work contract, and the protected acceptance package remain controlling.

The review verdict is accepted:

```text
REVISE — incorporate every finding before implementation
```

This disposition authorizes the accepted-plan document and the plan-independent gate
repair selected by D-03(a). It does not authorize A2b2a production implementation.
Implementation remains stopped until the operator separately approves the reconciled
accepted plan.

## 2. Binding operator decisions

| Decision | Operator selection | Binding result |
|---|---|---|
| D-01 | Option (a) | Re-export only `calculateCoreIdentityFingerprint` from `packages/git/src/index.ts`; do not export `createParsedObservation`. Amend accepted-plan §2.1 and the A2b2 source-map row. |
| D-02 | Option (a) | Remove the verifier's current-policy rejection. `compareRepositoryObservations` alone owns recorded/current policy comparability. |
| D-03 | Option (a) | Use the review's two-part gate repair: freeze B1 and admit planning/process artifacts first; add A2b2a implementation paths and protected anchors only during implementation. |
| D-04 | Option (a) | A2b2a verifies the nine repository-row identity/version projections through a separate type-chained port method before comparison. |

All 15 findings are accepted. None is rejected, downgraded, or deferred to
implementation discretion. The only residual obligations are the explicitly named B2b
authorization/HTTP portions of protected cases that A2b2a cannot implement.

## 3. Finding dispositions

### B2A-F-01 — manifest rule contradicted accepted source

**Disposition:** Accepted as required.

The scope gate will require exactly one composed application production edge in
`apps/server/package.json`, preserve and positively assert the accepted seam edge in
`packages/testing/package.json`, and reject new edges in web, storage, domain,
contracts, planning, agents, or other application manifests. Removing the testing edge
is itself a failure.

### B2A-F-02 — duplicate digest and serialization authority

**Disposition:** Accepted as required.

The adapter will import `serializeRepositoryObservation` and
`verifyExactUtf8Sha256` from `@craftingtable/storage`. It will not import a hashing
primitive or implement JSON serialization/digest construction locally. Inspection
success uses the storage serializer; stored verification uses the storage verifier.

### B2A-F-03 — missing producer/verifier round trip

**Disposition:** Accepted as required.

A permanent adapter test must prove:

```text
inspect success
  -> construct every SuccessfulRepositoryInspection projection
  -> verifyStored
  -> verifyRegisteredIdentity
  -> accepted verified baseline with all projections equal
```

Mutating one serialized byte while retaining the digest must fail at the digest gate
before parse, comparison, or host access.

### B2A-F-04 / D-01 — no permitted valid fixture path

**Disposition:** Accepted with operator-selected option (a).

`packages/git/src/index.ts` will add the one additive package-root re-export of
`calculateCoreIdentityFingerprint`. Tests build observation shapes, calculate the real
fingerprint through that package-root function, and require acceptance by the real
package-root `parseRecordedObservation`. Deep imports and a duplicate fingerprint
implementation remain forbidden. A1 behavior and process authority do not change.

### B2A-F-05 / D-02 — unauthorized current-policy rejection

**Disposition:** Accepted with operator-selected option (a).

`verifyStored()` checks exact digest, JSON, A1 parse, and all 16 stored inspection-row
projections. It does not require the recorded policy version to equal today's policy.
The stored `inspectionPolicyVersion` must equal the parsed record's version. Only
`compareRepositoryObservations(recorded, current)` decides whether two policies are
comparable and may return `inspection-policy-version-mismatch`.

### B2A-F-06 — parity overclaim and no available-state demotion

**Disposition:** Accepted; choose fail-closed demotion.

Construction-time parity covers only package-root runtime values A1 actually exports:
versions, risk scope/pattern/signals, ordered error codes, error subjects, and ordered
difference vocabularies. Category and retryability value sets are compile-time
exhaustive, but code/category/retryability agreement is checked on every actual A1
error.

An actual error whose tuple contradicts policy returns `adapter-invariant-fault`, makes
no assessment, and atomically latches both the guarded port and provider from
`available` to `permanently-unavailable`. Already-started calls finish with their own
bounded result; no later call can produce an assessment or invoke A1. All callers after
the latch receive the same bounded permanent failure. Restart recreates `idle` and
rechecks parity lazily.

### B2A-F-07 — protected IDs anchored to partial proofs

**Disposition:** Accepted as required.

The accepted plan contains a 38-ID closure/residual register. The checker distinguishes
an A2b2a behavior anchor from full closure. It records the exact B2b residual for cases
whose protected expectation contains authorization, request, response, administrative
read, or HTTP non-disclosure behavior. A residual-bearing case cannot be reported as
fully satisfied by an A2b2a test title.

### B2A-F-08 / D-03 — cumulative gate could dissolve B1 containment

**Disposition:** Accepted with operator-selected option (a).

Part 1 was completed as the separate plan-independent commit
`886ddded3305d028b45f078cdff1a818d25bd41f`:

- B1 is permanently checked over the frozen pair `e3b69c6..b8a5493`;
- `CT04A2B1_ALLOWED_CHANGED_PATHS` contains no A2b2a path;
- the live range `b8a5493..worktree` admits the 12 exact A2b2 planning files,
  the two gate files, existing B1 tail process artifacts, and only slice-anchored
  A2b2a process-artifact classes;
- focused tests and `pnpm check:protected` pass.

Part 2 remains implementation work: add exact accepted implementation filenames and
the 38-ID anchor/residual requirements. Exact-head review must confirm the B1 allowlist
was frozen, not widened.

### B2A-F-09 — enabled feature accepted non-normalized dataDir

**Disposition:** Accepted as required.

Only when the repository feature is explicitly enabled, `dataDir` must satisfy the same
nonempty, absolute, lexically normalized, resolved, NUL-free, 4096-byte predicate needed
for A1's reserved root. Feature-disabled CT-01 through CT-03 startup behavior is
unchanged. Trailing separators and `.`/`..` components fail synchronously when enabled.

### B2A-F-10 — ambiguous Git resolution rule

**Disposition:** Accepted as required.

An enabled group must supply at least one of `CRAFTINGTABLE_GIT_BIN` or
`CRAFTINGTABLE_GIT_SEARCH_PATH`. Bin only, search path only, and both are valid; when
both are present, the explicit bin wins. Neither is a startup error. Empty values are
present but malformed. Ambient `PATH` is never selected.

### B2A-F-11 — unenumerated integrity reasons and durable disposition

**Disposition:** Accepted with a closed reason/result table.

The accepted plan enumerates every internal reason and its assessment plus durable B2b
disposition. Server-detected JSON/projection/repository-row integrity failures reuse the
only accepted storage-integrity tuple; the bounded internal reason remains diagnostic
evidence. Genuine A1 parse/compare failures retain their exact A1 tuple. Vocabulary and
adapter invariant faults are systemic provider failures: no assessment is guessed and
no inspection row is fabricated. No durable/domain vocabulary is widened.

### B2A-F-12 / D-04 — repository/inspection projection agreement unowned

**Disposition:** Accepted with operator-selected option (a).

The port chain is:

```text
verifyStored(inspection) -> VerifiedStoredRepositoryObservation
verifyRegisteredIdentity(repository, verified) -> VerifiedRepositoryBaseline
compare(baseline, current) -> comparison result
```

The second method checks exactly the nine shared fields: observation and policy version,
three canonical paths, object format, two inodes, and core fingerprint. Any mismatch is
`evidence-invalid / stored-evidence-invalid` and uses the accepted storage-integrity
durable tuple. It does not duplicate referential-integrity checks already enforced by
migration 0003.

### B2A-F-13 — compare reparse failure unspecified

**Disposition:** Accepted as an adapter invariant fault.

If defensive reparse of an adapter-created verified value fails, `compare()` returns
`adapter-invariant-fault`, emits no assessment, writes no durable evidence in A2b2a, and
latches the guarded port/provider permanently unavailable until restart. It never maps
to evidence corruption or repository identity state.

### B2A-F-14 — startup failure set not enumerated

**Disposition:** Accepted as required.

Startup rejects empty, relative, non-normalized, NUL-containing, over-4096-byte,
duplicate, ancestor-overlapping, dataDir-overlapping, or more-than-32 roots, plus the
malformed numeric/resolution cases. Existence, realpath, symlink components, UID/platform,
colon ceiling representation, executable evidence, and Git version remain lazy A1
authority. A missing, symlinked, or colon-containing environmental root starts with an
enabled idle provider, then becomes permanently unavailable through A1
`invalid-root-policy`; it never becomes disabled.

### B2A-F-15 — composition injection seam unspecified

**Disposition:** Accepted now.

`ServiceOverrides` gains a server-owned optional provider override. The provider factory
also accepts a server-owned observation-port factory and monotonic clock for focused
tests. Composition constructs exactly one provider unless the provider override is
supplied. No override carries A1 inspector/options/process types, and B2b can later prove
authorization-before-`get()` without adding a raw port-authority seam.

## 4. Accepted scope and stop

The review's fan-out conclusion is accepted: no further child split is required. The
additive A1 re-export increases the implementation tree from 26 to 27 files but adds no
authority or behavior. The 3,150-line ceiling remains binding.

The next artifact is
`work-items/CT-04/CT-04A2b2a-accepted-implementation-plan.md`. After it is written and
validated, stop for operator approval. Do not implement the A1 re-export, domain change,
server feature, Part 2 gate, ADR, or documentation until that approval.
