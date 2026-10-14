# ADR-075: An accelerator, not a guardian

- **Status:** accepted
- **Date:** 2026-10-14
- **Refines:** the trust model in [security.md](../security.md); revises ADR-074 through R-G19

## Context

The 2026-09 system review and the items built after it treated a coding agent as something that
might be turned against the operator: misled by repository contents or tool output into escaping
its worktree, planting Git state for the operator's own Git to act on, or poisoning a shared cache
so that the daemon's checks run its code. Each defence answered a real route, and each review found
more:

- Claude Code's sandbox could keep a missing Git path read-only only with a placeholder, which made
  Git in the operator's checkout fail while agents ran commands (R-G16).
- Denying Git's in-progress state needed a list that must track Git (R-G16 review M-2). Its own
  review then found replace refs, submodule directories, and placeholders that one Claude run can
  remove under another.
- Python checks needed a daemon-verified wheel store, virtual projects only and no source builds
  (R-G17). A separate Git directory for agents was next (R-G18).

Meanwhile every failure that stopped real work was accidental: checks sharing a build directory, a
missing cache directory, a restart. The agents CraftingTable runs, Claude Code and Codex, carry
their own permission controls and sandboxes, and they stay within the worktree they are given.

## Decision

CraftingTable is an accelerator: it organizes, separates and isolates parallel agent work, so that
one operator can run more of it. It defends against accidents and unverified claims, not against
an agent deliberately working against the operator.

- **Kept, because they guard against mistakes:**
  - each run in its own worktree, which the daemon creates, maintains and removes;
  - each agent's sandbox limiting writes to that worktree, its run directory and the shared caches,
    and its network to the package sources it needs, which also stops an accidental publish;
  - the operator's credentials and the daemon's own files denied to agents;
  - checks run by the daemon on a clean clone of the reviewed commit, with receipts no agent can
    write;
  - merges only through the daemon after review, and final promotion only by the operator;
  - step-up for the commands that grant the most, and authentication, CSRF and origin checks for
    the browser.
- **Not pursued:** containing an agent that works against the operator, beyond what the agent's own
  controls provide. A route only such an agent would take is an accepted risk, recorded in
  `security.md`, not a work item.
- **Existing defences** built under the stricter model stay where they cost nothing: the daemon's
  own Git hygiene and guards, Cargo's verified registry for checks, the root-owned Python
  toolchain. Those that cost friction are relaxed or removed (R-G19).
- **New languages** follow the simpler model: a toolchain entry, a package source for agents, and
  checks that install from the lock with the package manager's own hash checks, then run offline.
  TypeScript is expected to be next.

## Consequences

- R-G16's review finding M-2 (81a7700) is backed out before deployment. Its review's findings
  (replace refs, `modules/`, placeholders one run removes under another) are accepted risks. R-G18
  is withdrawn.
- R-G19 drops the denies of Git names missing at launch, so Git in the primary checkout works while
  agents run commands, and moves Python checks to `uv sync --locked` from PyPI, which supports
  packaged projects and source builds and retires the daemon's wheel store.
- An agent misled into working against the operator can do, within its sandbox, what its sandbox
  allows, and can leave Git state the operator's own Git acts on. Review, the agents' own controls
  and the operator's attention are what stand against that.
