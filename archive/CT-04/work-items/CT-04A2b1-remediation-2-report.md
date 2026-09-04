# CT-04A2b1 remediation 2 report

**Status:** Remediation complete and validated; remediation commit not created
**Independent-review record head:**
`569586c11d400e6811b99982b5b1c9ea8fe842a0`
**Reviewed remediation head:**
`20235b33293c1dd872afcf85ccf3389ccf49633d`
**Reviewed report-only head:**
`769fc0807564d4790075bcd0fb265da23e8745b8`
**Independent remediation review:**
`review-findings/CT-04/CT-04A2b1-remediation-1-review.md`
**Independent remediation review SHA-256:**
`4d35f08915b279918e3809cddeff6ebfac6cb45f213abca113513a0a0a83a8f8`
**Remediation head:** intentionally absent — no remediation commit has been
authorized or created
**Date:** 2026-07-30

## Operator disposition

The operator required completion of blocking finding `B1-R-02` in the review's
prescribed sequence and directed closure of advisory `B1-A-07` in this same
remediation turn. The accepted plan records both dispositions and expands its
exact implementation/documentation tree from 31 to 32 files for `.gitignore`.

Already closed findings remain unchanged. No protected specification was
edited.

## Finding closure

### B1-R-02 — deterministic protected inventory

Git is now the single authority for excluding the complete root CT-04A test
scratch class:

```gitignore
.ct04a-*/
```

The protected checker admits `.gitignore` in the accepted B1 tree and no longer
contains the superseded `.ct04a-git-test-*` namespace carve-out. Consequently,
`git ls-files --others --exclude-standard` excludes both known concurrent
scratch namespaces through the repository's normal ignore machinery:

```text
.ct04a-git-test-<suffix>/
.ct04a-hostile-home-<suffix>/
```

A permanent regression test creates both namespaces with real files in the
working tree and proves the complete B1 inventory remains clean. The checker
still rejects `.ct04a-git-testX/evil.ts`, a root near-miss file, and a nested
lookalike.

The six-file race combination — all five `packages/git` test files plus the
protected-package tests — passed 12 consecutive runs:

```text
12 × (6 files / 77 tests) = 924 passing test executions
```

### B1-A-07 — comment-safe import scanning

The scope checker now performs a lexical comment-stripping pass before applying
the shared import pattern. It replaces line and block comment content with
whitespace, preserves newlines and quoted text, and therefore preserves module
specifiers without allowing comment punctuation to terminate a multi-line
import match.

Permanent tests prove:

- apostrophes and double quotes in line/block comments cannot hide
  `node:child_process` or `@craftingtable/git`;
- commented-out forbidden imports do not create spurious edges;
- comment markers inside a quoted module specifier remain intact;
- the full workspace check emits all four expected exact-path,
  capability, and non-production-seam violations for the adversarial imports.

## Validation

Focused remediation validation:

```text
2 focused files / 48 tests passed
format:check passed
check:scope passed
check:protected passed
git diff --check passed
```

Race reproduction:

```text
12 consecutive combined Git/protected runs passed
924 total repeated test executions passed
```

Complete elevated-loopback gate:

```text
pnpm check passed
format:check passed
lint passed
typecheck passed
build passed
68 Vitest files / 609 tests passed
4 Playwright tests passed
check:scope passed
check:protected passed
```

Immutable and migration hashes:

```text
migration 0001  42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273
migration 0002  6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247
migration 0003  526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
migration 0004  409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e
CT-04 protected  ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
A2 supplement     1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
A2b supplement    255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad
```

## Scope and next boundary

This turn changes only `.gitignore`, the two scope/protected checkers and their
tests, and the accepted plan, plus this immutable report. No A1 production
source, A2a state primitive, migration, package manifest, lockfile, production
server file, route, service, repository configuration, notifier producer,
repository fetch, or repository view changed.

The worktree is ready for a separately authorized remediation commit. A new
exact-head report must be created only after that commit exists, followed by a
fresh independent remediation review.

**B2 lifecycle commands remain absent.**
