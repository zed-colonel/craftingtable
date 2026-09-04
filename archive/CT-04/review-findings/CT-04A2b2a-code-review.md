# CT-04A2b2a Independent Implementation Review

**Verdict:** `CHANGES REQUIRED`

**Reviewed head:** `97af775368bcfd3633fea4081651089096eab53a`

**Implementation report:** `implementation-reports/CT-04/CT-04A2b2a-initial-impl.md`

**Accepted plan:** `work-items/CT-04/CT-04A2b2a-accepted-implementation-plan.md`

**Date:** 2026-08-11

## 1. Lineage verification — pass

`git log --format='%H %P'` confirms the first-parent chain claimed in report §1:

```text
dd9c9699  pinned source archive
0c1918ba  pre-ct04a2b2 chore: stage design package
4762c9f5  propose repository evidence boundary plan
ce15a994  independent design review of proposed plan
886ddded  freeze B1 scope before CT-04A2b2a
ddea2f16  accept repository evidence boundary plan
97af7753  implement repository evidence boundary      <- head under review
87964221  docs: add CT-04A2b2a implementation report
```

The report commit is a descendant of, and does not amend, the reviewed head. Worktree is clean.

## 2. Hash verification — pass

Every hash asserted in the report and plan reproduces exactly:

| Artifact | SHA-256 | Result |
|---|---|---|
| accepted implementation plan | `686405a5…22eb6` | matches report §head |
| design review | `aacedcb4…d900bf` | matches report §head |
| design-review disposition | `710995b1…087c66` | matches report §8 |
| proposed plan | `3ef9120e…f2f7ba1` | matches plan §1 |
| protected CT-04 spec | `ce7a101c…f090f64` | matches report §11 |
| A2 protected supplement | `1000d564…656429c` | matches report §11 |
| A2b protected supplement | `255fe8b6…78ebad` | matches report §11 |
| A2b2 protected supplement | `d5ec533c…6a8879` | matches report §11 |
| migration 0003 | `526df194…123bc4` | matches report §11 |
| migration 0004 | `409553eb…af5f29e` | matches report §11 |

## 3. Inventory and frozen-surface verification — pass

- `git diff --name-only ddea2f16 97af7753` yields exactly 27 paths, set-identical to accepted-plan §4 and to `CT04A2B2A_IMPLEMENTATION_PATHS` (`scripts/check-ct04-protected-package.mjs:173-201`); verified programmatically with zero symmetric difference.
- `git diff --numstat` totals 2,786 insertions / 27 deletions = 2,813 changed-line touches, under the 3,150 ceiling. Report §1 is exact.
- `git diff --exit-code 886ddded 97af7753 --` over `protected/`, `packages/git/src/command-runner.ts`, `packages/git/src/comparison.ts`, `packages/contracts/`, `packages/storage/`, `packages/storage/migrations/`, `packages/domain/src/workspace-events.ts`, `apps/server/src/routes/`, `apps/server/src/server.ts`, `apps/server/src/route-inventory.test.ts`, `apps/web/`, and the A2b2 supplement is **empty**. Report §11 is truthful.
- The only `packages/git` change is `src/index.ts`, adding exactly the D-01(a) `calculateCoreIdentityFingerprint` re-export.

## 4. Deterministic gate — pass, reproduced independently

`pnpm check` at the reviewed head (exit 0):

```text
format:check passed
lint passed
typecheck passed
build passed
72 Vitest files passed / 644 Vitest tests passed
4 Playwright tests passed
check:scope passed
check:protected passed
```

This reproduces report §10 line for line.

## 5. Child-specific adversarial probes

| Probe | Result | Evidence |
|---|---|---|
| Can any unauthorized request create/call A1? | **No** | `apps/server/src/server.ts:23-30` `ServerDependencies` has no repository member and is byte-frozen; `apps/server/src/routes/**` unchanged; the provider lives only in the internal `ServiceSet` (`apps/server/src/composition.ts:35`) and `get()` is never called during service creation (`apps/server/src/composition.test.ts:70-71`). Authorization-before-`get()` is correctly held open as `B2-CFG-003`/`A2B-CFG-003`. |
| Second production module importing Git or raw process authority? | **No** | `rg '@craftingtable/git'` resolves to `apps/server/src/services/repository-observation-adapter.ts:18` plus the accepted `packages/testing` seam and test files; `node:child_process` production import remains solely `packages/git/src/command-runner.ts:1`. Structurally enforced at `scripts/check-forbidden-scope.mjs:570-578, 586-592` with negative fixtures at `scripts/check-forbidden-scope.test.mjs:161-207`. |
| Can invalid stored evidence reach A1 comparison or host inspection? | **No** | `verifyStored` gates on `verifyExactUtf8Sha256` before `JSON.parse`, A1 parse, or projections (`repository-observation-adapter.ts:343-399`); `compare` defensively re-verifies both digests, reparses both records, and re-checks all 16 projections before `compareRepositoryObservations` (`:462-486`); a structurally cast baseline yields `adapter-invariant-fault` with no assessment (`repository-observation-adapter.test.ts:390-410`). |
| Does every A1 error map without conflating class, core, unavailable, and operational failure? | **Yes** | `ASSESSMENT_BY_CODE` is a compile-time exhaustive `satisfies Record<A1RepositoryInspectionErrorCode, AssessmentPolicy>` over all 35 codes (`repository-observation-policy.ts:87-123`), matching accepted-plan §13 row for row. `core-identity-changed` is reachable only from comparison differences (`:223-225`), never from an error code; class reasons are closed-set-guarded (`:174-177`); `observation-raced` stays `no-state-change` (`:119`); tuple disagreement fails closed to `adapter-invariant-fault` (`:195-205`). |
| Does every explicit attempt create truthful inspection evidence? | **N/A here; production path is truthful** | A2b2a performs no write. Evidence derives from one storage serializer call and one parsed observation (`repository-observation-adapter.ts:138-161`); no local hash or serializer exists in the adapter. |
| Can nested primitives partially commit before outer audit/event failure? | **N/A** | No transaction, audit, or event code exists in the 27-file tree; `packages/storage/**` is frozen. |
| Can a no-event inspection be reconstructed through history queries? | **N/A** | No event append, notifier, or query surface added. |
| Can binding occur after a verification makes the repository non-active? | **N/A** | No binding, bind, or unbind behavior added. |
| Can retirement produce incomplete per-project event evidence? | **N/A** | Retirement reduction is untouched (`packages/domain/src/repository.ts:616-620`); no event production exists. |
| Do all new routes preserve CSRF/origin/session/nondisclosure? | **N/A — no new routes** | `route-inventory.test.ts` is frozen and green. Provider/port failure results carry only `kind`+`reason` (`repository-inspector-provider.ts:23-30`), proven non-disclosing at `repository-inspector-provider.test.ts:130-139`. |
| Did any CT-04B+ capability leak in? | **No** | Keyword sweep across the four new service files finds no worktree, branch, artifact, audit, notifier, event, binding, retire, route, fetch, mkdir, or writeFile surface. |

Additional verified behavior:

- Provider concurrency is correct: the `creating` promise is installed synchronously before any await (`repository-inspector-provider.ts:155-159`), cooldown uses an exact monotonic deadline with a single deduplicated retry (`:150-154`, proven at boundary values 5099/5100 in `repository-inspector-provider.test.ts:74-95`), and an invariant fault reached after `available` demotes to `permanently-unavailable` while a creation completing after the latch cannot resurrect it (`:115-118`).
- Domain correction is complete: all six class reasons × three inspectable statuses across both ordinary and reaffirmation flows, plus invalid-reason rejection (`packages/domain/src/repository.test.ts:88-119, 163-168`). `B2-ADP-007` / `B2A-SRC-001` / `B2A-SRC-006` / `B2A-ASMT-001` are genuinely closed.
- D-02(a) is honored: a historical policy-version record verifies and only `compareRepositoryObservations` rejects comparability (`repository-observation-adapter.test.ts:320-344`).
- D-04(a) is honored: the nine-column identity check is separately type-chained and every column is mutation-tested (`:290-318`).

## 6. Findings

### F-01 — The only positive A1/domain parity assertion is tautological (`B2-ADP-001`)

**Severity:** changes required

`apps/server/src/services/repository-observation-adapter.test.ts:38-50` replaces three package-root runtime collections with mutable containers, and `:172-180` re-seeds all three from the **domain** constants before every test:

```ts
a1.codes.splice(0, a1.codes.length, ...A1_REPOSITORY_INSPECTION_ERROR_CODES);   // :174
Object.assign(a1.subjects, A1_REPOSITORY_INSPECTION_ERROR_SUBJECT_BY_CODE);     // :178
a1.signals.splice(0, a1.signals.length, ...STORED_REPOSITORY_RISK_SIGNALS);     // :179
```

The single positive parity assertion — `expect(repositoryObservationVocabularyMatches()).toBe(true)` at `:185` — therefore compares domain values against themselves for three of the eight parity facts checked in `repository-observation-adapter.ts:98-117`: the ordered 35-code vocabulary (`:105`), the code-to-subject mapping (`:106-109`), and the ordered risk signals (`:104`).

No other permanent test closes the gap. `packages/git/test/comparison.test.ts:223-227` asserts only A1-internal self-consistency, and `packages/storage/src/repository-schema.test.ts:194` compares domain to the storage schema. Nothing asserts A1's real exports equal domain's.

**Failure scenario:** A1 gains a 36th error code, reorders the array, or remaps one subject. `pnpm check` stays fully green. In production `createRepositoryObservationPort` returns `adapter-vocabulary-mismatch` (`repository-observation-adapter.ts:527-532`), the provider latches `permanently-unavailable`, and the repository feature is dead on every enabled deployment with no test signal.

Accepted plan §8 is explicit: *"Positive tests use the real package root; drift cases use isolated package-root module replacement."* The implementation applies module replacement to the positive case as well. The behavior is fail-closed, so this is a proof gap rather than a security hole — but report §9 lists `B2-ADP-001` as "real package-root parser/fingerprint and positive parity test … closed here", which the test as written does not support.

**Required change:** assert real parity against unmocked A1 — e.g. capture `importOriginal()` values in the `vi.mock` factory and compare them to the domain constants in the positive test, or place the positive `repositoryObservationVocabularyMatches()` assertion in a file that does not mock `@craftingtable/git`.

### F-02 — The live residual-closure guard is provably dead code (`B2A-SRC-010`, `B2-SCOPE-001`)

**Severity:** changes required

`scripts/check-ct04-protected-package.mjs:408-412` wires the residual guard as:

```js
errors.push(
  ...a2b2aResidualClosureViolations(
    protectedIds.filter((id) => !CT04A2B2A_B2B_RESIDUALS.has(id)),
  ),
);
```

`a2b2aResidualClosureViolations` (`:366-370`) returns only those input IDs that **are** in `CT04A2B2A_B2B_RESIDUALS`. The argument is that same set with residual-bearing IDs already filtered out, so the call can never return a violation. Executed against the real supplement:

```text
protected ids: 38
arg passed by live check (non-residual only): 31
violations produced by live wiring: []
violations if residuals were passed: 7
```

Accepted plan §15 requires the checker to *"fail … if a residual-bearing case is marked fully satisfied"*, and §16(5) requires it to *"prohibit full-closure reporting for them"*. Only the pure function is exercised, by a direct unit call at `scripts/check-ct04-protected-package.test.mjs:263-267`; `pnpm check:protected` never evaluates it against any real closure claim.

**Failure scenario:** a later B2b commit (or an A2b2a remediation) reports `B2-CFG-002` or `A2B-CFG-003` as fully closed. `pnpm check:protected` still passes, and premature closure of an HTTP/authorization obligation ships unblocked — precisely the containment the operator's D-03(a) disposition asked the gate to make structural.

Report §9's wording ("records seven exact B2b residual obligations") is truthful about what the checker does; the defect is that the plan's enforcement requirement is unmet, not that the report misstates it.

**Required change:** give the guard a real input — parse the declared closure set from a committed register (or from the residual/closure annotations in the supplement) and pass *that* to `a2b2aResidualClosureViolations`, so a residual-bearing ID marked closed fails `check:protected`.

## 7. Non-blocking observations

- **O-1 — `compare()` parses before it verifies.** `repository-observation-adapter.ts:462-463` calls `parseEvidenceJson` on both records before the digest checks at `:465-469`. Every failure path converges on `invariantFault()`, so behavior is unchanged, but the ordering inverts the digest-first discipline that `verifyStored` (`:343-355`) and accepted plan §9.2 establish. Reordering costs nothing and keeps the rule uniform.
- **O-2 — the colon-root scenario is unreachable, not lazily deferred.** `config.ts:99-110` splits `CRAFTINGTABLE_REPOSITORY_ROOTS` on `node:path.delimiter`, so a colon-containing root cannot be expressed and fails at startup rather than reaching A1's `invalid-root-policy`. This is stricter and safer than accepted plan §5.3/§14, which describe it as an enabled-then-permanent lazy failure. The test titled "caches configuration and environmental invalidity permanently" (`repository-inspector-provider.test.ts:97`) exercises only a `configuration-required` fake, with no environmental case. Report §12 discloses this division honestly; the plan text and that test title are what overstate. Worth correcting the plan/title rather than the code.
- **O-3 — NUL paths are implemented but untested.** `config.ts:84` rejects NUL-containing paths, but the matrix at `config.test.ts:84-111`, titled "every lexical root-policy error", omits that case.
- **O-4 — operation is validated for membership, not per-code validity.** `repository-observation-policy.ts:201` checks `operation ∈ A1_OPERATION_KEYS` only. Report §7 states this accurately ("operation membership"); accepted plan §13 says "operation validity". No assessment depends on `operation`, so the gap is descriptive.
- **O-5 — relative cross-package deep imports are not structurally blocked.** `scripts/check-forbidden-scope.mjs:570-578` catches `@craftingtable/git` and `@craftingtable/git/*` specifiers, but a relative traversal such as `../../../../packages/git/src/command-runner.js` from server production source would not trip the A2b2a rule. TypeScript project boundaries make this impractical today; it is nonetheless a hole in an otherwise structural gate.

## 8. Disposition

Everything the accepted plan authorized is present, exact, and within budget; nothing it prohibited appears. Both findings are proof-and-gate integrity defects rather than product-boundary breaches, and both are small, local fixes.

Recommended sequence: fix F-01 in `repository-observation-adapter.test.ts`, fix F-02 in `check-ct04-protected-package.mjs`, optionally take O-1 and O-3, re-run `pnpm check`, and resubmit for exact-head re-review.
