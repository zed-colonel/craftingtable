# CraftingTable agent guidance

This file is the canonical repository-wide guidance for human and machine contributors.

## What CraftingTable is for

CraftingTable is a local supervisory workbench around existing coding agents. Its owner
uses it to plan and ideate software, delegate the work to agents, and watch that work in
a dynamic, clear, transparent way from another machine on the home network. It runs as
a daemon on the workstation; the browser on a laptop is a projection and control
surface.

The product is judged by whether it is usable for real development today, not by the
completeness of its design. Prefer a working end-to-end path over a polished partial
one. Build vertical slices that can be used immediately, then improve what actual use
shows to be wrong.

## Read order

Before changing code, read:

1. `README.md` for the current state and how to run the app;
2. `docs/architecture.md` for the package layout and dependency direction;
3. `docs/security.md` for the trust model;
4. relevant ADRs under `docs/decisions/`;
5. `docs/ui-principles.md` when touching the browser app.

`init/` holds the original product planning package. Treat it as background on intent
and vocabulary, not as authority: where it conflicts with this file, the README, or the
code, the code wins. `archive/` holds superseded planning and review artifacts and is
never required reading.

## Working method

- Understand the request, inspect the code that it touches, then build. Do not
  produce planning documents, work contracts, acceptance matrices, or review
  dispositions; a short ADR is the only design document this repository wants, and
  only when a decision is material and hard to reverse.
- The one artifact exception is the UI walkthrough: dated screenshot captures of every
  page of the browser app, produced by `pnpm ui:walkthrough`. They record how the UI
  looked at a commit so later UI work can be compared against earlier versions. Capture
  a new version before and after any UI change that alters page structure; never edit a
  captured version by hand. The images are written to a store outside the repository
  (see `docs/ui-walkthrough/README.md`) and must never be committed; commit only the row
  the harness appends to `docs/ui-walkthrough/INDEX.md`. The captures describe, they do not
  prescribe: the code and `docs/ui-principles.md` remain the authority.
- Keep changes coherent and self-describing. A different agent should be able to
  understand a change from the diff, the tests, and the commit message alone.
  Conversation context is not a deliverable.
- When a question would materially change the work, ask. Otherwise make the routine
  call yourself and note it in the report.

## Architectural boundaries

- The daemon is authoritative for workflow state and commands.
- The browser is a projection and control surface, never the source of truth.
- Shared wire contracts must be runtime-validated and reusable by server and web.
- Domain types must not depend on HTTP, React, process management, Git, or vendor-agent SDKs.
- Agent backends and Git operations sit behind explicit interfaces. The first backend
  is Claude Code; the interface must let Codex and others be added without changing
  the daemon's durable vocabulary.
- Raw vendor events may be retained for diagnostics but must not become the durable domain vocabulary.
- The iterative development loop (design, implement, review, remediate, verify) must be
  expressible as composable steps that CraftingTable can orchestrate. The first working
  version need not automate that loop, but new run and event types should not preclude it.
- No package may depend on ActionQueue, WorldInterface, Exoskeleton, or other application runtime code.
- Do not introduce a distributed system, plugin framework, generalized workflow language, or cloud deployment architecture.

## Authority and safety

- The browser must never submit arbitrary shell commands.
- The implementation agent must not gain merge authority. Merging is a daemon command
  gated on current review evidence. The operator may delegate integration merges through
  a roadmap policy; final promotion into main or another protected destination always
  requires explicit operator approval (ADR-033).
- Repository policy, acceptance criteria, and protected checks are controller-owned concepts.
- Do not add secrets, credentials, tokens, or machine-specific paths to the repository.
- Spawn processes with argument arrays, never shell-concatenated strings, and only from
  the explicit adapter modules that own that authority.
- Keep the authentication, CSRF, origin, and LAN exposure protections intact. The
  target deployment is one workstation daemon reached from a laptop over a home LAN.

## Quality expectations

- TypeScript runs in strict mode.
- Public contracts have runtime validation.
- New behavior includes focused tests that assert behavior, not implementation trivia.
  Test the seams that would be expensive to get wrong: process supervision, event
  persistence and replay, Git mutations, authorization. Do not chase coverage for its
  own sake.
- `pnpm check` must pass before work is called done.
- Avoid premature abstractions. Add interfaces at real authority or dependency boundaries.
- Record material architectural decisions as short ADRs.

## Git expectations

Commit finished increments with clear messages. Do not push, merge into another branch,
or rewrite history unless the operator explicitly asks; merge authority is the
operator's alone. Report changed files, commands run, and unresolved issues.

## Escalation

Stop and ask for direction rather than silently expanding scope when:

- a new major dependency or framework is needed beyond the agreed baseline;
- a requirement would weaken an authority or safety boundary above;
- the requested design would create a future security boundary while pretending to enforce it now.
