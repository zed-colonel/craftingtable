# CraftingTable agent guidance

This file is the canonical repository-wide guidance for human and machine contributors.

## Read order

Before changing code, read:

1. the active work contract under `work-items/`;
2. `init/craftingtable-implementation-plan.md` for architectural context;
3. `docs/ui-principles.md` for visual direction;
4. relevant ADRs under `docs/decisions/`.

The active work contract controls scope. The implementation plan supplies context but does not authorize work outside the contract.

## Product boundary

CraftingTable is a local supervisory workbench around existing coding agents. It is not itself a coding agent, general-purpose IDE, workflow platform, hosted SaaS product, browser shell, or Exo Stack runtime.

Features are admitted only when they address immediate development friction. Prefer the smallest design that supports the active acceptance workload.

## Architectural boundaries

- The daemon is authoritative for workflow state and commands.
- The browser is a projection and control surface, never the source of truth.
- Shared wire contracts must be runtime-validated and reusable by server and web.
- Domain types must not depend on HTTP, React, process management, Git, or vendor-agent SDKs.
- Agent backends and Git operations sit behind explicit interfaces.
- Raw vendor events may be retained for diagnostics but must not become the durable domain vocabulary.
- No package may depend on ActionQueue, WorldInterface, Exoskeleton, or other application runtime code.
- Do not introduce a distributed system, plugin framework, generalized workflow language, or cloud deployment architecture.

## Authority and safety

- The browser must never submit arbitrary shell commands.
- The implementation agent must not gain merge authority.
- Repository policy, acceptance criteria, and protected checks are controller-owned concepts.
- Do not add secrets, credentials, tokens, or machine-specific paths to the repository.
- Use argument arrays rather than shell-concatenated commands whenever process execution is eventually introduced.

## Quality expectations

- TypeScript runs in strict mode.
- Public contracts have runtime validation.
- New behavior includes focused tests.
- Tests assert behavior, not implementation trivia.
- Quality commands must be runnable locally without GitHub Actions.
- Avoid premature abstractions. Add interfaces at real authority or dependency boundaries.
- Record material architectural decisions as ADRs.

## Git expectations

For CT-01, do not create or merge branches, rewrite history, or make commits unless the operator explicitly asks. Leave the worktree in a cleanly reviewable state and report changed files, commands run, and unresolved issues.

## Escalation

Stop and ask for direction rather than silently expanding scope when:

- a requirement conflicts with the active work contract;
- a new major dependency or framework is needed beyond the agreed baseline;
- an acceptance gate appears infeasible;
- the requested design would create a future security boundary while pretending to enforce it now;
- completing the work requires implementing CT-02 or later functionality.
