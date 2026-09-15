# ADR-042: Staged plan finalization

Status: accepted  
Date: 2026-09-15

## Context

Whole-plan improvement loops mixed correctness with discretionary polish and repeatedly
rediscovered work. Larger plans need bounded scope, independent budgets and durable evidence
without repeating historical reports. Final promotion remains the operator's decision.

## Decision

New finalizations use ordered correctness, conformance, simplification, polish and final-review
stages. Each stage records review/implementation profiles, instructions, scope, check names and
policy. Correctness/conformance may have work-item slices followed by whole-plan cross-boundary
checks. Required findings at any severity and blocking/major findings always require remediation.

Optional minor/nit simplification and polish findings pause discovery for an explicit batch
selection, including an empty selection. Selected findings remain required through focused
verification and recovery; other ideas remain open follow-ups. New required issues reopen the
appropriate whole-plan stage with its original spent allowance, followed by final review.

The controller stores an obligation ledger seeded from imported exit gates. Reviewers add cited
plan-prose obligations and report compact updates by ID. Adopted source and requirement text
cannot change without an attributed operator approval of the exact proposal and fresh review.
Completed-stage evidence may be reused only at identical candidate/destination commits and with
unchanged adopted input and evidence. Final independent review always revalidates every obligation
and runs full repository-required checks. Promotion independently checks this evidence and all
stage completion before accepting the operator's exact-commit approval.

Definitions and progress use optional fields in existing versioned records. Usage, grants,
selections, decisions, evidence and next-run reservations persist atomically. Existing finalizations
and explicit legacy setup retain their prior rounds and nit-deferral behavior.

## Consequences

Operators can budget and choose models by concern, stop optional discovery, inspect the evidence
mapping, approve plan adjustments, and recover from a phone. A stage budget never bypasses a
question, check or required finding. Evidence matching is deliberately conservative; changing a
commit requires fresh verification. Agents still exercise judgment when extracting plan-prose
obligations and reporting verification; the ledger records those claims, not a formal proof.

## Alternatives considered

A larger global budget preserves the discovery loop. Automatically accepting all minor/nit
findings confuses severity with obligation. A general workflow language adds unnecessary scope;
a fixed ordered stage vocabulary with optional slices expresses the needed behavior.
