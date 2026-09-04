# CT-04A2b2a remediation 1 commit report

**Status:** Ready for independent final implementation review

**Reviewed implementation head:**
`97af775368bcfd3633fea4081651089096eab53a`

**Implementation-report commit:**
`87964221e4dd0ce96ca87fcea591c676fdb5d6c3`

**Independent review:**
`review-findings/CT-04/CT-04A2b2a-code-review.md`

**Independent review SHA-256:**
`08c1cb3918c7aedc0c29c7037018481e2c3a0c990898546f630c538e098204b4`

**Remediation head for independent review:**
`0c2e9ba68abecd904bae81a9faae5074b4e29fb6`

**Amended accepted-plan SHA-256:**
`451429f6acca20a1812c2cd18ad79fd3eaab912a8ebb5ded53334833dc3fe02b`

**Date:** 2026-08-12

## Lineage

The remediation head exists on branch
`ct-04a2b2a-repository-evidence-boundary`, has the implementation-report commit
as its first parent, and descends from the accepted source, planning, and
implementation heads.

```text
0c2e9ba68abecd904bae81a9faae5074b4e29fb6
ct-04a2b2a: remediate implementation review
```

This exact-head report is intentionally introduced after that commit. It does
not amend the remediation-turn report, which correctly recorded that no
remediation head existed when it was written.

## Remediation under review

- F-01: positive A1/domain parity uses captured real package-root exports rather
  than domain-seeded module replacements;
- F-02: the live protected checker enforces an explicit 31-closed/7-residual
  register and rejects overlap, omissions, and unknown declarations;
- O-1: defensive comparison verifies both digests before parsing;
- O-2/O-3: delimiter-bearing and NUL-containing path behavior is tested and
  accurately documented;
- O-4: every A1 code has an exact permitted-operation set checked at runtime;
- O-5: relative cross-package traversal into `packages/git` is resolved and
  rejected structurally.

The accepted plan contains only the operator-directed O-2/O-4 consistency
amendment. The independent review, disposition, and full remediation-turn
report are included in the remediation head.

## Validation attached to the remediation head

```text
focused remediation: 6 files / 85 tests passed

pnpm check passed
  format:check passed
  lint passed
  typecheck passed
  build passed
  72 Vitest files / 646 tests passed
  4 Playwright tests passed
  check:scope passed
  check:protected passed

git diff --check passed
```

The frozen protected, A1 process/comparison, contracts, storage, routes,
server, browser, and A2b2 supplement surfaces remain unchanged from reviewed
implementation head `97af775`.

## Scope boundary

No route, HTTP mapping, authorization, audit, event, notifier, storage mutation,
lifecycle transaction, registration/inspection/reaffirmation command,
retirement, binding, repository query, browser behavior, Git mutation,
directory creation, worktree/ref/diff/artifact behavior, or CT-04B+ capability
was added.
