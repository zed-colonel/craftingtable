# CraftingTable Planning–Implementation Feedback Loop Addendum

**Status:** architectural addendum  
**Applies to:** `init/craftingtable-implementation-plan.md`, especially the Planning Studio seam and CT-12/CT-13  
**Reference case:** CT-04A design review and recursive decomposition into CT-04A1/CT-04A2  
**Purpose:** preserve the principle that planning remains active, versioned, and authoritative throughout implementation  
**Authority:** supplements the implementation plan; where this document is more specific about planning feedback, recursive decomposition, or plan lineage, this document controls

---

## 0. Decision summary

CraftingTable must not model planning as a one-way prelude to implementation:

```text
plan
    → implement
    → review
    → finish
```

Real source inspection and implementation frequently reveal facts that were not available when the original plan was written. A work item may be too broad, depend on an undiscovered prerequisite, cross more authority or persistence boundaries than expected, require a different order, or contain acceptance criteria that do not adequately prove its governing invariants.

CraftingTable therefore adopts a bidirectional model:

```text
intent and architecture
    ↓
normative plan
    ↓
work-contract decomposition
    ↓
source-specific implementation planning
    ↓
independent design review
    ↓
operator disposition
    ↓
accepted implementation plan
    ↓
implementation and verification
    ↓
source-grounded evidence and planning feedback
    ↓
plan amendment, recursive decomposition, resequencing,
risk reclassification, clarification, or abandonment
    ↓
new accepted plan or work graph
```

The governing principle is:

> **Planning is not merely a prelude to implementation. It is an ongoing, versioned control process that receives evidence from implementation and may recursively refine the work graph without surrendering planning authority to the worker.**

The governing invariant is:

> **Every accepted work item may fan out when source-grounded planning or implementation evidence reveals a safer or more coherent decomposition. Fan-out requires an explicit proposal, independent review where warranted, operator disposition, and a versioned graph transition.**

This does not make plans weak or optional. It separates two properties that must coexist:

```text
Plan authority
    A worker cannot redefine the assignment, acceptance criteria,
    dependency graph, or permitted scope unilaterally.

Plan adaptability
    New evidence can cause the assignment and work graph to be
    revised through an explicit governed process.
```

---

## 1. Why this addendum exists

The original CraftingTable plan correctly establishes that the Planning Studio produces proposals for human approval and must not silently create executable work. It also defines a staged planning pipeline, independent critique, reconciliation, structured artifacts, and deterministic validation.

The CT-04A planning cycle exposed a further requirement.

CT-04A began as one coherent parent contract. Source-specific planning then revealed that the work combined two independently reviewable assurance domains:

```text
trusted Git/process/filesystem inspection
    +
durable multi-tenant repository registration,
journaling, binding, and browser projection
```

The implementation proposal crossed the process split threshold. Independent review recommended decomposition. The operator accepted that recommendation with modification, preserving CT-04A as the parent objective while introducing dependency-ordered child slices:

```text
CT-04A
├── CT-04A1 — Trusted Git inspection boundary
└── CT-04A2 — Repository registry and project binding
```

This is not exceptional behavior to handle manually forever. It is a general planning property.

A work item that looked implementation-sized at one level of abstraction may reveal additional structure only after:

- the repository is inspected;
- current seams are mapped;
- persistence relationships are enumerated;
- authority boundaries are identified;
- adversarial proof obligations are compiled;
- the actual target file tree is predicted;
- independent design review challenges assumptions;
- implementation encounters source facts that contradict the accepted plan.

The future Planning Suite must preserve and govern that back-and-forth.

---

## 2. Planning levels

CraftingTable must distinguish several planning artifacts that serve different purposes and have different authority.

### 2.1 Strategic or normative plan

The normative plan establishes:

- the desired outcome;
- architectural direction;
- governing invariants;
- major dependencies;
- prohibited scope;
- risk posture;
- broad acceptance conditions.

It answers:

> What must become true, and what architectural rules must remain true while we make it so?

A normative milestone may remain valid even when its implementation decomposition changes.

Example:

```text
CT-04A
    Establish a trusted local Git boundary and durable repository
    registration suitable for later change-request and worktree work.
```

### 2.2 Work-contract decomposition

A decomposition translates a normative milestone into bounded implementation units.

```text
CT-04A
├── CT-04A1
└── CT-04A2
```

Each child has:

- a narrow objective;
- inherited parent invariants;
- additional local constraints;
- explicit dependencies;
- allocated acceptance obligations;
- a declared non-goal boundary;
- its own source-specific planning and review lifecycle.

A decomposition is a planning decision, not an implementation convenience.

### 2.3 Source-specific implementation plan proposal

The implementation agent produces this after inspecting the exact checkout.

It identifies:

- source baseline and checkout state;
- current seams;
- exact packages, modules, files, and interfaces;
- persistence and migration changes;
- process or authority boundaries;
- expected change volume;
- test and fixture placement;
- adversarial matrices;
- assumptions and unresolved decisions;
- likely downstream consequences.

This artifact is a proposal. It does not authorize source changes.

### 2.4 Independent design review

A fresh reviewer evaluates the proposed implementation plan against:

- the binding contract;
- actual repository source;
- protected acceptance requirements;
- architectural boundaries;
- security and recovery properties;
- scope and decomposition thresholds;
- inherited decisions and prior defect classes.

The reviewer may propose:

- corrections;
- new proof obligations;
- alternative seams;
- a further split;
- a prerequisite;
- a risk reclassification;
- a contract amendment;
- rejection of the proposed approach.

The reviewer does not approve its own findings.

### 2.5 Operator disposition

The operator adjudicates every material design-review finding:

```text
Accepted
Accepted with modification
Rejected
Escalated
```

The disposition records:

- the decision;
- rationale;
- required plan changes;
- affected sections;
- required proof cases;
- residual limitations;
- whether implementation remains blocked.

No design-review finding silently disappears between review and implementation.

### 2.6 Accepted implementation plan

The implementer reconciles the operator disposition into one source-specific plan.

The accepted plan must include a traceability appendix:

```text
review finding
    → operator disposition
    → accepted-plan section
    → proof cases
```

Implementation begins only after the operator approves this plan.

### 2.7 Implementation evidence

Implementation produces facts that may confirm or invalidate the plan:

- actual file and line volume;
- new source dependencies;
- newly discovered authority boundaries;
- migration limitations;
- hidden coupling;
- test failures;
- review findings;
- repeated remediation failures;
- host or tool constraints;
- source behavior inconsistent with prior assumptions.

These facts may remain inside the implementation loop or may require a return to planning.

---

## 3. Recursive decomposition

### 3.1 Fan-out is a normal planning operation

Any work item may be decomposed when source-grounded evidence shows that a child structure would be safer, clearer, or easier to verify.

There is no fixed depth:

```text
CT-04A
├── CT-04A1
└── CT-04A2
    ├── CT-04A2a
    └── CT-04A2b
```

Recursive decomposition is not evidence that the original objective was wrong. It often means the implementation structure became visible only after the right source inspection.

### 3.2 Parent identity remains stable

A parent work item remains the durable identity for its objective.

Fan-out creates child work items; it does not rewrite history to pretend the parent was always decomposed that way.

```text
Plan version 1
    CT-04A is one proposed implementation slice.

Design review
    F-17 recommends decomposition.

Operator disposition
    recommendation accepted with modification.

Plan version 2
    CT-04A remains the parent milestone.
    CT-04A1 and CT-04A2 become its implementation children.
```

The prior plan version remains queryable.

### 3.3 Parent constraints flow downward

Children inherit all applicable parent constraints.

A child may introduce stricter constraints. It may not silently weaken the parent.

Example:

```text
Parent CT-04A invariants
    no arbitrary process execution
    no remote Git access
    workspace isolation
    no protected-test modification
    no CT-05 agent execution

CT-04A1 additional constraint
    no SQLite, HTTP routes, or workspace journal

CT-04A2 additional constraint
    no child-process imports or raw Git parsing
```

A child may escape an inherited constraint only through an explicit parent-contract amendment.

### 3.4 Acceptance obligations must be allocated

Every parent acceptance obligation must be:

- assigned to one child;
- assigned to several children as a composed proof;
- retained as a parent integration gate;
- explicitly superseded by an operator-approved amendment.

The parent cannot complete merely because all children report success.

Parent completion requires:

```text
all required children complete
    +
all parent integration obligations pass
    +
all cross-child assumptions are reconciled
    +
the composed result satisfies the original normative objective
```

### 3.5 Dependencies must be explicit

A decomposition transition defines child ordering:

```text
CT-04A1
    ↓
CT-04A2
```

or allowed parallelism:

```text
parent
├── child A
├── child B
└── child C

A and B may proceed independently.
C depends on both.
```

The Planning Suite must reject cycles and preserve exact graph revisions.

### 3.6 Suggested split triggers

A split proposal should be considered when a source-specific plan reveals one or more of the following:

- more than one new authority boundary;
- more than one persistence or transaction boundary;
- both a major schema change and substantial browser behavior;
- changes across more than roughly three architectural layers;
- a predicted file or line count beyond the current process threshold;
- multiple independently reviewable security properties;
- a protected acceptance matrix too broad for one coherent review;
- a prerequisite that should be accepted before downstream code depends on it;
- two concerns with different failure modes or rollback strategies;
- repeated review or remediation exposing correlated blind spots;
- a child that cannot be source-grounded until another child is accepted.

Thresholds are review triggers, not arithmetic loopholes. The purpose is to identify coherent assurance boundaries, not to game file counts.

---

## 4. Planning feedback from implementation

Implementation must have a formal return channel to planning.

### 4.1 Feedback categories

A worker or reviewer may produce:

```text
AssumptionInvalidated
HiddenDependencyDiscovered
ScopeEstimateExceeded
AuthorityBoundaryDiscovered
PersistenceBoundaryDiscovered
AcceptanceGapDiscovered
ContractConflict
DecompositionRecommended
ResequencingRecommended
RiskReclassificationRequested
ArchitectureDecisionRequired
PrerequisiteMissing
WorkNoLongerNecessary
WorkSuperseded
```

### 4.2 Minimum feedback record

A planning-feedback record should contain:

```yaml
kind: decomposition-recommended
source_work_item: CT-04A
source_plan_version: 1
source_baseline: <exact commit SHA>

evidence:
  - predicted file tree crossed the split threshold
  - two independently reviewable authority domains were found
  - one child cannot be safely planned until the first is accepted

observed_scope:
  files: 64
  architectural_layers: 5
  authority_boundaries: 2
  persistence_boundaries: 1

proposed_transition:
  parent: CT-04A
  children:
    - id: CT-04A1
      depends_on: []
    - id: CT-04A2
      depends_on: [CT-04A1]

impact:
  parent_acceptance_reallocation_required: true
  downstream_dependencies_changed: false
  risk_change: none
```

### 4.3 Workers propose; planning authority decides

An implementation agent may not:

- create authoritative child work items;
- change dependencies;
- broaden scope;
- relax acceptance criteria;
- replace protected tests;
- reclassify risk;
- mark a prerequisite satisfied;
- adopt a new implementation plan.

It may only submit a structured proposal.

Material planning feedback follows:

```text
worker or reviewer proposes
    ↓
independent analysis where warranted
    ↓
operator disposition
    ↓
versioned plan or graph transition
    ↓
new source-specific planning
```

---

## 5. Implementation loop versus planning loop

Not every problem requires replanning.

### 5.1 Remain inside the implementation loop when

The issue is:

- a code defect;
- a failed test;
- an incomplete error case;
- a missing local fixture;
- a review finding whose remedy fits the accepted design;
- a narrow refactor;
- an incorrect implementation of an already accepted invariant.

```text
implement
    → verify
    → review
    → remediate
    → reverify
```

### 5.2 Return to the planning loop when

The issue is:

- the contract cannot be satisfied without expanding scope;
- source reality contradicts a governing assumption;
- a new authority or persistence boundary appears;
- the slice crosses its decomposition threshold;
- acceptance criteria are incomplete or contradictory;
- implementation would require a new major dependency or framework;
- risk materially changes;
- work must be reordered around a missing prerequisite;
- the same invariant survives repeated remediation;
- the accepted design itself is causing the defect;
- the work should be superseded or abandoned.

```text
implementation evidence
    ↓
PlanningFeedback
    ↓
review and operator disposition
    ↓
plan amendment or decomposition
    ↓
new accepted implementation plan
```

### 5.3 Escalation after repeated remediation

If the same generalized invariant survives two remediation generations, CraftingTable should recommend escalation to planning.

The system should ask:

- Was the defect framed too narrowly?
- Is the accepted plan incomplete?
- Is the implementation slice too broad?
- Is the proof matrix missing analogous states?
- Should the work fan out?
- Does a prerequisite need to be accepted first?

An endless repair loop is not a substitute for revisiting a flawed plan.

---

## 6. Versioned planning lineage

Plans and contracts are immutable historical artifacts.

CraftingTable should eventually model:

```text
Plan
PlanVersion
PlanGraphRevision
WorkItem
WorkItemRevision
WorkItemDependencyRevision
DecompositionProposal
DecompositionDecision
ImplementationPlanProposal
DesignReview
OperatorDisposition
AcceptedImplementationPlan
PlanningFeedback
AcceptanceObligationAllocation
```

### 6.1 Stable identities and immutable revisions

`Plan`, `WorkItem`, and parent objectives have stable identities.

Their formulations change through immutable revisions.

A revision records:

- predecessor revision;
- author or proposing agent;
- source baseline;
- content hash;
- reason for change;
- linked evidence;
- review;
- operator decision;
- resulting dependency graph digest.

### 6.2 No silent mutation

The Planning Suite must not overwrite:

- prior contract wording;
- prior dependencies;
- prior acceptance matrices;
- prior decompositions;
- prior reviewer findings;
- prior operator decisions.

A later revision may supersede an earlier one, but both remain inspectable.

### 6.3 Plan adoption does not make work executable

A plan graph transition may create proposed child work items.

Each child still requires:

- an approved binding contract;
- source-specific planning;
- design review where required;
- operator-approved accepted plan;
- later execution admission.

Fan-out does not automatically start agents, create branches, or authorize code changes.

---

## 7. Roles and separation of responsibility

A mature Planning Suite should support distinct roles:

```text
Strategic planner
    drafts architecture and normative objectives

Decomposer
    proposes work-item boundaries and dependencies

Source reconciler
    tests the plan against actual repositories

Design critic
    identifies hidden coupling, risks, and proof gaps

Operator
    adopts, modifies, rejects, or escalates proposals

Implementer
    executes the accepted plan

Code reviewer
    evaluates an exact implementation generation

Verifier
    runs protected evidence and acceptance gates
```

The same model family may perform more than one role in early use, but these must not become one undifferentiated session with authority to propose, approve, implement, and accept its own work.

Preferred practice:

```text
one implementer retains continuity through remediation
    +
a fresh independent design reviewer
    +
a fresh exact-head code reviewer
    +
human operator disposition
```

---

## 8. Planning Suite user experience

The Planning Suite and implementation surfaces should be connected views over one lifecycle, not separate applications.

### 8.1 Work graph view

The graph should display recursive fan-out:

```text
CT-04
└── CT-04A
    ├── CT-04A1  Accepted plan / Implementing
    └── CT-04A2  Planning blocked on CT-04A1
```

It should distinguish:

- parent milestone;
- implementation child;
- proposed child;
- accepted graph revision;
- blocked dependency;
- parent integration gate;
- completed objective.

### 8.2 Planning-decision queue

A dedicated queue should answer:

```text
Which implementation efforts need a planning decision?
Why did they return to planning?
What work is blocked?
What graph or contract change is proposed?
Who reviewed it?
What does the operator need to decide?
```

### 8.3 Plan comparison

The UI should support:

- plan-version diff;
- dependency-graph diff;
- acceptance-obligation diff;
- scope and non-goal diff;
- risk-classification diff;
- review-finding-to-disposition mapping;
- disposition-to-accepted-plan reconciliation.

### 8.4 Decomposition proposal view

A fan-out proposal should display:

```text
Current node
    CT-04A

Proposed children
    CT-04A1
    CT-04A2

Reason
    process boundary and durable registration are separate
    assurance domains

Inherited constraints
    shown explicitly for each child

Acceptance allocation
    A1 internal proofs
    A2 state and journal proofs
    parent composed integration gate

Downstream impact
    CT-04B remains blocked until parent completion
```

The operator may accept, modify, reject, or escalate.

### 8.5 Evidence alongside planning

A work-item page should eventually show:

```text
Normative contract
Current work graph
Source-specific implementation plan
Design review
Operator disposition
Accepted implementation plan
Implementation generations
Code reviews
Planning feedback
Completion evidence
```

---

## 9. Amendments to the CT-12 Planning Studio artifact workflow

CT-12 should support the manual planning-control lifecycle before model generation.

In addition to the existing scope, CT-12 should add:

- immutable plan versions;
- immutable work-item revisions;
- dependency-graph revisions;
- decomposition proposals;
- decomposition decisions;
- planning-feedback records;
- design-review records;
- operator dispositions;
- accepted implementation plans;
- acceptance-obligation allocation;
- plan and graph comparison;
- manual recursive fan-out;
- blocked-on-planning state;
- traceability from finding to disposition to accepted plan.

CT-12 must prove:

```text
a user can create or import a normative plan
    ↓
create a source-specific implementation-plan proposal
    ↓
record an independent design review
    ↓
disposition every finding
    ↓
adopt an accepted implementation plan
    ↓
receive implementation feedback
    ↓
approve a recursive decomposition
    ↓
preserve prior plan and graph revisions
    ↓
create proposed child work items
```

No model generation is required.

---

## 10. Amendments to the CT-13 model-assisted planning pipeline

CT-13 may automate proposal generation, critique, reconciliation drafts, and decomposition suggestions.

It must not automate authority.

Planning providers may:

- propose a plan;
- propose work-item decomposition;
- reconcile source context;
- identify missing evidence;
- produce critic findings;
- propose a graph transition;
- draft an operator disposition from explicit operator annotations;
- generate a candidate accepted implementation plan.

They may not:

- adopt their own plan;
- accept their own decomposition;
- disposition findings without operator authority;
- create executable work automatically;
- launch implementation;
- weaken inherited constraints;
- redefine protected acceptance criteria;
- silently suppress contested findings.

A model-assisted planning run should retain:

```text
selected source artifacts and hashes
source baseline
provider and model
prompt/instruction version
stage outputs
critic findings
planning-feedback inputs
operator decisions
graph revisions
final artifact hashes
```

---

## 11. Data and event seam to preserve before CT-12

CraftingTable does not need to implement the full Planning Suite during the first useful release.

However, current work should avoid decisions that make it impossible later.

The implementation should preserve:

- immutable imported plan artifacts;
- stable `WorkItemId` values;
- parent/child relationships that can be versioned later;
- exact source baselines for implementation plans;
- review and disposition artifacts;
- accepted-plan hashes;
- implementation and review generation identity;
- explicit planning-blocked or needs-attention semantics;
- audit attribution for operator planning decisions.

Repository files remain a valid interim representation:

```text
work-items/<slice>-proposed-implementation-plan.md
review-findings/<slice>-design-review.md
work-items/<slice>-operator-disposition.md
work-items/<slice>-accepted-implementation-plan.md
```

The future Planning Suite may ingest and project those artifacts without pretending they were already native database records.

---

## 12. Acceptance properties for the future Planning Suite

The Planning Suite must prove at least the following:

1. A source-specific plan can recommend decomposition without changing the authoritative work graph.
2. A decomposition remains proposed until an authorized operator adopts it.
3. Parent constraints are visibly inherited by every child.
4. A child cannot weaken an inherited prohibition without a parent amendment.
5. Every parent acceptance obligation is allocated or retained as an integration gate.
6. Parent completion requires the composed result, not merely child completion flags.
7. Previous plan and graph revisions remain queryable.
8. A rejected decomposition does not disappear from history.
9. A modified decomposition records how the operator changed the proposal.
10. A graph revision cannot introduce a dependency cycle.
11. Implementation pauses when a blocking planning issue is unresolved.
12. A new accepted plan is required before implementation resumes after a material contract change.
13. A planning provider cannot launch work or create branches.
14. A worker cannot broaden its own scope through planning feedback.
15. Exact source baselines and artifact hashes bind reviews and dispositions to the plan actually evaluated.
16. Review findings, operator decisions, accepted-plan sections, and proof cases remain traceable.
17. Repeated invariant-level remediation can trigger a planning escalation.
18. Recursive decomposition works at arbitrary depth within configured usability limits.
19. Downstream dependency impact is shown before a graph transition is adopted.
20. Plan evolution remains reconstructable after daemon restart and browser reconnection.

---

## 13. Non-goals

This addendum does not require:

- Planning Studio implementation before the existing dogfood gate;
- autonomous plan adoption;
- automatic acceptance of decomposition;
- a universal project-management system;
- model-generated strategy without human review;
- one model to serve as planner, critic, implementer, and judge;
- distributed planning among multiple users;
- Exoskeleton integration;
- replacement of repository-local planning artifacts before CT-12;
- perfect prediction of implementation scope before source inspection.

The goal is governed adaptability, not omniscient planning.

---

## 14. Reference process

The default future process should be:

```text
1. Adopt normative milestone.

2. Decompose it into provisional work contracts.

3. Select one implementation slice.

4. Inspect the exact source baseline.

5. Produce a source-specific implementation-plan proposal.

6. Run independent pre-implementation design review.

7. Operator dispositions every material finding.

8. Produce and approve the accepted implementation plan.

9. Implement one coherent generation.

10. Run deterministic verification and exact-head code review.

11. Remediate invariant-level defects within the accepted design.

12. When evidence invalidates the design or scope:
        stop implementation
        emit PlanningFeedback
        review and disposition the proposed change
        create a new plan or recursive decomposition
        resume only under a new accepted implementation plan

13. Complete the parent only after all child and integration
    obligations are satisfied.
```

---

## 15. Product principle

CraftingTable exists to reduce the cognitive burden of supervising delegated software work without giving delegated workers control over the meaning or scope of that work.

The Planning Suite must therefore preserve both learning and authority:

> **Implementation is allowed to teach planning. It is not allowed to become planning authority.**

CT-04A is the first concrete reference case. Its lesson should remain part of CraftingTable’s permanent design:

> **A decomposition is provisional until source reality has been inspected, and any accepted child may fan out again when planning reveals a safer assurance boundary.**
