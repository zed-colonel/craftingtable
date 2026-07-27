# CT-04A1 initial-review disposition

**Review:** `review-findings/CT-04/CT-04A1-initial-review.md`
**Reviewed head:** `94465cb847e6571f2f10e55c0c3764bfa422646e`
**Operator adjudication:** 2026-07-26
**Slice:** CT-04A1 — Trusted Git inspection boundary

## Disposition summary

The operator accepted remediation of A1-R-01, A1-R-02, A1-R-04, and
A1-R-05 as recommended. A1-R-03 is accepted as a deliberate tighter
personal-use working-tree policy, with no detector change. A1-R-06 and
A1-R-07 require no A1 code change and are binding A2 handoff information.

This disposition clarifies the accepted implementation plan after code review;
it does not expand A1 authority.

## Finding dispositions

### A1-R-01 — accepted as recommended

Well-framed supported identity output whose prefix is a recorded strict
ancestor is a repository-class change:
`not-primary-repository` / `repository-class-changed` / `not-retryable`.
`malformed-identity-output` remains reserved for output that cannot be
structurally framed. Permanent coverage must pass a non-empty
`ancestorCandidates` list.

### A1-R-02 — accepted as recommended

POSIX `GIT_CEILING_DIRECTORIES` has no escaping for a literal colon in one
entry. A1 therefore rejects a requested path whose parent contains `:` with
`invalid-path` and fixed evidence reason `ambiguous-git-ceiling`, before any
repository spawn. A colon in the exact repository basename remains supported
when the parent is unambiguous. Permanent proof must exercise Git's actual
no-ascent behavior for a plain nested repository and separately prove
pre-spawn refusal for the ambiguous form.

### A1-R-03 — accepted tighter working-tree scope

No code change is authorized. Postflight continues comparing kind, device,
inode, size, mtime, and canonical resolution for the admitted top-level and
metadata paths. Ordinary creation, deletion, or rename of a top-level
working-tree entry can therefore produce `observation-raced`.

This is an intentional operational constraint for the personal-use
application. A2 registration must run both inspections against a clean,
quiescent working tree. If ordinary activity races an inspection, A2 may retry
only after the activity stops. Prior shorthand describing only
“structural/inode” replacement is superseded by this disposition.

### A1-R-04 — accepted as recommended

Search-path semantics are first-viable, not first executable match. A1 checks
candidates in configured order and selects the first canonical executable
whose version probe succeeds at Git 2.32 or newer. It skips failed, malformed,
or unsupported candidates. If none is viable, it preserves the first
meaningful probe failure. An explicit executable never falls back.

### A1-R-05 — accepted as recommended

Only `undefined` selects a numeric default. Caller-supplied `null`, non-number,
noninteger, or out-of-range bounds return `invalid-options`. Non-string
`gitExecutable` and `executableSearchPath` values also return
`invalid-options` / `policy-configuration` / `configuration-required`.

### A1-R-06 — informational; binding A2 handoff

`A1-PATH-014` is discharged at inspector creation. Coherent root policy rejects
any source/reserved overlap as `invalid-root-policy`; a request beneath a
disjoint reserved root is outside the one admitted source root and returns
`outside-allowed-root`. A2 must not implement logic that expects an
inspect-time `reserved-root-overlap` result.

The conservative inspect-time branch remains in A1 as defense in depth, but it
is not claimed as a reachable production proof under coherent configuration.

### A1-R-07 — informational; binding A2 handoff

The A1 core fingerprint authenticates only the seven versioned core-identity
inputs specified by the accepted plan. Runtime parsing validates, but does not
cryptographically authenticate, `riskScan`, environmental device evidence,
`canonicalGitDirectory`, or `observedAt`.

A2 must protect the integrity of the complete serialized observation in its
storage boundary, including those unhashed fields. Alternatively, any widened
fingerprint must be introduced only through a later independently reviewed
inspection-policy version. A2 must not infer full-record authentication from a
successful `parseRecordedObservation`.

## Scope confirmation

This remediation creates no schema, migration, route, journal entry,
repository ID or state, inspection record, project binding, transaction,
notifier call, or browser behavior. It adds no mutation, remote Git, public
process carrier, or additional process authority. CT-04A2 remains the sole
owner of durable registration and project binding.
