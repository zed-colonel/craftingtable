# AQ-CONT-1 Development Planning Package

Read in this order:

1. `actionqueue-hardening-implementation-ready.md` — normative architecture and invariants.
2. `aq-cont-1-implementation-plan.md` — repository-level delivery plan and 14-PR critical path.
3. `aq-cont-1-work-breakdown.yaml` — machine-readable PR dependencies, risks, and exit gates.
4. `constitutional-stack-implementation-contracts.yaml` — canonical cross-stack ownership and handoff rules.
5. `aq-cont-1-implementation-plan.sha256` — checksums for the plan and work breakdown.

The implementation posture is a pre-production clean break. Existing ActionQueue source and fixtures are evidence, not a compatibility obligation. The active target runtime contains one authority path and no pre-AQ-CONT-1 store reader.
