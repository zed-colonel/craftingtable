# CT-04A1 remediation generation 2 — implementer invariant specification

Author: independent code reviewer (read-only role, `CT-04-process-protocol.md` §2)
Source findings: `review-findings/CT-04/CT-04A1-remediation-review.md` (A1-R-08, A1-R-09, A1-R-10)
Applies to: the head produced by committing remediation generation 1
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`

## Status and authority

This document states invariants and proof obligations. It is **not** an accepted
disposition and **not** a patch. Per protocol §5 the operator decides which findings are
accepted and the implementer records each disposition. Two items below additionally
require an operator decision before code, and are marked **OPERATOR DECISION**.

Per protocol §10, each accepted finding needs a closure record with: Finding ID,
generalized invariant, root cause, analogous surfaces inspected, repair, positive tests,
negative/adversarial tests, why the defect class is closed, remaining limitations, and the
new exact head SHA. A line-level patch without analogous-surface analysis is incomplete.

## Ordering constraint

Remediation generation 1 must be committed before this work begins. Protocol §8: "Any
remediation commit invalidates the prior verdict." Folding these findings into the
uncommitted generation-1 tree voids the existing APPROVE and collapses two review rounds
into one closure record.

---

## A1-R-08 — root policy owns ceiling representability

### Generalized invariant

A configured source root that cannot yield an unambiguous discovery ceiling for *any*
request beneath it is a policy-configuration fault, and must be refused when the inspector
is created. `caller-input` classification is reserved for path properties the caller
introduced *below* an otherwise valid root.

### Why the current code violates it

`packages/git/src/path-policy.ts:301-309` tests `dirname(requestedPath)`, which has the
source root as a path prefix. A source root containing a colon — including one inherited
from an ancestor such as a `/mnt/vol:1` mount point — therefore passes `createRootPolicy`
and then fails every request beneath it as `invalid-path` / `caller-input`. The operator is
never told the root is unusable, and per accepted plan §12.1 A2 maps `caller-input` to
request rejection without configuration inference.

### Required outcome

- `createRootPolicy` refuses a source root whose absolute path cannot be represented as a
  single ceiling entry, returning `invalid-root-policy` / `policy-configuration` /
  `configuration-required`.
- The per-request guard remains, unchanged in code and subject, for colons introduced
  below a valid root. Both checks must call one shared predicate (see A1-R-10), not two
  literals.

### Scope notes the implementer should verify rather than assume

- Reserved roots never become a ceiling value. `environmentFor` derives the ceiling only
  from `command.cwd`, and commands are constructed only from `admitted.canonicalTopLevel`
  and `allowedSourceRoots[0]`. Decide explicitly whether to validate reserved roots for
  symmetry, and record the decision either way.
- The `version` command receives no ceiling, so a colon-bearing source root is harmless
  for the version probe specifically. This change is a fail-fast diagnosis improvement,
  not a safety fix. State it that way in the closure record.

### Proof obligations

| Case | Expected |
| --- | --- |
| source root containing `:` | creation fails `invalid-root-policy` / `policy-configuration` / `configuration-required` |
| clean source root, colon in a component below it | request fails `invalid-path` / `caller-input` / `{reason:'ambiguous-git-ceiling'}` |
| colon in the repository basename, clean parent | observation succeeds (existing test must keep passing) |
| reserved root containing `:` | whatever the recorded decision requires — asserted, not incidental |

---

## A1-R-09 — bounded inspector creation

### Generalized invariant

Every dimension of inspector creation is bounded, consistent with accepted plan §6.1,
which bounds roots, timeouts, byte limits, and key counts. Creation must not admit an
input-proportional, unbounded amount of process work.

### Why the current code violates it

First-viable search probes one `--version` per distinct candidate.
`packages/git/src/configuration.ts` passes `signal` as `undefined` to every probe, so there
is no aggregate deadline. Worst-case creation latency is
`candidates × commandTimeoutMs` (default 5000 ms each) with no cap on candidate count.

### **OPERATOR DECISION** required

Two remedies, not mutually exclusive:

1. **Aggregate creation deadline.** Preferred. Does not reject legitimate configurations,
   and matches the existing `inspectionTimeoutMs` idiom. Needs a name, a default, and a
   bound range.
2. **Candidate cap.** Mirrors the 1–32 root bounds. Rejects rather than truncates — a
   silent cap would make "no viable Git" indistinguishable from "stopped looking".

A long ambient `PATH` in development is the realistic trigger; A2 is required to supply
explicit policy, so production exposure is low.

**Decision By Operator: Keith Sanders**
Go with option #1. For a personal application that will only ever run on my machine that I keep generally clean, I think following the existing idiom is acceptable. If it becomes a problem (unlikely) the bahavior can always be adjusted.

### Contract reconciliation

Accepted plan §7.2 states "Version runs once at inspector creation." That is now false and
the A1-R-04 disposition supersedes it in intent without amending the sentence. The closure
record must either amend §7.2 or state explicitly that the disposition governs. The
per-`inspect()` two-spawn invariant is unaffected and must be re-proven unchanged.

### Proof obligations

| Case | Expected |
| --- | --- |
| N stale candidates then one viable | creation succeeds; probe count asserted, not incidental |
| duplicate entries resolving to one canonical path | deduplicated to a single probe (existing behaviour, currently unasserted) |
| candidates exceeding the chosen bound | deterministic typed failure; no silent truncation |
| aggregate deadline exceeded, if adopted | typed failure; no further spawn afterwards |
| one successful `inspect()` | still exactly two spawns (A1-GIT-018 regression guard) |

---

## A1-R-10 — structural ceiling boundary

### Generalized invariant

A `FixedGitCommand` that requires a discovery ceiling cannot be constructed without a
ceiling already proven representable, and the module that owns `GIT_CEILING_DIRECTORIES`
syntax owns its validation. Correctness must not depend on a caller having passed through
an unrelated module first.

### Root cause — note for the closure record

This is not new design. Accepted plan §5 specifies the command union with
`cwd: CanonicalPath` and branded expected paths. `packages/git/src/environment.ts:3-12`
implements all three variants with `cwd: string`, and no `CanonicalPath` type exists in the
package. The residue is the `as string` cast at `packages/git/src/configuration.ts:285`,
which exists only because the specified type was never created.

The closure record should state **why the plan's typing was dropped during
implementation**. This is the second finding in this slice whose invariant class is
"structural boundary replaced by a value check" — the first being design finding A1-F-07 —
and protocol §13 asks for findings by invariant class and repeated findings. That answer is
the useful datum, more than the patch is.

### Required outcome — two layers

**Layer 1: restore `CanonicalPath` as a real brand.** Minted in exactly two places —
`createRootPolicy` for validated roots, `admitRepositoryPath` for the admitted request.
`FixedGitCommand` takes `CanonicalPath`. The existing `parsedRepositoryObservationBrand`
in `packages/git/src/types.ts:59-63` is the idiom to follow, and `asParsedObservation` is
the precedent for a single named unsafe mint that is exported from its module but **not**
re-exported from `index.ts`.

**Layer 2: move ceiling derivation to the ceiling's own module.** This is the layer that
actually closes the finding.

- `environment.ts` exports the representability predicate and a ceiling constructor. It
  owns the syntax rule, so it owns the check. `path-policy.ts` and `createRootPolicy` call
  it rather than repeating a colon literal.
- The `identity` and `local-risk-signal-names` variants carry a proven ceiling value. The
  `version` variant does not, because it receives no ceiling — the union should express
  that asymmetry rather than deriving a ceiling that one variant discards.
- `environmentFor` then computes nothing; it serializes an already-proven value.

Layer 1 alone is insufficient. `CanonicalPath` proves canonicality, not
ceiling-representability — a source root is legitimately canonical while having a
colon-bearing ancestor, which is harmless for `version` and fatal for the other two.

### **OPERATOR DECISION** required

Layer 2 changes the accepted plan §5 command-union shape by adding a ceiling field. It is
a private package-only interface, but §5 is binding and the amendment needs sign-off before
code.

**Decision By Operator: Keith Sanders**

Layer two is the result of my preferences, so I am OK with the amendment to §5. It is more structurally correct in my opinion.

### Coupled consequences — state these, do not discover them

- `RootPolicy.allowedSourceRoots` and `AdmittedRepositoryPath` become branded internally.
- `RepositoryInspectorOptions.allowedSourceRoots` stays `readonly string[]`. **No public
  surface change, no export-map change, no emitted-dist change, no A2 impact.**
- The `as string` cast at `configuration.ts:285` disappears. If any new cast appears in
  production, that is a signal the boundary is in the wrong place.
- Roughly fourteen test sites in `packages/git/test/command-runner.test.ts` construct
  commands directly and need a test-only mint in `packages/git/test/test-support.ts`. This
  is correct, not a workaround: the unsafe mint then lives inside the structural test
  boundary A1-F-07 established.
- `argumentsFor` and the runner signature are otherwise unchanged. No dependency or
  manifest change. Expected footprint: six files, no behavioural change.

### Proof obligations

| Case | Expected |
| --- | --- |
| production construction sites | every one obtains its path from a mint, none from a literal or cast |
| unsafe mint reachability | not exported from `packages/git/src/index.ts`; export-map test still proves `"."`-only |
| all existing ceiling behaviour | unchanged — colon basename succeeds, colon parent refused pre-spawn with zero repository spawns, real-Git no-ascent test still passes |
| emitted dist | unchanged shape; no test or fixture module emitted |

A scope-check or test asserting that `GIT_CEILING_DIRECTORIES` and the mint each appear in
one production module is worth adding as a **backstop**. It is a pattern check and must be
recorded as secondary to the structural rule, not as the rule itself.

---

## Analogous surfaces to inspect (protocol §10)

At minimum, and reported explicitly whether or not each yields a change:

- all three command variants, including the `version` variant that takes no ceiling;
- source roots versus reserved roots as ceiling sources;
- the `configuration.ts:285` version-probe cwd;
- every test construction site;
- any other production value that flows into a child environment variable or into argv —
  confirm `environmentFor` remains the only such site.

## Regression set to re-run

The probes below were run against both prior heads and are proposed for permanent
inclusion per protocol §9. They must all still hold:

newline-bearing basename observed successfully; JSON round-trip and self-comparison clean;
core-identity and fingerprint tamper rejection; 257-short-key `feature-count-exceeded`
versus 200-long-key `stdout-overflow` precedence; pre-aborted request returning `aborted`
with zero filesystem access; request-equals-root, missing path, relative path, symlinked
request; hooks symlink recorded without following; overlapping reserved root refused at
creation; strict-ancestor identity classified `not-primary-repository` /
`repository-class-changed` / `not-retryable`.

Full gate baseline to match or exceed: `pnpm check` exit 0, 60 test files / 472 tests, 4
Playwright tests, scope and protected checks passing; focused Git plus script suites 7
files / 80 tests.

## Out of scope

This generation creates no schema, migration, route, contract, durable state, binding,
audit action, event, notifier, or browser behaviour; adds no mutation, remote Git, or
second process authority; and does not compose the inspector into the daemon. A material
need to exceed this stops work for operator direction (accepted plan §22).
