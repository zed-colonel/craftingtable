# CT-04 planning, review, and remediation protocol

## 1. Purpose

CT-04 is the first CraftingTable milestone to adopt a stricter delegated-development protocol based on CT-03 evidence. The goal is not ceremony. The goal is to expose incorrect assumptions while they are still cheap.

## 2. Roles

```text
Normative contract
    model-neutral; defines scope, invariants, acceptance, non-goals

Primary implementer
    Codex; owns source-specific design and implementation continuity

Independent design reviewer
    fresh Claude Code session; read-only; critiques plan before code

Independent code reviewer
    fresh Claude Code session; read-only; reviews exact immutable head

Operator
    approves plans, accepts/rejects findings, authorizes merges
```

The same vendor/model family may be substituted by the operator, but planning/implementation and required review must not be the same live session.

## 3. Slice lifecycle

Every slice follows this state machine:

```text
ContractReady
    ↓
ImplementerPlanProposed
    ↓
IndependentDesignReview
    ↓
FindingsAdjudicated
    ↓
AcceptedImplementationPlan
    ↓
ImplementationGeneration
    ↓
DeterministicVerification
    ↓
ExactHeadCodeReview
    ├── no blocking findings → Accepted
    └── accepted findings → RemediationGeneration
                                ↓
                         verification + re-review
```

A slice is not allowed to begin code before its accepted implementation plan is committed.

## 4. Phase A requirements

The implementer's read-only plan must include:

1. exact current source map;
2. target file tree;
3. domain records and state transitions;
4. database tables, constraints, triggers, and migration ordering;
5. typed Git subcommands and argument construction;
6. HTTP contracts and authorization;
7. event/audit vocabulary;
8. failure and crash points;
9. adversarial matrix coverage by test file;
10. protected acceptance IDs mapped to tests;
11. explicit non-goals;
12. predicted files/subsystems and rough change size;
13. decisions requiring operator confirmation.

If the plan predicts more than roughly 60 changed files, more than one new authority boundary, or both a major schema and substantial browser surface, it must propose an additional split.

The threshold is a review trigger, not an invitation to game file counts.

## 5. Independent design review

The design reviewer receives:

```text
parent and slice contracts
source assessment and guidance
proposed implementation plan
adversarial and acceptance matrices
current source
```

The reviewer does not receive the implementer's full conversation.

The design review must look for:

- missing analogous relationships;
- incomplete ownership or immutability matrices;
- ambiguous authority or user-controlled paths;
- unsafe Git command/config behavior;
- unmodeled crash windows;
- lost-wakeup or notifier ordering errors;
- incomplete browser temporal identity handling;
- scope that should be split;
- tests that prove examples but not invariants.

Findings are structured:

```text
ID
severity
claim
evidence
violated invariant
required design disposition
suggested adversarial case
```

The operator decides which findings are accepted. The implementer records each disposition before producing the accepted plan.

## 6. Protected acceptance specifications

The package includes a read-only protected specification. It is not secret. Its independence comes from authority separation.

The implementation agent may:

- read the cases;
- add implementation tests that satisfy them;
- report a contract conflict.

It may not:

- change expected outcomes;
- remove cases;
- weaken limits;
- relabel a required case as optional;
- change the baseline checksum.

The operator or independent verifier confirms the file hash before accepting a slice.

## 7. Implementation generation

The implementer works only within the accepted slice plan. A material need to change scope produces an escalation before code continues.

The implementation agent must not:

- edit protected specifications;
- silently change a previously accepted ADR;
- add next-slice behavior;
- rewrite CT-03 history;
- claim tests that were not run;
- create a completion report with a guessed head SHA.

## 8. Exact-head verification

Before review:

```text
run pnpm check
run slice-specific real-Git acceptance suite
run protected acceptance harness or documented probes
inspect git status
create one implementation commit
record exact base and head SHAs
amend or add completion record using the real head
```

Every review finding cites that head. Any remediation commit invalidates the prior verdict.

## 9. Code-review expectations

The reviewer must inspect both implementation and tests. A green suite is evidence, not proof.

For every important invariant, the reviewer should ask:

```text
What is the positive case?
What is the cross-workspace case?
What is the same-workspace/wrong-parent case?
What is the NULL/optional-dimension case?
What happens before, during, and after a crash?
What happens if the browser changes route while the request is pending?
What happens if output is malformed, oversized, or encoded unexpectedly?
What does a direct SQL or filesystem mutation attempt do?
```

The reviewer may run additional temporary probes without committing them. A valuable probe should be proposed for permanent inclusion.

## 10. Remediation invariant-closure report

For every accepted finding, the implementer must write:

```text
Finding ID
Generalized invariant
Root cause
Analogous surfaces inspected
Repair
Positive tests
Negative/adversarial tests
Why the defect class is closed
Remaining limitations
New exact head SHA
```

A line-level patch without analogous-surface analysis is incomplete.

## 11. Repeated finding policy

If the same invariant class survives two remediation generations:

```text
stop implementation
mark slice Escalated
discard any assumption that the patch is nearly complete
re-open the design at the invariant level
consider splitting the slice further
```

The maximum of three remediation generations remains a hard ceiling, not a target.

## 12. Merge policy

Only Keith merges a slice into `ct-04`.

Required evidence:

```text
accepted implementation plan
independent design review and dispositions
completion report with exact head
full deterministic gate
protected acceptance evidence
independent code review
no unresolved blocking/high findings
remediation reviews where applicable
clean worktree
```

The `ct-04` parent branch merges into `main` only after CT-04E and the parent completion review.

## 13. Data to preserve for CraftingTable research

For each slice, record:

```text
implementer model/harness
reviewer model/harness
plan size and predicted scope
actual file and line counts
initial test count
findings by severity and invariant class
remediation count
repeated findings
human interventions
elapsed and inference usage where available
accepted head
```

This is empirical input for CraftingTable's future delegation and planning workflows.
