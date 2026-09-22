# ADR-064: Agent selection is operational delegation

- Status: accepted
- Date: 2026-09-22

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
