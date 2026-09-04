# CT-04A1 Initial-Review Remediation Report

**Work item:** CT-04A1 — Trusted Git inspection boundary
**Review addressed:** `review-findings/CT-04/CT-04A1-initial-review.md`
**Operator disposition:** `work-items/CT-04/CT-04A1-initial-review-disposition.md`
**Reviewed head:** `94465cb847e6571f2f10e55c0c3764bfa422646e`
**Protected-package pin:** `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
**New exact head SHA:** `2180ae187edc13ed35482c07f484d910f0265a56`

## 1. Summary

This remediation closes A1-R-01, A1-R-02, A1-R-04, and A1-R-05 with
production fixes and permanent adversarial tests. It preserves the operator's
accepted conservative working-tree behavior for A1-R-03. It records the
otherwise easy-to-miss A2 constraints from A1-R-06 and A1-R-07 in the
operator disposition, architecture, operations guide, and ADR.

The remediation does not compose the inspector or add any durable repository
behavior.

## 2. Finding closure

### A1-R-01 — strict-ancestor identity classification

**Generalized invariant.** Once identity output is structurally framed and its
three path-free tokens are valid, a supported tail with any non-exact path
prefix is a repository-class change. Parse corruption is reserved for
unframed or invalid-token output.

**Root cause.** The last `knownPrefix` ternary was inverted. The branch that
proved a recorded strict-ancestor prefix selected
`malformed-identity-output`.

**Analogous surfaces inspected.** Exact raw-byte SHA-1/SHA-256 success,
bare/inside-work-tree tokens, unsupported object formats, unframed output,
unknown but structurally framed prefixes, stderr classification, and recorded
ancestor templates were checked. The known-prefix value still contributes to
safe structural framing; it no longer changes the final repository-class
result.

**Repair.** The final supported, well-framed mismatch always returns
`not-primary-repository`.

**Positive tests.** Exact raw-byte identity success remains covered in
`packages/git/test/command-runner.test.ts` and live primary-checkout success in
`packages/git/test/repository-inspector.test.ts`.

**Negative/adversarial tests.** The command-runner suite now passes a non-empty
`ancestorCandidates` list and asserts
`not-primary-repository` / `repository-class-changed` / `not-retryable`.
Existing malformed, bare, and unsupported-format cases remain distinct.

**Why the defect class is closed.** The parser now has one structural-framing
failure path and one supported-but-non-exact repository-class path; there is no
remaining prefix-dependent ternary after token validation.

**Remaining limitations.** A hostile concurrent local owner remains outside
the A1 trust model.

### A1-R-02 — unambiguous Git discovery ceiling

**Generalized invariant.** Every admitted repository command must carry a
single unambiguous ceiling that prevents ancestor discovery. If POSIX Git
cannot represent that parent as one environment-list entry, admission must
fail before spawn.

**Root cause.** A canonical parent was inserted verbatim into a
colon-delimited environment variable even when the parent contained a colon.

**Analogous surfaces inspected.** Colon in the repository basename, colon in
the repository parent, plain nested repositories, leading dashes, newlines,
other metacharacters, source-root admission, fixed environment construction,
and spawn counts were checked.

**Repair.** Path admission rejects `dirname(requestedPath)` containing `:`
with `invalid-path` and fixed evidence reason `ambiguous-git-ceiling`. The
check runs before any request filesystem access or repository spawn. A colon
in the exact repository basename remains valid when its parent has none.

**Positive tests.** A real repository whose basename contains a colon is
successfully observed. A real runner probe against a plain nested empty
`.git` proves Git returns “not a git repository” rather than discovering the
parent checkout.

**Negative/adversarial tests.** A counting executable proves an ambiguous
colon-bearing parent is refused after only the creation-time version probe and
before either repository command.

**Why the defect class is closed.** Every repository command receives
`dirname(requestedPath)` as its only ceiling value, and the admission predicate
now proves that value contains no list separator.

**Remaining limitations.** POSIX paths with a colon in the request parent are
intentionally unsupported. This is documented as a representation limit, not
a shell-metacharacter restriction.

### A1-R-03 — conservative working-tree race scope

**Generalized invariant.** The implementation and A2 operational contract must
describe the same evidence that can invalidate an observation.

**Root cause.** The accepted plan and initial report used shorthand about
structural/inode replacement even though snapshots also compare size and
mtime.

**Analogous surfaces inspected.** Top-level, `.git`, config, hooks, canonical
resolution, kind, device, inode, size, and mtime snapshots were reviewed.

**Repair.** Per operator direction, production code is unchanged. The
disposition, ADR, architecture, operations guide, and initial-report erratum
now state that ordinary top-level entry activity can cause
`observation-raced`.

**Positive tests.** Quiet real repositories continue to inspect successfully.

**Negative/adversarial tests.** Existing postflight metadata-change coverage
continues to prove fail-closed `observation-raced`.

**Why the defect class is closed.** A2 now receives an explicit binding
constraint to perform both registration inspections only on a clean,
quiescent working tree and to retry only after activity stops.

**Remaining limitations.** Registration during ordinary concurrent top-level
working-tree activity can fail conservatively. The operator explicitly accepts
this personal-use tradeoff.

### A1-R-04 — first-viable executable search

**Generalized invariant.** A configured search entry is viable only after
canonical executable admission and a successful supported-version probe.
Explicit executable policy must never fall back.

**Root cause.** Search returned the first executable file before running the
version probe.

**Analogous surfaces inspected.** Explicit executable precedence, explicit
symlink rejection, search symlink canonicalization, invalid and relative
entries, duplicate canonical targets, failed output, malformed versions,
unsupported versions, and the no-candidate case were checked.

**Repair.** Search collects ordered, deduplicated canonical candidates and
probes them in order. It selects the first Git 2.32-or-newer result. If no
candidate succeeds, it returns the first meaningful probe failure. Explicit
configuration still considers exactly one target.

**Positive tests.** A search path containing a Git 2.31 proxy followed by the
real supported Git now creates the inspector successfully.

**Negative/adversarial tests.** A search path containing only the old proxy
returns `unsupported-git-version`, preserving meaningful failure evidence.
The existing explicit-old-Git case remains non-fallback.

**Why the defect class is closed.** Candidate discovery and viability are now
separate phases, and successful configuration can be returned only inside the
per-candidate supported-version branch.

**Remaining limitations.** Search-path list syntax itself follows the host
POSIX delimiter; production A2 is still required to supply explicit policy
rather than ambient `PATH`.

### A1-R-05 — strict option shape and numeric defaults

**Generalized invariant.** Only omitted optional fields receive defaults.
Present fields of the wrong runtime type are policy-configuration errors
before filesystem or process authority is used.

**Root cause.** Nullish coalescing treated `null` as omitted, and shape
validation covered roots and keys but not optional scalar types.

**Analogous surfaces inspected.** All five numeric bounds, both executable
strings, unknown keys, nonintegers, range endpoints, incoherent total/command
budgets, `NaN`, and infinity behavior were checked.

**Repair.** Numeric defaults now apply only to `undefined`.
`validateOptionShape` validates both optional strings and all optional numeric
fields before platform, filesystem, or executable resolution.

**Positive tests.** Omitted defaults and exact numeric endpoints continue to
create a valid inspector.

**Negative/adversarial tests.** `null` is rejected for every numeric bound.
`gitExecutable: 42` returns
`invalid-options` / `policy-configuration` / `configuration-required`.

**Why the defect class is closed.** Every public option key is now covered by
the initial runtime shape predicate, followed by the existing integer,
range, and coherence checks for numeric values.

**Remaining limitations.** None beyond the documented numeric ranges and
platform requirements.

### A1-R-06 — A2 unreachable-error handoff

No A1 production change was required. The disposition and architecture state
that coherent source/reserved topology discharges `A1-PATH-014` at creation
with `invalid-root-policy`. A2 must not expect inspect-time
`reserved-root-overlap`; a disjoint reserved location is outside the admitted
source root and produces `outside-allowed-root`.

### A1-R-07 — A2 full-record integrity handoff

No A1 production change was required. The disposition, architecture, and ADR
state that the SHA-256 fingerprint authenticates core identity only. A2 must
protect integrity for risk-scan evidence, device evidence,
`canonicalGitDirectory`, and `observedAt`, or a later reviewed policy version
must widen the fingerprint.

## 3. Permanent proof mapping

| Finding / obligation | Permanent proof |
| --- | --- |
| A1-R-01; A1-F-01; A1-PATH-016/019/027/028; A1-EVID-004 | `packages/git/test/command-runner.test.ts` — non-empty strict-ancestor identity classification |
| A1-R-02; A1-PATH-021/028 | `packages/git/test/command-runner.test.ts` — real Git no-ascent ceiling; `packages/git/test/repository-inspector.test.ts` — colon basename success and colon-parent pre-spawn refusal |
| A1-R-03; A1-PATH-022 | `packages/git/test/repository-inspector.test.ts` — quiet success and postflight evidence-change failure; operator constraint in disposition and operations |
| A1-R-04; A1-CFG-012 | `packages/git/test/configuration.test.ts` — old-then-current first-viable selection and first failure preservation |
| A1-R-05; A1-CFG-010 | `packages/git/test/configuration.test.ts` — null numeric matrix and malformed executable option |
| A1-R-06; A1-PATH-014 | `packages/git/test/path-policy.test.ts` — configuration-time cross-set overlap rejection; A2 handoff documentation |
| A1-R-07; A1-EVID-001/002/011/012/022 | `packages/git/test/comparison.test.ts` — exact core-fingerprint and recorded-parser scope; A2 handoff documentation |

## 4. Verification actually run

```text
pnpm exec vitest run packages/git/test/configuration.test.ts \
  packages/git/test/command-runner.test.ts \
  packages/git/test/repository-inspector.test.ts
  initial run: exit 1, 36 passed / 5 failed because short Node proxy writes
  were not deterministic at child close
  final run after synchronous fixture writes: exit 0, 41/41 passed

pnpm exec tsc -p packages/git/tsconfig.test.json --noEmit
  exit 0

pnpm exec biome format --write <eleven remediation-owned files>
  exit 0; two files changed
pnpm format:check
  exit 0
pnpm lint
  exit 0
pnpm typecheck
  exit 0

pnpm check
  sandbox run: exit 1; 462/472 Vitest tests passed, ten loopback SSE
  cases failed only with listen EPERM 127.0.0.1
pnpm check
  approved unsandboxed rerun: exit 0
  format, lint, typecheck, build passed
  60 test files / 472 tests passed
  4 Playwright tests passed
  scope and history-independent protected checks passed

git cat-file -e \
  06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4^{commit}
  exit 0
git diff --exit-code \
  06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4 -- protected/
  exit 0

pnpm exec vitest run packages/git/test \
  scripts/check-forbidden-scope.test.ts \
  scripts/check-ct04-protected-package.test.ts
  exit 0; the two mistyped nonexistent .ts script paths were not collected,
  so this run covered 5 files / 60 tests only

pnpm exec vitest run packages/git/test \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs
  exit 0; 7 files / 80 tests passed

git diff --check
  exit 0
```

The test-only Node proxies used by the output-boundary cases now write short
payloads synchronously with `fs.writeSync`. This removes fixture timing from
the assertions without changing production runner semantics.

## 5. Protected-package verification

The correct protected-package pin is
`06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`. The literal manifest/hash checker
passed inside `pnpm check`, its positive and negative tests passed in the
focused 80-test run, the pin exists locally, and `protected/` has no diff
against it. No protected file was edited.

## 6. Known limitations

- Only non-root POSIX operation with Git 2.32.0 or newer is supported.
- A parent path containing `:` cannot be represented safely as the single Git
  ceiling entry and is rejected.
- Ordinary top-level working-tree entry changes can conservatively produce
  `observation-raced`; A2 must require a clean, quiescent registration window.
- The core fingerprint does not authenticate every serialized observation
  field; A2 owns full-record storage integrity.
- `reserved-root-overlap` is defense-in-depth code, not a reachable A2
  inspection result under coherent configuration.
- The total deadline remains cooperative around kernel-blocked filesystem
  syscalls, and hard daemon death has no bounded orphan-lifetime guarantee.

## 7. Explicit CT-04A2+ scope check

This remediation creates no schema, migration 0003, SQLite row, repository
state, inspection record, ID, binding, route, authorization response, audit
action, workspace event, transaction, notifier call, or browser behavior. It
adds no change request, branch, checkout, worktree mutation, status, diff,
artifact store, agent, verification runner, arbitrary process, remote Git, or
credential behavior.

The only production authority remains the existing closed three-command A1
Git boundary.
