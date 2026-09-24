# ADR-019 — Optional repository feature and evidence translation

- **Status:** superseded (2026-09-23, register item R-B8): the optional feature and its configuration were removed; its environment variables are ignored
- **Date:** 2026-08-11

## Context

CT-04A1 established the trusted local Git inspection boundary and CT-04A2a
established repository and immutable inspection persistence. CT-04A2b2a needs
one internal seam between those packages so later repository services can use
verified observations without receiving process authority, raw A1 result
types, or a second implementation of evidence hashing and serialization.

The Git package intentionally does not export its runtime error category and
retryability lookup. Repository persistence also repeats nine identity and
classification projections from the stored observation. The server therefore
needs a narrow translation boundary that validates both vocabularies and every
stored projection before domain policy can use them.

## Decision

The repository feature is absent-or-complete optional configuration. Its
twelve environment variables declare source, artifact, and worktree roots;
Git executable resolution; and inspection limits. No variable present means
the feature is disabled. Any variable present makes the whole group explicit,
requiring complete valid roots and either an explicit Git binary or search
path. Startup performs only lexical path and numeric validation. Filesystem and
Git validation remain lazy A1 work.

A server-owned provider has disabled, idle, creating, available, cooldown, and
permanent-failure states. Concurrent first use shares one creation promise,
success is memoized, retryable creation failures use a fixed cooldown, and
configuration, non-retryable, or invariant failures latch until process
restart.

Exactly one production server file,
`services/repository-observation-adapter.ts`, imports `@craftingtable/git`.
Later services receive only the server-owned observation port. The port chains
inspection, stored-evidence verification, registered-identity verification,
and comparison types so a caller cannot skip an evidence boundary. It exposes
no subprocess runner, inspector, executable resolver, raw A1 result, or
command authority.

The Git package re-exports `calculateCoreIdentityFingerprint`. The adapter uses
the storage serializer and digest implementation for persisted evidence. It
verifies stored evidence in this order:

1. recompute and compare the exact evidence digest;
2. parse JSON and validate it with the A1 observation contract;
3. compare all sixteen stored inspection projections with the parsed
   observation;
4. compare all nine registered-repository projections with that same verified
   observation.

Comparison delegates policy-version comparability to
`compareRepositoryObservations`; the adapter does not preempt that policy.
Before applying the exhaustive A1-error assessment table, the adapter checks
the actual code, subject, category, operation, and retryability tuple against
A1's runtime error. Systemic and operational failures do not synthesize a
repository assessment or imply a state change.

## Consequences

Planning and authentication startup remain unchanged when repository
configuration is absent. B2b can acquire a repository observation port only
after its own authorization checks, while raw process authority remains
confined to A1 and the adapter.

Stored evidence is accepted only when its digest, parsed contract, inspection
projections, and registered identity projections agree. Any server/A1
vocabulary drift or impossible evidence mismatch permanently disables the
provider for the current process rather than continuing with ambiguous state.

This decision adds no repository lifecycle service, route, audit row, event,
notifier, storage mutation, binding, retirement, browser behavior, or CT-04B+
behavior.

## Alternatives considered

- Duplicate Git fingerprinting, evidence serialization, or digest logic in the
  server — rejected because it would create competing authorities.
- Export the full A1 inspector or process runner through the server port —
  rejected because later services must not receive process authority.
- Pre-reject policy versions in the adapter — rejected because the A1
  comparator owns observation comparability.
- Validate repository paths and Git eagerly at startup — rejected because the
  optional feature must not change existing planning or authentication
  startup behavior.

## Related decisions

- [ADR-016 — Trusted local Git inspection boundary](ADR-016-trusted-local-git-inspection-boundary.md)
- [ADR-017 — Repository evidence and persistence](ADR-017-repository-evidence-and-persistence.md)
- [ADR-018 — Repository journal correlation](ADR-018-repository-journal-correlation.md)
