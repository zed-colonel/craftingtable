# ADR-007 — Agent execution boundary

- **Status:** deferred
- **Date:** 2026-07-23

## Context

The full backend contract (implementation plan §8.1: start, subscribe, directives, approvals, inspect, cancel; raw-event retention; capability descriptors; process supervision) is a CT-05 concern. Designing it now, before a real adapter exists, would be speculative.

## Decision

Deferred until CT-05. CT-01 commits only to the direction of the seam, already enforced in code:

- `@craftingtable/agents` defines a deliberately narrow `AgentBackend` (`describe()` + `streamEvents(signal)`), and `@craftingtable/git` a narrow `GitService`.
- Implementations live behind these interfaces; the only CT-01 implementations are fakes in `@craftingtable/testing`.
- Normalized envelopes — never raw vendor events — are the domain vocabulary crossing these boundaries.

## Notes for the future decision

CT-05 must decide process supervision, approval flow, raw-event artifact retention, and sandbox/approval policy without letting the browser submit arbitrary commands (AGENTS.md authority rules).
