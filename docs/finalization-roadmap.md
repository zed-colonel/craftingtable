# Finalization stages — next before WorldInterface and Exoskeleton

Status: implemented. New finalizations default to focused stages; existing finalizations and
an explicit legacy setup option preserve the earlier flow. Ready for WorldInterface and
Exoskeleton finalization. See [ADR-042](decisions/042-staged-plan-finalization.md).

AQ's seven remediation rounds demonstrated that an unrestricted whole-plan improvement
review can keep discovering optional work after the release requirements are satisfied.
Separate discovering improvements from verifying a selected batch. Preserve manual control
and the operator's exclusive final promotion decision.

| Stage | Scope | Exit condition |
| --- | --- | --- |
| Correctness | Invariants, failure paths, regressions and interactions | Required checks pass and correctness findings are addressed |
| Conformance | Each adopted plan obligation mapped to implementation and evidence | Every obligation accounted for; gaps resolved or plan changes explicitly approved |
| Simplification | Identify and select worthwhile reductions in complexity | Selected batch implemented and verified; other optional ideas retained as follow-up |
| Polish | Diagnostics, documentation, usability and consistency | Selected improvements complete; remaining optional work explicitly recorded |
| Final independent review | Whole-candidate correctness, conformance and regression assessment | Current evidence supports an explicit operator decision on the exact source and destination commits |

Each stage needs its own instructions, review/implementation profiles, remediation budget
and stopping rule. Larger applications may divide correctness/conformance by subsystem or
contract boundary, followed by checks across those boundaries. Finding category and severity
are separate: an apparent simplification may uncover a real correctness issue.

Verification of a selected batch does not reopen unrestricted improvement discovery. New
correctness/conformance issues and regressions must still be reported and can reopen the
relevant stage. New discretionary suggestions become visible follow-up work. Finding IDs,
reviewer dispositions and operator deferrals remain distinct and auditable; a deferred finding
is not a resolved finding. Split bundled findings into individually actionable concerns.

Keep a durable plan-to-evidence mapping. Later changes revalidate affected obligations;
previous stage completion is never proof that later edits are correct. Reuse only complete
verification with matching commits and relevant inputs. Final independent review covers the
whole resulting candidate with the required full checks. Required checks and genuine operator
questions cannot be waived by a stage budget or a nit allowance.

The implementation includes focused briefs and per-stage profiles, progression, budgets,
optional correctness/conformance work-item slices followed by whole-plan checks, and conservative
obligation-evidence reuse. The ledger starts with imported exit gates; reviewers add cited plan
obligations. Existing obligation reports carry compact ID/status/evidence updates. Proposed
requirement replacements need an explicit operator decision and subsequent verification.
Evidence reuse requires a completed stage at the same candidate/destination commits with
unchanged source, requirement and evidence; final review always revalidates every obligation.
No selective reuse across changed commits is attempted. Keep the current import and
manual workflows usable. Present the current stage, selected batch, remaining findings and
next decision clearly on mobile. No stage or roadmap setting authorizes promotion to main.
