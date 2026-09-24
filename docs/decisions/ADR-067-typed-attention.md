# ADR-067: Typed attention declared by the controller

Status: accepted
Date: 2026-09-23

## Context

At least ten places decided whether something needed the operator, each with its own rules,
and several branched on the wording of human-readable reasons (`startsWith('Daemon
restarted.')`, `'Resource '`, `/needs your input/`). The notification service predicted what
automation would do next by re-running five policy modules, and each new automation needed a
matching suppression clause (review findings CTRL-05, CTRL-10, CTRL-11, NOTIF-02, DATA-05,
UI-02, UI-09, UI-16; register item R-A3).

## Decision

- A stop declares its attention in the write that makes it: a cycle entering
  `needs-attention` or `awaiting-merge`, a roadmap entering `needs-attention`, and a held entry
  carry `{ code, owner }`. The cycle and roadmap write types make a stop without attention a
  compile error; every test daemon also checks the stored rows on cleanup.
- The code vocabulary is closed and lives in the domain package. `awaiting-merge` codes name
  its gate: merge approval, merge requirements, final promotion, scope evidence, controller
  wait, scheduling held.
- The owner follows the code, except while automation claims the stop (a roadmap that merges
  or verifies automatically, conflict automation, scope recovery, prerequisite work). The
  cycle controller records the claim with the transition and refreshes it when stored state
  changes; the refresh is written in place without a version bump, so operator commands that
  hold the version stay valid.
- Phase blockers carry a code, whether the controller waits on it, and who resolves it.
- Reasons and messages are display text. The scope check fails on text matching of a reason
  or message in the daemon or the browser. `attention-legacy.ts` maps text written by
  earlier releases to codes; it is the only such mapping.
- Notifications send operator-owned attention only, and roadmap-level waits as the scheduler
  reports them. The notification service imports no scheduling policy.

## Consequences

- One vocabulary for the inbox (R-A5), action gating (R-A7) and operator-wait metrics (R-C1).
- Stops that automation owns are no longer pushed: roadmap auto-merges, held controller
  reviews (`scheduling-held`), and controller-owned checkpoint waits at the merge boundary
  (`controller-wait`, the CTRL-10 false page). Operator-owned evidence (plan acceptance,
  architecture decisions, dependency environments) now shows as the operator's.
- Messages still contain navigation prose; the inbox will render destinations from codes.

## Alternatives considered

- Derive attention on read from one pure function: keeps a single decider but still predicts
  automation after the fact, and every reader pays for the policy evaluation.
- Persist attention items as rows now (R-A4): the right end state, but it needs the delivery
  log and quiescence design; the typed field is its input.
