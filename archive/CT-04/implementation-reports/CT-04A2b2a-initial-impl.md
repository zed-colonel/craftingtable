# CT-04A2b2a Initial Implementation Report

**Work item:** CT-04A2b2a — Repository feature and evidence boundary

**Parent:** CT-04A2b2 — Repository services and policy

**Accepted plan:** `work-items/CT-04/CT-04A2b2a-accepted-implementation-plan.md`

**Accepted-plan SHA-256:**

`686405a5bd1d6d20eef3cf9e1b5e8994691dbba4822f55079cd20106be622eb6`

**Pinned source archive head:** `dd9c9699f0d86cae00fc1bf0d054224880c8dbed`

**Proposed-plan commit:** `4762c9f`

**Independent design-review commit:** `ce15a994a67a39176dd9f02290ea8dea10bfa12c`

**Independent design-review SHA-256:**

`aacedcb46718ec719f32ae7f5d94c03449e681325b94720dc91132d73cd900bf`

**Plan-independent gate-repair head:** `886ddded3305d028b45f078cdff1a818d25bd41f`

**Planning/review commit and implementation base:**

`ddea2f161eccc5837560fa972a411eb99cc17389`

**Implementation head for independent review:**

`97af775368bcfd3633fea4081651089096eab53a`

**Branch:** `ct-04a2b2a-repository-evidence-boundary`

**Status:** initial implementation complete; deterministic, focused, scope,
protected, build, and browser gates pass; awaiting independent review

**Date:** 2026-08-11

## 1. Lineage and summary

The implementation head has the accepted planning/review commit as its first
parent. That planning commit has the D-03(a) plan-independent gate-repair commit
as its first parent, and the complete chain descends from the pinned source
archive head.

```text
dd9c9699f0d86cae00fc1bf0d054224880c8dbed  pinned source archive
  ...
886ddded3305d028b45f078cdff1a818d25bd41f  freeze B1 scope before A2b2a
ddea2f161eccc5837560fa972a411eb99cc17389  accepted plan/disposition/source map
97af775368bcfd3633fea4081651089096eab53a  implementation under review
```

The implementation commit is:

```text
97af775368bcfd3633fea4081651089096eab53a
ct-04a2b2a: implement repository evidence boundary
```

It contains exactly the accepted 27 changed/new files, with 2,786 insertions
and 27 deletions. The resulting 2,813 changed-line touches are within the
accepted 3,150-line ceiling, so no additional fan-out or replanning was
required.

A2b2a composes the existing A1 read-only inspector into the daemon through one
internal, lazy, authority-confining boundary:

```text
absent-or-complete immutable configuration
  -> concurrency-deduplicated provider
      -> server-owned observation port
          -> sole A1 adapter
              -> storage-owned serialization/digest verification
              -> A1-owned parse/comparison policy
```

It does not expose this boundary through HTTP and performs no repository
lifecycle write.

## 2. Delivered file boundary

### Production and domain

```text
apps/server/package.json
apps/server/src/config.ts
apps/server/src/composition.ts
apps/server/src/services/repository-inspector-provider.ts
apps/server/src/services/repository-observation-adapter.ts
apps/server/src/services/repository-observation-policy.ts
apps/server/src/services/repository-observation-port.ts
packages/domain/src/repository.ts
packages/git/src/index.ts
pnpm-lock.yaml
```

### Permanent tests and gates

```text
apps/server/src/config.test.ts
apps/server/src/composition.test.ts
apps/server/src/services/repository-inspector-provider.test.ts
apps/server/src/services/repository-observation-adapter.test.ts
apps/server/src/services/repository-observation-policy.test.ts
packages/domain/src/repository.test.ts
scripts/check-forbidden-scope.mjs
scripts/check-forbidden-scope.test.mjs
scripts/check-ct04-protected-package.mjs
scripts/check-ct04-protected-package.test.mjs
```

### Documentation and decision record

```text
README.md
CLAUDE.md
docs/architecture.md
docs/security.md
docs/operations.md
docs/decisions/README.md
docs/decisions/ADR-019-optional-repository-feature-and-evidence-translation.md
```

No accepted file was dropped and no additional implementation file was added.

## 3. Optional configuration and startup semantics

The feature has no Boolean toggle. These are the exact twelve variables:

```text
CRAFTINGTABLE_REPOSITORY_ROOTS
CRAFTINGTABLE_ARTIFACT_ROOT
CRAFTINGTABLE_MANAGED_WORKTREE_ROOT
CRAFTINGTABLE_GIT_BIN
CRAFTINGTABLE_GIT_SEARCH_PATH
CRAFTINGTABLE_GIT_TIMEOUT_MS
CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS
CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS
CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES
CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES
CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS
CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS
```

- If all twelve are absent, configuration returns `{ enabled: false }` and
  existing planning/authentication startup performs no A1, executable, or
  filesystem work.
- Presence of any variable requests the feature. Empty values are present but
  malformed; partial or incoherent groups fail synchronously.
- Source roots and at least one explicit Git-resolution mechanism are required.
  Bin-only, search-only, and both are valid. A1 gives an explicit bin precedence
  when both are present, so ambient `PATH` is never selected.
- Enabled `dataDir`, source roots, child roots, Git bin, and search-path entries
  must satisfy the accepted lexical absolute/normalized/resolved/NUL-free/UTF-8
  bounds. Source roots are unique, non-overlapping, limited to 32, and disjoint
  from `dataDir`.
- Artifact and managed-worktree roots default below `dataDir`, must be strict
  disjoint descendants, and are not created by this slice.
- Existence, realpath, symlink-component, directory-kind, ownership,
  platform/UID, executable evidence, and Git-version checks remain lazy A1
  authority on first use.

Numeric behavior is exact:

| Setting | Default | Accepted range/coherence |
|---|---:|---|
| command timeout | 5000 ms | integer 100–30000 |
| creation timeout | `2 * command + 5000` | integer 1000–90000; at least one command timeout |
| inspection timeout | `2 * command + 5000` | integer 1000–90000; at least two command timeouts |
| stdout limit | 65536 bytes | integer 16384–1048576 |
| stderr limit | 65536 bytes | integer 1024–1048576 |
| termination grace | 250 ms | integer 50–2000 |
| provider retry delay | 5000 ms | integer 100–60000 |

Composition always creates one provider but never calls `get()` during service
creation. `buildServer` receives no repository dependency.

## 4. Provider state machine

`RepositoryInspectorProvider` owns six closed states:

| State | Concurrent behavior | Cache/retry behavior | Restart behavior |
|---|---|---|---|
| `disabled` | every caller receives the same bounded disabled result | factory is never called | remains disabled if variables remain absent |
| `idle` | the first caller installs a promise before any await | creation chooses success, cooldown, or permanent state | a new enabled instance starts idle |
| `creating` | concurrent callers await the same promise and result | one shared A1 construction | restart discards in-memory work |
| `available` | callers receive the same guarded port/result | success memoized for process lifetime | a new process revalidates lazily |
| `cooldown` | callers before the monotonic deadline receive the same failure | the first caller at/after the exact deadline creates once | a new process starts idle |
| `permanently-unavailable` | callers receive the same bounded permanent failure | no retry before restart | corrected package/host/config is re-evaluated lazily |

Only retryable creation failures enter cooldown. Configuration-required,
not-retryable, vocabulary, factory-throw, and invariant failures latch
permanently. There is no timer, background retry, exponential backoff, stale
success eviction, or ambient disabled fallback.

An adapter invariant callback can demote `available` to
`permanently-unavailable`. The guarded port also latches, so future calls do
not reach A1 even if a caller retained the old port reference.

## 5. Authority-confining port and sole A1 adapter

The only production server source importing `@craftingtable/git` is:

```text
apps/server/src/services/repository-observation-adapter.ts
```

The server-owned port exposes only:

```text
inspect
verifyStored
verifyRegisteredIdentity
compare
```

Its branded type chain requires:

```text
SuccessfulRepositoryInspection
  -> VerifiedStoredRepositoryObservation
      -> VerifiedRepositoryBaseline
          -> comparison
```

No exported port/result type contains an A1 inspector, subprocess runner,
factory/options type, executable/search path, roots, command/argv/environment,
stdout/stderr, spawn handle, or arbitrary process authority. B2b may receive
the provider only after its future authorization checks.

`packages/git/src/index.ts` adds only the approved package-root re-export of
`calculateCoreIdentityFingerprint`. It does not export
`createParsedObservation` or widen A1 process authority.

## 6. Exact evidence production and verification

Inspection success calls storage's `serializeRepositoryObservation` and derives
all projections from the same parsed A1 observation. The adapter contains no
hash primitive, alternate serializer, or server-local digest implementation.

Stored inspection verification stops at the first failure:

1. `verifyExactUtf8Sha256` recomputes and compares the exact observation bytes;
2. `JSON.parse` establishes JSON syntax;
3. A1 `parseRecordedObservation` validates the complete observation and
   fingerprint;
4. all 16 stored inspection projections are compared against that parsed value.

The 16 projections are observation version, policy version, observation time,
three canonical paths, object format, two inodes, core fingerprint, two device
values, risk scope version, risk pattern, risk classification, and ordered risk
signals.

Registered identity verification then checks the nine shared repository
columns: observation version, policy version, three canonical paths, object
format, two inodes, and core fingerprint. Only that result can become a
`VerifiedRepositoryBaseline`.

Comparison defensively rechecks both digests, reparses both JSON values, and
rechecks their projections. It then calls A1
`compareRepositoryObservations`. The adapter does not reject an otherwise
valid historical policy during stored verification; A1 comparison alone owns
policy comparability. Defensive reparse/projection impossibility is a systemic
adapter fault, produces no assessment, and triggers the permanent latch.

## 7. Vocabulary, error policy, and domain correction

Construction checks exact A1/domain parity for observation/policy/risk
versions, risk pattern, ordered risk signals, ordered 35-code vocabulary,
code-to-subject mapping, and ordered core/environment/risk difference sets.
Closed compile-time tables cover subject, category, operation, and retryability
sets.

Every actual A1 failure is assessed only after its code, subject, category,
operation membership, and retryability agree with server policy. The exhaustive
35-code mapping is:

| Assessment | Exact A1 codes |
|---|---|
| no state change | `invalid-options`, `unsupported-platform`, `root-daemon-refused`, `invalid-root-policy`, `git-not-found`, `git-not-executable`, `git-executable-changed`, `unsupported-git-version`, `invalid-path`, `outside-allowed-root`, `reserved-root-overlap`, `spawn-failed`, `aborted`, `timed-out`, `stdout-overflow`, `stderr-overflow`, `signal-terminated`, `git-command-failed`, `invalid-output-encoding`, `malformed-version-output`, `malformed-identity-output`, `malformed-feature-output`, `feature-count-exceeded`, `observation-raced` |
| unavailable | `path-unavailable` → `path-unavailable`; `repository-metadata-unreadable` → `metadata-unreadable` |
| repository class changed | `symlink-rejected`, `ownership-refused`, `not-primary-repository`, `not-git-repository`, `unsupported-object-format`, `unsupported-repository-extension` |
| evidence invalid | `recorded-observation-invalid` → `stored-evidence-invalid`; `unsupported-observation-version`; `inspection-policy-version-mismatch` |

Unknown or contradictory runtime tuples become `adapter-invariant-fault`; the
adapter does not guess an assessment.

Domain now owns `CURRENT_REPOSITORY_INSPECTION_POLICY_VERSION = 1` and the
closed `repository-class-changed` assessment with the six exact reasons above.
Ordinary assessment and environmental reaffirmation map those reasons from
inspectable states to:

```text
identity-mismatch / repository-class-changed
```

Existing terminal-state and retirement behavior is unchanged. Operational
failures remain `no-state-change-failure` and cannot mutate identity in A2b2a.

## 8. Design-review reconciliation

All four operator decisions and all fifteen design-review findings are reflected
in the implementation:

| Decision | Implemented disposition |
|---|---|
| D-01(a) | package-root re-export of `calculateCoreIdentityFingerprint` only; source-map amendment committed |
| D-02(a) | A1 comparison alone owns policy comparability |
| D-03(a) | separate B1-freeze commit followed by exact 27-file live A2b2a inventory and protected anchors |
| D-04(a) | separate type-chained nine-column registered-identity verification before compare |

The design-review disposition SHA-256 is:

```text
710995b1c269ad933d0ef814d399a540b143af75ac91a0284350a52e48087c66
```

The amended A2b2 source map SHA-256 is:

```text
73a1a8f0e217fa1335ce7b62f13c35954e23fb13886e554087a143e0333fb8c1
```

## 9. Permanent proof and protected-ID mapping

The protected checker parses all 38 A2b2a protected IDs from the unchanged
supplement, requires permanent behavioral title anchors except the documentary
process case, and records seven exact B2b residual obligations.

| Protected IDs | Primary permanent proof | Closure |
|---|---|---|
| `B2-CFG-001`, `A2B-CFG-001` | `config.test.ts`, `composition.test.ts`, disabled provider test | closed here |
| `B2-CFG-002`, `A2B-CFG-002` | disabled provider bounded result and zero factory calls | B2b residual |
| `B2-CFG-003`, `A2B-CFG-003` | enabled config/composition and lazy provider success | B2b residual |
| `B2-CFG-004`, `A2B-CFG-004` | partial/empty and numeric failure matrices in `config.test.ts` | closed here |
| `B2-CFG-005` | lexical config matrix, provider permanent-cache proof, and inherited A1 root-policy tests | closed here |
| `B2-CFG-006`, `B2A-SRC-008` | concurrent first-use shared promise/result test | closed here |
| `B2-CFG-007`, `A2B-CFG-007`, `B2A-SRC-009` | cooldown, permanent cache, memoization, and new-instance restart tests | closed here |
| `B2-CFG-008`, `A2B-CFG-008` | bounded provider/port result tests and operations documentation | B2b residual |
| `A2B-CFG-005` | explicit bin/search configuration matrix and no ambient fallback | closed here |
| `A2B-CFG-006` | disabled composition retains planning/auth/storage services | B2b residual |
| `B2-ADP-001` | real package-root parser/fingerprint and positive parity test | closed here |
| `B2-ADP-002`, `B2A-SRC-002`, `B2A-EVID-006` | vocabulary drift, runtime tuple drift, compare-cast fault, and latch tests | closed here |
| `B2-ADP-003`, `B2A-SRC-003`, `B2A-EVID-001` | serializer-backed producer/verifier/baseline round trip | closed here |
| `B2-ADP-004`, `B2A-SRC-003`, `B2A-EVID-002` | byte mutation rejected at digest gate | closed here |
| `B2-ADP-005`, `B2A-SRC-004`, `B2A-EVID-003`, `B2A-EVID-004` | invalid JSON, invalid record, unsupported version, and historical-policy tests | closed here |
| `B2-ADP-006`, `B2A-SRC-005`, `B2A-EVID-005` | table mutation of all 16 inspection and nine repository projections | closed here |
| `B2-ADP-007`, `B2A-SRC-001`, `B2A-SRC-006`, `B2A-ASMT-001` | six class reasons across ordinary/reaffirmation reducer flows | closed here |
| `B2-ADP-008`, `B2A-SRC-007`, `B2A-ASMT-005` | exhaustive error policy and operational no-state-change assertions | closed here |
| `B2-ADP-009`, `B2A-ASMT-002` | core-priority comparison retaining all difference arrays | closed here |
| `B2-ADP-010`, `B2A-ASMT-003` | environment-priority comparison retaining risk differences | closed here |
| `B2A-ASMT-004` | risk-only assessment test | closed here |
| `B2A-ASMT-006` | exact unavailable reasons and raced no-state-change policy | closed here |
| `B2-PROC-001` | proposal, independent design review, full disposition, accepted plan, and operator approval lineage | closed here |
| `B2-SCOPE-001` | exact manifest/import and process-authority gates | closed here |
| `B2A-SRC-010` | exact changed-path inventory and prohibited-surface checks | closed here |

The seven residual-bearing IDs remain deliberately open for B2b:

| ID | Exact residual |
|---|---|
| `B2-CFG-002` | authorized HTTP operation maps disabled state to an actionable unavailable response; unauthorized requests return first |
| `A2B-CFG-002` | same authorization-before-unavailable HTTP behavior |
| `B2-CFG-003` | authorization, membership, and role checks complete before provider `get()` |
| `A2B-CFG-003` | same authorization-before-host-access behavior |
| `B2-CFG-008` | common and administrative HTTP responses preserve non-disclosure |
| `A2B-CFG-008` | HTTP and audit metadata preserve non-disclosure |
| `A2B-CFG-006` | repository read and administrative HTTP operations remain available under their future authorization policy |

A2b2a does not claim those HTTP/authorization obligations as complete.

## 10. Validation attached to the implementation head

Focused implementation validation completed successfully:

```text
domain/server implementation focus: 6 files / 38 tests passed
gate and route-inventory focus:       3 files / 58 tests passed
post-audit adapter/provider/policy:   3 files / 20 tests passed
typecheck:                            passed
lint:                                 passed with no diagnostics
format check:                         passed
```

The final elevated-loopback aggregate command was:

```bash
pnpm check
```

Final result:

```text
format:check passed
lint passed
typecheck passed
build passed
72 Vitest files passed
644 Vitest tests passed
4 Playwright tests passed
check:scope passed
check:protected passed
```

The first sandboxed full `pnpm test` run reached the real-port SSE suites and
failed ten tests solely because the sandbox denied `listen(127.0.0.1)` with
`EPERM`. The approved loopback-capable rerun passed all 644 tests. Playwright
and the final aggregate command were likewise run with loopback permission and
passed.

The first lockfile-only install attempt encountered restricted registry network
resolution. The approved retry completed, and an offline install established
the local workspace link. The resulting lockfile adds only the server's
`workspace:*` edge to `@craftingtable/git`; no external dependency was added.

Final structural commands also passed:

```text
git diff --check
exact protected/source/storage/route/browser diff: empty
sole production server @craftingtable/git import: exact adapter only
node:child_process production authority: unchanged A1 command runner only
staged implementation inventory: exactly 27 files
```

## 11. Scope and immutable-source proof

The final diff leaves these surfaces unchanged from the D-03 freeze point:

```text
protected/**
packages/git/src/command-runner.ts
packages/git/src/comparison.ts
packages/contracts/**
packages/storage/**
apps/server/src/routes/**
apps/server/src/server.ts
apps/server/src/route-inventory.test.ts
apps/web/**
work-items/CT-04/CT-04A2b2-protected-acceptance-supplement.yaml
```

Relevant accepted hashes remain:

```text
protected CT-04 specification  ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
A2 protected supplement       1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
A2b protected supplement      255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad
migration 0003              526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
migration 0004              409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e
A2b2 protected supplement     d5ec533cf3187511e6709c989b6c525a9297dd7cfd8795b04871a814006a8879
```

The implementation adds no:

```text
repository route or HTTP error mapping
authorization or role decision
audit append or vocabulary
workspace-event append or vocabulary
notifier producer or SSE behavior
repository, inspection, or binding storage mutation
lifecycle transaction or registration/inspection/reaffirmation command
retirement, bind, or unbind behavior
repository query/disclosure service
browser source or invalidation behavior
directory creation or Git mutation
worktree, branch, ref, diff, or artifact behavior
change-request, agent, verification, review, readiness, or merge behavior
ActionQueue, WorldInterface, or Exoskeleton dependency
CT-04B-or-later behavior
```

## 12. Independent-review notes and report boundary

The A2b2a adapter/provider tests use controlled A1 creation results and fake
clocks. Real missing/symlink/colon root behavior remains exercised in A1's
permanent root-policy suites; A2b2a proves the lexical/lazy split and the
provider classification without introducing a second filesystem authority.
This division is a useful review focus because the accepted plan called for
both inherited A1 behavior and composed provider semantics.

This report is intentionally introduced after the immutable implementation
commit. Its later documentary commit does not amend or replace the implementation
head under review. Independent review should use
`97af775368bcfd3633fea4081651089096eab53a` as the source head and this report as
supplemental evidence.
