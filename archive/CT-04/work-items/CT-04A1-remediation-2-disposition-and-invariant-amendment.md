# CT-04A1 remediation generation 2 disposition and invariant amendment

**Review:** `review-findings/CT-04/CT-04A1-remediation-review.md`
**Invariant specification:** `review-findings/CT-04/CT-04A1-remediation-2-invariant-spec.md`
**Generation-1 head:** `2180ae187edc13ed35482c07f484d910f0265a56`
**Operator adjudication:** 2026-07-27
**Slice:** CT-04A1 — Trusted Git inspection boundary

## Disposition summary

A1-R-08, A1-R-09, and A1-R-10 are accepted. The operator selected an
aggregate creation deadline for A1-R-09 and did not select a candidate cap.
The operator approved the private fixed-command amendment required by
A1-R-10. This document is the binding amendment to the accepted A1 plan for
remediation generation 2.

## A1-R-08 — accepted

Ceiling representability is a source-root policy invariant. An allowed source
root containing the POSIX Git ceiling-list separator `:` fails inspector
creation with
`invalid-root-policy` / `policy-configuration` /
`configuration-required`. The per-request check remains
`invalid-path` / `caller-input` with fixed evidence reason
`ambiguous-git-ceiling` for a colon introduced below a valid source root.

Reserved roots remain valid when they contain `:`. They are never a command
working directory or a `GIT_CEILING_DIRECTORIES` source, so rejecting them
would add an unrelated policy restriction. Existing canonicality,
symlink-freedom, and overlap rules still apply. Permanent tests assert this
choice.

This is fail-fast configuration diagnosis, not a new host-access defense:
the generation-1 per-request refusal was already fail-closed.

## A1-R-09 — accepted with aggregate deadline only

`RepositoryInspectorOptions` gains optional `creationTimeoutMs`.

```text
default: 2 × commandTimeoutMs + 5000
range:   1000..90000 ms inclusive
rule:    creationTimeoutMs >= commandTimeoutMs
```

The aggregate deadline starts after option/platform/UID validation and covers
root-policy resolution, executable-candidate discovery, and all version
probes. Filesystem calls remain cooperatively bounded because Node cannot
preempt a kernel-blocked filesystem syscall. Version subprocess lifetime is
hard-bounded by the earlier of the per-command and aggregate deadlines.
Timeout prevents every later candidate spawn and returns
`timed-out` / `git-boundary-fault` / `retryable`.

No candidate cap is added. Candidate discovery remains ordered and canonical
path deduplication remains mandatory. Time, not candidate count, bounds
creation process work.

The accepted plan section 7.2 sentence “Version runs once at inspector
creation” is superseded. An explicit executable causes exactly one version
probe. Search policy causes at most one version probe per distinct canonical
candidate until the first viable candidate or aggregate deadline. The
per-`inspect()` invariant remains exactly two repository subprocesses after
successful creation.

## A1-R-10 — accepted invariant and private-interface amendment

### Structural invariant

A fixed Git command requiring repository discovery cannot be constructed
without both:

1. a branded canonical working directory; and
2. a branded, representable ceiling derived and validated by the environment
   module that owns `GIT_CEILING_DIRECTORIES` syntax.

`environmentFor` serializes the already-proven ceiling. It does not derive or
validate it. The version variant carries only a branded canonical working
directory because it receives no ceiling.

### Accepted command-union amendment

The accepted plan section 5 private command union is amended to:

```text
version {
  cwd: CanonicalPath
}

identity {
  cwd: CanonicalPath
  ceilingDirectory: GitCeilingDirectory
  expectedTopLevel: CanonicalPath
  expectedGitDirectory: CanonicalPath
  ancestorCandidates: readonly string[]
}

local-risk-signal-names {
  cwd: CanonicalPath
  ceilingDirectory: GitCeilingDirectory
}
```

`CanonicalPath` is minted in production only after root-policy validation or
repository-path admission. `GitCeilingDirectory` is minted only by the
environment module's checked constructor. Neither unsafe mint nor either
brand is re-exported by `packages/git/src/index.ts`; the public export map
remains `"."` only.

### Repeated invariant-class record

The accepted plan specified branded command paths, but the initial
implementation substituted plain strings and relied on runtime admission. The
reason was implementation convenience at a private interface: the runtime
checks appeared sufficient and the structural authority consequence was
missed. That was incorrect. It is the same invariant class as A1-F-07:
a structural boundary was replaced by a value-pattern convention that a
future call site could bypass.

The repair restores the accepted brand and moves ceiling syntax ownership to
the construction module. Tests and scope patterns remain secondary
backstops—not the source of correctness.

## Scope confirmation

The amendment is package-private except for the bounded
`creationTimeoutMs` option. It changes no export map, daemon composition,
schema, migration, durable record, binding, route, contract, audit action,
event, notifier, or browser behavior. It adds no Git mutation, remote access,
arbitrary command carrier, or second process authority.
