# CT-04A2b2a remediation 1 report

**Status:** Remediation complete and validated; remediation commit not created

**Reviewed implementation head:**
`97af775368bcfd3633fea4081651089096eab53a`

**Implementation-report commit:**
`87964221e4dd0ce96ca87fcea591c676fdb5d6c3`

**Independent review:**
`review-findings/CT-04/CT-04A2b2a-code-review.md`

**Independent review SHA-256:**
`08c1cb3918c7aedc0c29c7037018481e2c3a0c990898546f630c538e098204b4`

**Disposition:**
`work-items/CT-04/CT-04A2b2a-review-disposition.md`

**Amended accepted-plan SHA-256:**
`451429f6acca20a1812c2cd18ad79fd3eaab912a8ebb5ded53334833dc3fe02b`

**Remediation head:** intentionally absent — no remediation commit has been
authorized or created

**Date:** 2026-08-12

## 1. Summary

This remediation closes both changes-required findings and deliberately
reconciles all five review observations.

- F-01 now proves parity against values captured from the real unmocked A1
  package root.
- F-02 replaces dead derived input with a live explicit 31-closed/7-residual
  register.
- O-1 restores digest-before-parse ordering in defensive comparison.
- O-2 corrects delimiter-bearing-root claims in the accepted plan,
  documentation, and provider test title, with a config regression case.
- O-3 adds the missing NUL-path regression.
- O-4 strengthens operation membership to exhaustive per-code validity.
- O-5 resolves relative imports and rejects cross-package traversal into A1.

No protected specification or later-child contract changed. The complete
operator disposition and rationale are recorded in
`CT-04A2b2a-review-disposition.md`.

## 2. Finding closure

### F-01 — real package-root parity

The adapter test's `importOriginal()` callback captures A1's real ordered error
codes, code-to-subject record, and ordered risk signals in separate retained
fixtures before exposing mutable drift containers. `beforeEach` restores from
those real fixtures, not domain constants.

The positive test directly compares all three real A1 exports with domain
constants and then calls the production parity function. Missing, reordered,
and remapped drift tests continue through isolated module replacement. An A1
vocabulary change now fails the positive proof instead of silently turning
every enabled deployment permanently unavailable only at runtime.

### F-02 — executable closure/residual register

The protected checker now has two independent declarations:

```text
31 explicit A2b2a closed IDs
7 explicit B2b residual IDs with nonempty obligations
```

Live `verifyCt04A2b2aProofAnchors()` passes the closed register to
`a2b2aClosureRegisterViolations()`. That verifier rejects:

- any overlap between closed and residual IDs;
- any protected ID missing a disposition;
- any declared ID absent from the protected A2b2a set.

The permanent test first proves the real 31+7 register covers all 38 protected
IDs, then injects residual-bearing `B2-CFG-002` into the live closed input and
requires failure. Premature HTTP/authorization closure is therefore structural,
not documentary.

## 3. Observation reconciliation

### O-1 — digest first

`compare()` now verifies baseline and current exact UTF-8 digests before
calling `JSON.parse` on either value. Defensive failures still latch the
adapter/provider without producing an assessment.

### O-2 — delimiter-bearing list entries

No new escaping language was invented. `CRAFTINGTABLE_REPOSITORY_ROOTS` and
`CRAFTINGTABLE_GIT_SEARCH_PATH` use `node:path.delimiter`; a path containing
that delimiter cannot be represented as one entry and fails synchronous
lexical parsing.

Accepted-plan §5.3 and §14 plus operations documentation now say so. The config
matrix includes the delimiter-bearing form. The provider test title now
truthfully describes its fake as a configuration-required construction
failure. Missing/symlinked root behavior remains A1-owned and covered by A1's
permanent tests.

### O-3 — NUL path

The config matrix now includes a NUL-containing source-root value and proves
the existing synchronous rejection.

### O-4 — exact operation policy

The server policy adds an exhaustive compile-time record from all 35 A1 codes
to their exact permitted operations. Runtime normalization checks the observed
operation against that code-specific array after confirming it belongs to the
closed operation set.

Tests generate every accepted code/operation pair and reject both an invented
operation and a valid operation attached to the wrong code.

### O-5 — resolved relative A1 imports

The scope checker resolves relative production specifiers against the importing
file and repository root. Any cross-package target equal to or below
`packages/git` is treated as an A1 boundary import and rejected unless it is the
already-approved exact package-root seam. Relative imports internal to
`packages/git` remain valid.

Permanent proof includes direct resolver cases and an end-to-end scratch
repository whose server service traverses to
`packages/git/src/command-runner.js`; `runCheck()` reports the exact A2b2a
boundary violation.

## 4. Validation actually run

Focused remediation command:

```text
pnpm exec vitest run
  apps/server/src/config.test.ts
  apps/server/src/services/repository-inspector-provider.test.ts
  apps/server/src/services/repository-observation-adapter.test.ts
  apps/server/src/services/repository-observation-policy.test.ts
  scripts/check-forbidden-scope.test.mjs
  scripts/check-ct04-protected-package.test.mjs
```

Result:

```text
6 files / 85 tests passed
typecheck passed
lint passed with no diagnostics
format:check passed
check:scope passed
check:protected passed
git diff --check passed
```

Final elevated-loopback aggregate gate:

```text
pnpm check passed
  format:check passed
  lint passed
  typecheck passed
  build passed
  72 Vitest files / 646 tests passed
  4 Playwright tests passed
  check:scope passed
  check:protected passed
```

## 5. Scope and preservation

The remediation adds no route, HTTP mapping, authorization or role decision,
audit/event/notifier behavior, repository/inspection/binding storage mutation,
lifecycle transaction, registration/inspection/reaffirmation command,
retirement, bind/unbind behavior, query/disclosure service, browser behavior,
Git mutation, directory creation, worktree/ref/diff/artifact behavior, or
CT-04B+ capability.

The following remain unchanged from the reviewed implementation head:

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

The initial implementation report remains immutable and truthful for reviewed
head `97af775`. This report and the review disposition record the later
accepted-plan consistency amendment without rewriting that history.

The worktree is ready for a separately authorized remediation commit. After
such a commit, an exact-head remediation commit report should name the new head
for independent re-review.
