# ADR-028: Roadmaps and Planning Studio boundaries

Status: proposed. Date: 2026-09-11.

Implementation planning update (2026-09-15): the operator-approved
[cross-project concurrency roadmap](../cross-project-roadmap.md) applies these boundaries
to the revised v0.3.0 package and records the delivery sequence and acceptance criteria.
The v0.1.0 facts below remain historical context; the linked roadmap records current input
identities. Cross-map import and execution are not implemented yet.

## Context

Single-item cycles, integration branches, phone supervision, and Pushover delivery have
been exercised. The agreed next progression is sequential roadmaps, controlled parallel
execution, then cross-project orchestration with explicit upstream revision bindings.
Planning Studio will eventually make structured, AI-assisted authoring available beside
execution; import remains a supported way to supply plans.

The supplied `cross-stack-concurrency-draft-v0.1.0.zip` provides a concrete future input:
47 parent work items, 67 execution slices, and 96 checkpoint definitions. Its YAML digest
is `9b62884ea0307cac0707ede2c9255f4e61be11c3ece1cdf583ae981fe6249fce`.
It separates start, merge, verification, and parent acceptance requirements. Its ten
stack-specific decisions remain proposals. Package validation and source-baseline hashes
are not evidence of implementation progress or approval of those proposals.

The original Planning Studio seam and planning/implementation feedback addendum in
`init/` describe versioned adoption, recursive decomposition, and implementation feedback.
They inform this direction; current runtime behavior and accepted ADRs remain authoritative.

## Proposed decision

**Definitions, authoring, and execution have separate lifecycles.** Roadmaps reference exact
project, plan-version, and work-item identities. Their identities are distinct from agent
cycles, attempts, branches, and worktrees. Execution records bind the definition revision
and effective policies they actually used. Source IDs alone never imply identity across
plan versions. Future authoring connects revised objectives through explicit lineage.

Import and Planning Studio should feed the same domain validation and adoption rules.
File parsing and import-attempt provenance belong to the import adapter. Studio proposals
may retain source artifacts, model/critic output, human edits, and validation results
without manufacturing an upload. Adoption produces a reviewed definition; starting a
roadmap separately delegates execution of its selected scope. A planning agent may
propose decomposition or amendment, while the operator adopts the graph change.

**Eligibility belongs to a particular transition.** Start prerequisites, merge gates,
verification requirements, and parent acceptance are distinct. Initial roadmaps use
whole-item prerequisites and today's review/merge rules. Later, explicitly adopted slice
rules may permit isolated early work while preserving original parent acceptance barriers.
The first scheduler must not generalize that exception or infer it from prose or numbering.
Scheduling priority and resource capacity remain separate from dependency requirements.

**Merge, verification, and parent completion are distinct facts.** Existing whole-item
merges retain today's completion behavior. Slice execution will require extending that
path: landing one slice cannot complete its parent. A checkpoint's satisfied prerequisites
make it eligible for evaluation; passing requires the appropriate evidence or decision.
Evidence records bind the relevant definition, code, upstream revisions, and artifacts.
History remains immutable when current applicability becomes stale. Consumers evaluate
compatible revision sets, not a collection of independently green predecessor flags.

**Amendments are reviewed revisions.** A future Studio can split work, introduce discovered
prerequisites, or revise acceptance obligations. Adoption must show downstream impact and
explicitly reconcile queued and affected in-flight execution. Running work never follows
an implicit latest plan. Completed work and previous reviews retain their original context.
Scope-changing agent feedback goes to a planning decision, outside automatic remediation.

## Consequences

The first useful release remains a sequential roadmap delegating whole-item cycles,
creating worktrees when eligible and advancing after operator merges. Separate roadmap
entry and execution identities, revision-bound settings, and explicit blocker reasons
provide the extension points. Full slice execution, checkpoint evidence, revalidation,
release evidence, and Studio authoring arrive in later increments.

The supplied sidecar is a future compatibility example, not a supported import format.
Unknown required scheduling semantics must be rejected rather than silently flattened.
It references existing source plans by exact bindings; its source snapshots must not
create duplicate plans. Previous AQ completion history should be reconciled with future
evidence requirements, preserving proven work without manufacturing new checkpoint passes.

## Alternatives considered

Binding roadmap identity directly to one work item, cycle, or worktree would make slices
and repeated attempts awkward. A single completed flag would conflate partial integration
with parent acceptance. Separate scheduling engines for imported and Studio-authored work
would drift. Implementing the draft's entire evidence system before the first roadmap
would delay exercising the scheduler; preserving these boundaries permits staged delivery.
