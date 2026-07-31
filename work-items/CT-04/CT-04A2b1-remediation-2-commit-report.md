# CT-04A2b1 remediation 2 commit report

**Status:** Ready for independent remediation review
**Independent-review record head:**
`569586c11d400e6811b99982b5b1c9ea8fe842a0`
**Reviewed remediation head:**
`b8a5493b9e33a82c3e4d6b43e39d6e4422d05576`
**Independent remediation review:**
`review-findings/CT-04/CT-04A2b1-remediation-1-review.md`
**Independent remediation review SHA-256:**
`4d35f08915b279918e3809cddeff6ebfac6cb45f213abca113513a0a0a83a8f8`
**Date:** 2026-07-30

## Lineage

The remediation head exists on branch
`ct=04a2b1-repository-journal`, has the independent remediation-review record
commit as its first parent, and descends from the accepted source, planning,
implementation, and first-remediation heads.

```text
b8a5493b9e33a82c3e4d6b43e39d6e4422d05576
ct-04a2b1: close remediation review findings
```

This exact-head report is intentionally introduced after the remediation
commit. It does not amend the immutable remediation-turn report, which
correctly recorded that no remediation head existed when it was created.

## Remediation under review

- `B1-R-02`: Git-owned exclusion of the complete root `.ct04a-*` test-scratch
  class, removal of the checker carve-out, and permanent inventory regression
  coverage for both known namespaces and near-misses;
- `B1-A-07`: lexical comment stripping before import scanning, with direct and
  end-to-end adversarial coverage;
- accepted-plan amendment from 31 to 32 files for `.gitignore` and the
  independent-review/operator disposition.

Already closed findings remain unchanged.

## Validation attached to the remediation head

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

focused remediation:
  2 files / 48 tests passed

former race combination:
  12 consecutive runs passed
  924 repeated test executions passed

git diff --check passed
```

Migration 0004 remains:

```text
409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e
```

## Scope boundary

No protected specification, A1 production source, A2a state primitive,
migration, manifest, lockfile, production server file, route, service,
repository configuration, notifier producer, repository fetch, or repository
view changed.

**B2 lifecycle commands remain absent.**
