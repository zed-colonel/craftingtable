# CT-04A2b2a code-review disposition

**Status:** All required findings accepted; all observations reconciled

**Date:** 2026-08-12

**Reviewed implementation head:**
`97af775368bcfd3633fea4081651089096eab53a`

**Implementation report commit:**
`87964221e4dd0ce96ca87fcea591c676fdb5d6c3`

**Independent review:**
`review-findings/CT-04/CT-04A2b2a-code-review.md`

**Independent review SHA-256:**
`08c1cb3918c7aedc0c29c7037018481e2c3a0c990898546f630c538e098204b4`

**Amended accepted-plan SHA-256:**
`451429f6acca20a1812c2cd18ad79fd3eaab912a8ebb5ded53334833dc3fe02b`

## 1. Disposition boundary

The operator directed remediation of both changes-required findings and
consistency treatment for all five non-blocking observations. Every item is
accepted. No finding is rejected, downgraded, or deferred.

The accepted plan receives only the O-2/O-4 consistency amendment described
below. Protected specifications, the A2b2 supplement, later-child contracts,
A1 process implementation, storage, routes, browser source, and CT-04B+
behavior remain unchanged.

## 2. Required findings

### F-01 — real A1/domain positive parity proof

**Disposition:** Accepted and remediated.

The adapter test's module replacement now captures the actual package-root A1
error-code array, subject map, and risk-signal array from `importOriginal()`.
Every test reset restores the mutable drift containers from those captured A1
values rather than from domain values. The positive test separately compares
the captured real exports with the domain constants before asserting the
production parity function.

Drift tests continue to mutate only the isolated replacement containers. They
no longer make the positive case tautological.

### F-02 — dead live residual-closure guard

**Disposition:** Accepted and remediated.

The protected checker now owns an explicit declared-closed register containing
the 31 protected IDs closed in A2b2a. The independent residual map retains the
seven B2b IDs and their exact obligations. Live verification checks the union
against all 38 protected IDs and passes the explicit closed register through
the residual-overlap guard.

The permanent test proves the real 31/7 register is complete and then injects
`B2-CFG-002` into the declared-closed input. The same function used by
`check:protected` must reject that premature closure.

## 3. Observation consistency

### O-1 — compare digest/parse ordering

**Disposition:** Adopted.

`compare()` now verifies both exact UTF-8 digests before either JSON parse. The
failure remains a systemic invariant fault, but the execution order now
matches `verifyStored()` and the accepted digest-first discipline.

### O-2 — host-delimiter-bearing source root

**Disposition:** Documentary and proof correction; no parser escape language
introduced.

Repository and search-path lists use `node:path.delimiter`. Because the format
has no escaping rule, a path containing the host delimiter cannot be expressed
as one list entry and fails synchronously. This is stricter than the original
accepted-plan statement that a colon-bearing source root would reach lazy A1
validation.

The accepted plan and operations documentation now state the real behavior.
The config matrix explicitly exercises a delimiter-bearing value. The provider
test title now claims only the configuration-required failure it actually
constructs; inherited A1 tests remain responsible for real missing and
symlinked root policy.

### O-3 — NUL path proof

**Disposition:** Adopted.

The lexical configuration matrix now includes a NUL-containing root, proving
the existing fail-closed implementation rather than relying on source
inspection alone.

### O-4 — per-code operation validity

**Disposition:** Strengthened beyond membership-only validation.

The policy now contains an exhaustive compile-time
`Record<A1RepositoryInspectionErrorCode, readonly A1RepositoryInspectionOperation[]>`.
Runtime normalization requires the actual operation to appear in the exact
code-specific set. Permanent tests generate every accepted code/operation pair
and reject both a known-but-wrong operation and an invented operation.

The accepted plan's phrase “operation validity” is therefore implemented
literally; the initial implementation report remains an immutable description
of the reviewed head's membership-only behavior.

### O-5 — relative traversal into the Git package

**Disposition:** Adopted.

The scope checker resolves relative production imports against the repository
root and rejects any cross-package target inside `packages/git`. Git's own
internal relative imports remain valid, while the sole production server seam
must use the exact package-root specifier. Direct and end-to-end scratch-repo
tests cover a traversal from a server service to the A1 command runner.

## 4. Scope confirmation

This remediation changes only A2b2a server tests/adapter/policy, the two
existing gate pairs, operations documentation, the accepted-plan consistency
text, and this disposition. It adds no route, authorization, audit, event,
notifier, storage mutation, lifecycle command, repository query, binding,
retirement, browser behavior, or CT-04B+ capability.
