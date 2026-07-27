# CT-04A1 design-review disposition

Status: **Accepted by Operator**
Adoption date: 2026-07-26
Slice: `CT-04A1 — Trusted Git inspection boundary`
Parent slice: `CT-04A — Trusted Git boundary and repository registration`
Parent milestone: `CT-04`

Reviewed proposed plan: `work-items/CT-04/CT-04A1-proposed-implementation-plan.md`
Reviewed plan SHA-256: `74685e1385970ef29165a7c5291d6de30bb7294a0ec0e043886e9088318b9aa0`
Independent design review: `review-findings/CT-04/CT-04A1-design-review.md`
Design review SHA-256: `c329b2741eb17c78c78523e582381c964d463bfc820f0c01d96f9e7817281e35`

Source baseline: `abc5f37815ad76430cae989224afde817d77a047`
Protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`
Protected acceptance SHA-256: `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`
Review checkout: `c42907b249578eca8ba51638543a069b8e0e880c`, branch `ct-04a-git-foundation`

Primary implementer: Codex / GPT 5.6 Sol
Independent design reviewer: Claude Code / Opus 5 (1M context), read-only session
Operator: Keith Sanders

## 1. Purpose and authorization boundary

This document records the operator's adjudication of the independent CT-04A1 design
review, in the sequence required by
`work-items/CT-04/CT-04A-operator-feedback-and-design-review-disposition.md` §8 Step 4 and
`work-items/CT-04/CT-04-process-protocol.md` §5.

It is read together with:

1. `work-items/CT-04/CT-04A1-proposed-implementation-plan.md`;
2. `review-findings/CT-04/CT-04A1-design-review.md`;
3. the parent CT-04 process protocol and protected acceptance specification.

It is **not** an accepted implementation plan.

Upon adoption this document authorizes the implementer to produce
`work-items/CT-04/CT-04A1-accepted-implementation-plan.md` **only**. It does not authorize
source-code implementation, migration 0003, HTTP routes, public contracts, repository state
or bindings, event-kind changes, browser changes, CT-04A2 planning beyond the handoff notes
already in the proposal, or any CT-04B-or-later behavior. Implementation remains
unauthorized until the operator separately approves and commits the accepted plan
(protocol §3, §7).

## 2. Overall operator disposition

The independent review's verdict is accepted as issued:

```text
PASS WITH ACCEPTED AMENDMENTS
```

**Every finding is accepted.** Findings A1-F-01 through A1-F-13 — 3 high, 5 medium, 4 low,
1 info — are accepted in full. The operator adopted the reviewer's recommendation on five
of the six decisions the review put to him, and selected a different, stronger remedy on
the sixth (A1-F-07, recorded in §3.5 below).

No finding was rejected, deferred, or downgraded.

Unlike the unified CT-04A adjudication, this is **not** a design revision. The review found
no false declared fact, no unimplementable claim, and no defect in the A1/A2 boundary. The
following properties of the proposal are affirmed and must survive the amendments unchanged:

- the A1/A2 split as adopted, with A1 owning observation only;
- the closed three-variant `FixedGitCommand` union with no public argv, environment, or
  runner carrier;
- the constructed child environment rather than a cloned and scrubbed `process.env`;
- lazy, explicit inspector creation with no daemon startup dependency;
- the Git 2.32.0 floor with vendor-tolerant version parsing;
- the raw-byte identity template, which is the correct answer to REG-PATH-012 and is
  strictly better than the unified plan's newline splitting;
- the lowercase config-key correction in §2.2;
- independent stdout/stderr bounds, deadline, termination, and no-partial-success;
- exact primary-checkout and symlink admission policy;
- effective-UID ownership refusal with no `safe.directory` escape hatch;
- the correct protected-package pin, literal two-file manifest, and negative probe;
- 27 files, one authority boundary, no schema, no journal, no browser surface.

The review independently verified the plan's declared facts against the checkout and
against Git 2.54.0, including execution of both production commands under the exact
constructed environment. All four literal hashes in plan §2 and §17 were confirmed correct.

## 3. Reviewer questions and operator answers

The review put six decisions to the operator. Each is recorded below with the question as
asked, the reviewer's recommendation, and the operator's answer.

### 3.1 Identity-failure discrimination (A1-F-01)

**Question.** Should the identity parser discriminate repository-class failures, or is
whole-output equality with a single `malformed-identity-output` code sufficient?

**Reviewer recommendation.** Accept. Keep whole-output byte equality as the acceptance
test, and add tail-field classification on failure so `not-primary-repository` becomes
reachable. Without it, three protected REG-PATH cases are proved by a code that says
"malformed output" when the truth is "this is not a primary checkout", and the plan's own
A1-PATH-016/017/019 expectations are unreachable.

**Operator answer.** **Accepted as recommended.**

### 3.2 Failure-classification axis for A2 (A1-F-02)

**Question.** Does A1 owe A2 a semantic classification axis over its 24 error codes, or is
the existing `retryability` field enough?

**Reviewer recommendation.** Accept the added axis. The split's stated purpose was a seam
A2 can be reviewed against; a taxonomy with no semantic grouping pushes the
REG-ID-005/006/007 discrimination into A2 with no A1-side contract to review it against.

**Operator answer.** **Accepted as recommended.**

### 3.3 Recorded-observation parse contract (A1-F-03)

**Question.** Must A1 export a validator for observations that A2 reads back out of
storage, and define behavior on version mismatch?

**Reviewer recommendation.** Accept. This is source-assessment §6 defect class 3 ("weak
runtime boundary schemas") arriving one slice early, on the one function that gates
CT04-I05. A missing field currently compares equal to a missing field, so a corrupt stored
row reports "identity unchanged".

**Operator answer.** **Accepted as recommended.**

### 3.4 Reserved-root topology (A1-F-04)

**Question.** Should the plan keep its requirement that artifact and managed-worktree roots
be strict descendants of the data root?

**Reviewer recommendation.** Replace it with pairwise non-overlap in both directions, and
stop requiring A2 to name CT-04C/D roots. The descendant rule is invented by A1, is not
required by CT04-I04, REG-PATH-009, REG-PATH-010, or the implementation guidance, and binds
two later slices from the slice with the least information. If the layout is wanted as
deployment policy it belongs in `docs/operations.md`.

**Operator answer.** **Accepted as recommended.**

### 3.5 Fixture-module placement (A1-F-07)

**Question.** How should the second, unbounded, scope-exempt Git execution path be kept out
of shipped package output — by manifest exclusion pattern, or by relocation?

**Reviewer recommendation.** Exclude `test-support.ts` from the package build via
`tsconfig.json`, or move fixtures outside `src`.

**Operator answer.** **Accepted with the operator's remedy, not the reviewer's first
option.** Test and fixture modules move **outside the `src` root**. In the operator's
words:

> I think the correct move is to have any fixtures outside the `src` root. That matches my
> objective assumptions within an application repository and ensures that we have a
> location for any future test fixtures that might be "accidentally" included in a
> distribution directory because they don't match a pattern we add to the manifest now.

**Supporting evidence gathered after the decision.** The operator's reasoning is confirmed
by the repository's current state: every package already emits its tests into `dist`,
because all eight package `tsconfig.json` files use `"include": ["src"]` with no exclude.
Present in the working tree at the review checkout:

```text
packages/planning/dist/aq-fixture.test.js
packages/testing/dist/fake-git-service.test.js
packages/contracts/dist/workspace-event.test.d.ts
apps/server/dist/config.test.js
```

"In `src`" therefore already means "shipped in `dist`" repo-wide. A pattern-based exclude
would have been a per-file allowlist over a systemic default — exactly the escape the
operator identified.

**Binding consequences.** Because `rootDir` is `src` in every package, the remedy is
structural and its parts are coupled. The accepted plan must specify all five:

1. new location `packages/git/test/` holding the five `*.test.ts` modules **and** the
   fixture builders — the test modules must move with the fixtures, because a file under
   `src` importing a sibling outside `rootDir` is a `tsc` error and a partial move does not
   build;
2. `packages/git/tsconfig.json` keeps `"include": ["src"]` and `"rootDir": "src"`, so
   `dist` emits production modules only;
3. `packages/git/tsconfig.test.json` (`"noEmit": true`) plus an extension of the root
   `typecheck` script, which already has precedent for a second explicit invocation
   (`tsc -b && tsc --noEmit -p apps/web`);
4. `vitest.config.ts`'s `node` project gains `packages/*/test/**/*.test.ts`, or the moved
   tests are silently not collected and a green run proves nothing;
5. `scripts/check-forbidden-scope.mjs` walks only `<packageDir>/src` and must be extended
   to the new directory, so the Exo Stack and NUL-byte rules still apply there.

**Scope limit.** A1 establishes this convention for `packages/git` only and records it in
ADR-008 for future slices. Retrofitting the other seven packages is a separate decision and
is explicitly **out of CT-04A1 scope**.

### 3.6 Re-review before the accepted plan (procedural)

**Question.** Do A1-F-01 and A1-F-03 warrant a second design review before the accepted
plan, since both change the public API surface?

**Reviewer recommendation.** No second design review. Record the dispositions, let the
amendments land in the accepted plan, and let the exact-head code review carry them. Every
other finding is a plan-text amendment.

**Operator answer.** **Accepted as recommended.** CT-04A1 proceeds directly to the accepted
plan.

## 4. Finding-by-finding disposition

| Finding | Severity | Title | Disposition |
|---|---|---|---|
| A1-F-01 | High | Identity parse conflates repository-class rejection with malformed output | Accepted as recommended |
| A1-F-02 | High | Failure taxonomy gives A2 no axis for durable state | Accepted as recommended |
| A1-F-03 | High | Recorded observations cross persistence with no parse contract | Accepted as recommended |
| A1-F-04 | Medium | Reserved-root policy binds CT-04C and CT-04D | Accepted as recommended |
| A1-F-05 | Medium | External-execution boundary omits config-key classes; names overclaim | Accepted as written |
| A1-F-06 | Medium | Fixture construction has no environment isolation | Accepted as written |
| A1-F-07 | Medium | Test/fixture modules ship in compiled package output | Accepted with operator's structural remedy (§3.5) |
| A1-F-08 | Medium | Bound arithmetic unreconciled; deadline scope unstated | Accepted as written |
| A1-F-09 | Low | Detached process groups leave unbounded orphans | Accepted as written |
| A1-F-10 | Low | Discovery ascent constrained only by output comparison | Accepted as written |
| A1-F-11 | Low | Executable resolution and root-UID policy underspecified | Accepted as written |
| A1-F-12 | Low | Protected gate depends on Git history being present | Accepted as written |
| A1-F-13 | Info | Architecture-diagram premise; symlink-policy operability | Accepted as written |

The review's coverage-gap section is accepted in full as an input to the accepted plan; its
items are consolidated as amendment 14 below.

## 5. Binding amendment list

The accepted plan must reconcile all fourteen items in the review's
"Binding amendment list" (`review-findings/CT-04/CT-04A1-design-review.md`, section
*Operator dispositions and required plan amendments*), which is adopted here by reference
and is authoritative for section mapping:

```text
 1  §8.2/§13/§14.2   tail-field classification; work-tree diagnostic mapping   A1-F-01
 2  §13/§20          disposition-class field and code→class table             A1-F-02
 3  §6/§12.1/§12.3   parseRecordedObservation; version rule; fingerprint      A1-F-03
 4  §7/§11.1         pairwise non-overlap; reserved roots as list/optional    A1-F-04
 5  §8.2/§12.2       scan-scope self-description; key exclusions; core.worktree A1-F-05
 6  §16              constructed env and realpath temp roots for fixtures     A1-F-06
 7  §3.3/§5/§21/§14  fixture relocation and its five coupled consequences     A1-F-07
 8  §7/§10/§14.3     bound arithmetic; precedence; deadline scope; pre-abort  A1-F-08
 9  §10              honest orphan-lifetime statement; CT-04C handoff note    A1-F-09
10  §9/§8.2          GIT_CEILING_DIRECTORIES as defence in depth              A1-F-10
11  §7/§11.3/docs    executable precedence; production search path; root UID  A1-F-11
12  §17/§19          protected-gate split: hasher vs pinned Git comparison    A1-F-12
13  §18/docs         drop non-existent diagram repair; record symlink policy  A1-F-13
14  §14              nine coverage-gap rows plus the no-host-file statement   gaps
```

Per protocol §8 Step 5, the accepted plan must carry a reconciliation appendix mapping:

```text
review finding → operator disposition → accepted-plan section → proof cases
```

## 6. What these amendments do not change

The operator records explicitly, so the implementer does not reopen settled ground:

- the CT-04A1 / CT-04A2 boundary and the dependency rule "A2 may request a repository
  observation; it may not know how Git produced it";
- the single new authority boundary and the judgement that no further split is warranted;
- the three-variant production command surface;
- the constructed environment and its ten variables, subject only to the per-invocation
  addition in amendment 10;
- the protected-package pin, manifest, and negative probe;
- the assignment of F-02, F-05, F-06, F-07, F-10 through F-16, F-19 and F-20 of the
  original CT-04A review to CT-04A2.

The file tree grows by the relocated test and fixture paths plus `tsconfig.test.json`,
`vitest.config.ts`, and the forbidden-scope walker change. The accepted plan must restate
its scope estimate against the corrected tree rather than carrying the proposal's figure
forward, and must retire the proposal's claim that no TypeScript project file changes.

## 7. Required next steps

```text
Step 1  Commit the proposal, the design review, and this disposition as
        immutable review evidence. Do not rewrite them when the accepted
        plan is created.

Step 2  Implementer produces
        work-items/CT-04/CT-04A1-accepted-implementation-plan.md
        reconciling all fourteen amendments with the required appendix.

Step 3  Operator reviews, approves, and commits the accepted plan.
        No second design review is required (§3.6).

Step 4  Implementation proceeds in one bounded generation unless the
        accepted plan itself triggers a further split.

Step 5  Deterministic verification at the exact head, then independent
        exact-head code review, then remediation at the invariant level
        if required.

Step 6  Merge the accepted A1 result into the CT-04 integration branch.

Step 7  Only then produce the CT-04A2 source-grounded package against the
        real accepted A1 API and error model.
```

The complete original CT-04A protected acceptance suite remains the parent exit gate and
runs only after A1 and A2 are integrated. CT-04A must not be marked complete after A1
alone.

## 8. Process record (protocol §13)

```text
slice                       CT-04A1
implementer harness         Codex / GPT 5.6 Sol
reviewer harness            Claude Code / Opus 5 (1M context), read-only
plan reviewed               74685e13…18b9aa0
design review               c329b274…7281c35
predicted scope at proposal 27 files, ~2,800–4,200 lines
findings by severity        0 blocking, 3 high, 5 medium, 4 low, 1 info
findings accepted           13 of 13
operator decisions asked    6
recommendations adopted     5 of 6; A1-F-07 resolved with a stronger operator remedy
design revisions required   0 (verdict was PASS WITH ACCEPTED AMENDMENTS)
re-reviews required         0
human interventions         1 (A1-F-07 remedy selection)
```
