# CT-04A2b2a — Repository feature and evidence boundary

**Status:** Ready for source-specific implementation-plan proposal  
**Parent:** CT-04A2b2  
**Depends on:** accepted CT-04A1, CT-04A2a, CT-04A2b1  
**Risk:** Critical

## 1. Objective

Create the sole production server boundary to `@craftingtable/git`, optional-but-strict repository feature configuration, exact stored-observation verification, and deterministic translation from A1 observations/errors to the accepted A2a assessment vocabulary.

A2b2a introduces no repository lifecycle route, audit row, workspace event, notifier call, or repository-state mutation.

## 2. Required outcomes

- extend server configuration with an explicit optional repository-feature group;
- preserve daemon startup and all CT-01 through CT-03 behavior when the group is absent;
- fail startup for partial or malformed explicit configuration;
- implement one lazy, concurrency-safe inspector provider;
- memoize success and apply an explicit bounded retry/cache policy to creation failures;
- implement one exact production adapter importing `@craftingtable/git`;
- verify A1/domain vocabulary, version, pattern, error-subject, and difference parity;
- verify exact stored JSON bytes and digest before A1 parsing;
- compare parsed observation fields against every accepted A2a projected field;
- add explicit `repository-class-changed` assessment and reducer handling;
- map successful and failed A1 results into typed assessments without state mutation;
- preserve all comparison arrays under deterministic priority: class/core, environment, risk, same;
- expose no A1 raw types, paths, stderr, or feature configuration through HTTP;
- keep `@craftingtable/git` absent from all other production packages;
- record ADR/documentation for feature configuration and evidence translation.

## 3. Suggested internal boundaries

```text
RepositoryFeatureConfig
    parse and validate explicit optional configuration

RepositoryInspectorProvider
    disabled | available | unavailable
    lazy, memoized, one in-flight creation

RepositoryObservationAdapter
    sole production A1 import
    inspect path
    parse and verify stored evidence
    compare observations
    map failures/assessments

VerifiedStoredRepositoryObservation
    opaque server-internal result proving digest, A1 parse,
    and projected-column parity
```

The accepted plan may refine names. It must preserve the authority separation.

## 4. Binding decisions

### Configuration

```text
no repository variables
    feature disabled; daemon starts

any repository variable but missing roots or inconsistent group
    startup error

complete structurally valid group
    store immutable options; create A1 lazily after authorization in a later child
```

The default artifact/worktree reserved roots may derive from `dataDir`; they are reserved path policy only and are not created here.

### Provider cache

- concurrent first-use calls share one creation promise;
- a successful inspector is memoized for process lifetime;
- non-retryable/configuration-required creation failure is cached until restart;
- retryable creation failure is cached for a bounded interval stated in the accepted plan;
- the provider never silently converts an explicit failure into disabled state.

### Stored evidence

Verification order:

```text
load exact stored string and digest
recompute digest
JSON.parse
A1 parseRecordedObservation
compare all projected fields with parsed observation
verify A1/domain semantic parity
return opaque verified observation or typed storage-integrity failure
```

### Assessment priority

```text
A1 repository-class error subject → repository-class-changed
successful core differences        → core-identity-changed
else environment differences       → environment-evidence-changed
else risk differences              → risk-evidence-changed
else                                → same
operational failures               → unavailable or no-state-change by exact code policy
stored evidence failure            → evidence-invalid
```

`observation-raced`, timeout, overflow, spawn failure, abort, and malformed output do not become structural mismatch.

## 5. Required source correction

The current domain has status reason `repository-class-changed` but no `RepositoryObservationAssessment` variant. A2b2a must add the explicit variant, validation, reducer transition, and property tests.

## 6. Non-goals

- no service authorization;
- no registration, inspection, or reaffirmation command;
- no routes;
- no audit or workspace events;
- no notifier;
- no storage mutation;
- no retirement or project binding;
- no browser view;
- no Git mutation or CT-04B behavior.

## 7. Exit gate

```text
planning-only daemon starts with feature disabled;
malformed explicit configuration fails;
one exact adapter owns the A1 import;
stored evidence cannot be used unless exact bytes, digest, parser,
and projected columns agree;
repository-class failures map explicitly;
operational failures remain non-identity judgments;
no lifecycle state or journal is mutated;
all A2b2a protected cases and CT-01..B1 regressions pass.
```
