# CT-04A2b — Authorized repository lifecycle, journal, and projection

**Status:** Preliminary child contract; source-specific planning deferred until A2a acceptance  
**Parent:** CT-04A2  
**Depends on:** accepted CT-04A1 and accepted CT-04A2a  
**Risk:** Critical  
**Primary areas:** optional feature configuration, A1 adapter, authorization, registration/inspection/reaffirmation/retirement/binding commands, migration 0004 journal rebuild, routes, audit/events, notifier, event projection

## 1. Objective

Compose the accepted A1 observer and A2a persistence model into one authenticated, durable, non-mutating repository-registration lifecycle.

A2b owns the only production translation from A1 result types into A2 domain assessments. It may not recreate A1 process authority.

## 2. Required outcomes

- optional but strict repository-feature configuration;
- lazy/memoized A1 inspector creation after authorization;
- Owner-only double-inspection registration;
- exact serialized observation integrity verification on read;
- explicit A1 error-code mapping;
- reinspection with immutable evidence and state transitions;
- Owner environmental-evidence reaffirmation against a fresh observation;
- Owner retirement and Owner/Editor binding retirement;
- same-workspace project binding after fresh verification;
- migration `0004-ct04a2b-repository-journal.sql` rebuilding `workspace_events` with structural repository/inspection/binding correlations;
- audit/event catalogs, transactions, notifier ordering, route inventory, strict HTTP contracts;
- exhaustive storage event mapping, browser projection invalidation, and activity rendering;
- full A1+A2 parent integration and protected-suite execution.

## 3. Binding behavioral rules

- Registration authorizes before any A1 creation or inspection.
- Registration requires two complete successful inspections and equality across core, environment, and risk evidence.
- `observation-raced` is a retryable failure, not `unavailable`.
- Reinspection failure mutates status only for the exact code classes defined by the parent.
- Every explicit inspect appends evidence and audit; unchanged success emits no event.
- Risk-only change emits `repository-evidence-changed` without a repository status/version transition.
- Reaffirmation requires Owner, expected repository version, expected latest inspection ID, and a fresh core-matching observation.
- Binding requires active status and a fresh successful inspection immediately before the transaction.
- Retirement does not require A1 availability and retires all active bindings atomically.
- Retired rows never reactivate.
- Feature-disabled operation is explicit; the planning daemon still starts.
- Browser changes are limited to exhaustive event handling and invalidation; repository views remain CT-04E.

## 4. A2b further-decomposition check

After A2a is accepted, A2b Phase A must recalculate its scope. It must propose another fan-out if the actual plan still combines an unreviewable schema/journal migration, command service, and browser surface.

A likely optional seam is:

```text
A2b1  server configuration, authorization, services, routes, transactions
A2b2  journal rebuild, event mapper, projection, activity, parent fan-in
```

This is not mandated before A2a source exists.

## 5. A2b non-goals

No repository mutation, change request, branch, worktree, diff, artifact store, agent execution, verification, review, readiness, merge, remote Git, or LAN deployment.
