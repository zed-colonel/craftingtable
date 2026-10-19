# ADR-064: Agent selection is operational delegation

- **Status:** accepted
- **Date:** 2026-09-22
- **Amended:** 2026-09-28 (R-G5 follow-up): reasoning effort for Claude profiles too; 2026-10-18 (R-C17 part 4): a stopped cycle's own settings change, and the delegated resolver's rank

## Context

Model availability and usage allowances change during long roadmaps. Editing model choices
inside a saved plan definition expires acceptance evidence and cannot reach future steps of
already-started cycles. Reusing the latest model choice to validate historical reviews would
also invalidate otherwise sound evidence.

## Decision

Keep four workspace defaults, optional specialist selections, and Codex reasoning effort.
Remediation defaults to implementation for legacy workspaces; specialists inherit documented
base selections. Preserve the original step's permissions regardless of specialist model.

Applying models to named entries of a draft, paused or needs-attention roadmap appends an
operational assignment with actor, time and ID under the existing roadmap version guard.
The payload cannot edit permissions or other planning authority. The saved definition and
its acceptance fingerprint are unchanged. New launches resolve the latest assignment,
including recovery and repair steps, and persist the requested selection, purpose and
assignment ID on the run. Review evidence validates against that launch assignment. Explicit
recovery choices and finalization's stage/recovery profiles retain their own precedence.
Running sessions are never reconfigured, and applying profiles never resumes scheduling.

## Consequences

Operators can switch future models without changing decisions, dependency pins, budgets or
accepted evidence. Original definitions and runs remain auditable. Workspace defaults and
existing-roadmap assignments require distinct UI actions. Specialist model choices do not
weaken reviewer responsibilities or confer merge authority. Finalization keeps its stage
profiles. Additive migration preserves legacy rows and absent effort uses local Codex defaults.

## Alternatives considered

Rewriting cycle profiles loses launch history; rewriting the plan forces unnecessary acceptance
work. Resolving every launch against mutable workspace defaults silently changes existing
roadmap delegation. Neither is used.

## Amendment 2026-09-28: reasoning effort for Claude profiles too (R-G5 follow-up)

Operator decision. Claude profiles, specialist selections, roadmap assignments and launches may
carry a reasoning effort, as Codex ones do. The Claude adapter passes it as `--effort`. It uses the
same four levels; Claude's `max` is not offered. Since R-G5, Claude runs load no operator
settings, so an unset effort on a Claude profile means Claude Code's own default, not the
operator's `effortLevel`. An unset Codex effort still uses the local Codex configuration.
Records written with a Claude effort cannot be read by a release before this amendment.

## Amendment 2026-10-18: a stopped cycle's own settings change (R-C17 part 4)

Operator decisions 5 and 7. A paused or stopped-for-attention work item cycle's agents can be
changed from the cycle itself, without resuming or stopping it. For a cycle a roadmap owns, the
change is an assignment as above, naming that cycle's entry only (so the entry's later cycles in
the roadmap take it too), with every step's current agent and the changed ones; it may be appended while the roadmap runs (the entry's cycle is stopped for
the operator and launches nothing until resumed), not while a roadmap command runs or an
amendment is pending. Review evidence validates against it as against any assignment, and a later
assignment displaces it. For a cycle no roadmap owns, the change rewrites the cycle's profile
selections, each step keeping its permissions: the launch history the Alternatives above protect
is kept by each run's recorded selection and by the audit row of the change, which records every
changed agent before and after.

A delegated or automation conflict resolver keeps its rank (operator decision, 2026-10-18, from
R-C17 part 4's increment 3 review HIGH-1): an assignment's inherited slots (the `remediate` that
conflict inherits) no longer displace the roadmap's delegated or automation resolution profile,
its permissions included; only an assignment that names `conflict` itself does. Before, applying
any agent change to an entry with a delegated resolver silently switched its conflict resolution
to the assignment's remediation agent with the remediation step's permissions. This holds for the
roadmap's own assignments and for a cycle's settings change alike.
