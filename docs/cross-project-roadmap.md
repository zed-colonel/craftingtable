# Cross-project roadmaps

Status: **delivered; tracked implementation backlog complete** (2026-09-22).
This document records the supported behavior and remaining product direction. Runtime behavior,
repository guidance and accepted ADRs are authoritative. Production configuration, roadmap Start,
plan/evidence acceptance and protected-branch promotion remain explicit operator actions.

## Supported capabilities

| Capability | Delivered behavior | Decision |
| --- | --- | --- |
| Import and binding | Bounded ZIP preview, immutable map versions and exact project/plan/repository binding; full plan ZIP replacement preserves history. | [ADR-043](decisions/043-package-imports-and-concurrency-previews.md) |
| Executable slices | Independent slice worktrees, implementation/review cycles, slice verification and original-parent acceptance. | [Execution scopes](decisions/045-slice-execution-and-parent-acceptance.md) |
| Scheduling | Transition-specific gates, exclusions, development/review limits and durable resource reservations. Dependencies and evidence gates always apply. | [ADR-046](decisions/046-transition-gates-and-resource-reservations.md) |
| Dependency environments | Exact upstream pins, immutable prepared sources, scoped/current-build policies and reviewed evidence receipts. | [ADR-047](decisions/047-pinned-builds-and-reviewed-evidence.md), [ADR-053](decisions/ADR-053-scoped-verification-and-local-ci.md) |
| Supervision | Selected targets and scope, project lanes, cross-project dependency tracing, explicit map adoption and saved-plan acceptance. | [ADR-048](decisions/048-cross-project-supervision.md) |
| Amendments and finalization | Reviewed changes with impact/reconciliation, evidence invalidation and coordinated full-plan finalization. | [ADR-049](decisions/049-reviewed-map-amendments-and-finalization.md) |

The map describes requirements and evidence; a roadmap binds it to exact plans, repositories,
model profiles, policies and execution attempts. This extends the existing roadmap scheduler.
Whole-item manual, sequential and parallel workflows remain available. CraftingTable has no
runtime dependency on the applications it supervises.

## Progress and authority

| Fact | Meaning |
| --- | --- |
| Slice merged | Reviewed code landed in its recorded integration branch. |
| Slice verified | Required checks and case evidence passed for that slice's code, pins and environment. |
| Parent accepted | Original work-item obligations, predecessor requirements, required slices and assigned evidence are satisfied. |
| Project finalized | Full-plan finalization passed and the operator approved the exact candidate/destination merge. |
| Published | Separate release/publication evidence exists wherever the map requires it. |

A slice merge never completes its parent. A satisfied prerequisite makes a checkpoint eligible;
it does not pass that checkpoint. Target prioritization changes order, not requirements. Selected
scope retains excluded parent obligations. Manual recovery within an adopted roadmap observes
the same applicable gates as automation.

Freshness binds evidence to reviewed source, dependency generation, environment and policy.
Changes require explicit reconciliation; there is no implicit binding to a latest plan or pin.
Integration merges may be delegated. Final promotion to main/protected destinations always needs
operator approval. See [integration authority](decisions/033-delegated-integration-and-plan-finalization.md)
and [staged finalization](decisions/042-staged-plan-finalization.md).

## Capacity and recovery

Workspace **Settings → Execution capacity** groups workstation development/verification pools
and the selected roadmap's total/per-repository in-flight ceilings. Occupied reservations and
waits link to their work. Values survive restarts; lowering capacity preserves existing runs.
Changing capacity never clears a dependency or evidence gate. Pause roadmap scheduling before
saving; capacity changes require refreshed saved-plan acceptance. Roadmaps link to these settings.
See [ADR-061](decisions/ADR-061-host-verification-settings.md).

Known temporary model-service failures receive at most three automatic retries, after 1, 5 and
15 minutes, on the same backend/model. The separate service allowance, next attempt and failure
reason are durable and visible with **Retry now** and **Pause service recovery** controls on work
items, run pages and finalization. The original step deadline still applies. Remediation allowance
is unchanged. Roadmap pauses hold retries; restart recovery requires explicit resumption.

Retries start fresh vendor sessions with the full handoff and existing worktree. Original sessions
are not resumed because old sandbox paths, dependency launchers and receipt identity are run-bound.
Process/tool completion must be unambiguous and cleanup complete. New attempts recheck current
phase, evidence, branch and authority gates. Unknown failures, authentication, quota limits, pending
tools, operator questions and exhausted retries require operator attention. Partial reports never
become successful review evidence. Historical failures remain explicit manual recoveries; raw old
vendor logs are not reinterpreted to launch work. See [ADR-062](decisions/ADR-062-bounded-provider-recovery.md).

Independent domain-only parent acceptance may depend on an accepted same-repository predecessor
without acquiring an upstream runtime-build obligation. Required slices, assigned cases and every
acceptance gate remain enforced. Mixed/integration/conformance/release and unknown scopes retain
current-upstream checks. EXO-02's draft lock finding was reassessed against the approved historical
AQ/WI sources: its isolated v3 lock resolves with `--locked --offline` unchanged. A fresh independent
review must collect its own complete test/lint evidence; the failed draft is not an acceptance receipt.

## Reference package and verified provenance

Reference archive: `cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip`,
provided alongside the revised WI and EXO packages in the operator's
`ActionQueue-alignment-review-and-revised-packages` download set. Do not commit local
machine paths or copy the entire download set into the repository.

| Identity | Value |
| --- | --- |
| Map ID | `EXO-STACK-CONCURRENCY-DRAFT-1` |
| Revision / schema version | `0.3.0` / `0.3.0` |
| Archive SHA-256 | `3df30b94de7dad830b67a2f6f67cc9d662023f8f36a307db10e915d2a24da335` |
| Canonical map YAML SHA-256 | `51563f70c37bd7ca696f22833ec81d37acfa4918ba380dec679198c0a4f36cff` |
| Planned work | 33 parents: 14 WI and 19 EXO; 69 execution slices |
| Checkpoints | 95, including architectural decisions and cross-stack gates |
| Supporting provenance | 30 source snapshots |
| Acceptance coverage | 76 worker/execution case mappings and 48 AQ baseline case mappings |

Bound archives:

| Repository | Archive | SHA-256 declared by map |
| --- | --- | --- |
| WI | `wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip` | `151dd46ca8c295964de5e82da6d6f01797c663a22b50f01df6ff9fb2db1a5e69` |
| EXO | `exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip` | `5e430bea7723785f70374e0aa377f5c0ab6731ab9c1d52a620b7a3cbfa976a5b` |
| AQ | `actionqueue-main(1).zip` | `f91f496f22772e8dda044b0cf2cf05cf2eafa9f86d6f0c7e0061b46e3926ffb1` |

Inspection verified the map archive/YAML hashes, all 30 embedded snapshot hashes, both
supplied WI/EXO archive hashes, and all 13 WI / 12 EXO referenced documents against those
archives. The AQ archive hash above is a declaration, not an independently verified local
archive in this inspection. The bundled validation report was inspected; its validator was
not executed. These checks establish source consistency, not implementation correctness,
application support, adoption, checkpoint passage or runtime compatibility.

The package is a draft with `automatic_activation: false`. Its scripts, schema, derived
reports and snapshots are untrusted input/reference material, not executable import logic
or authority to grant permissions. Supported semantics belong to CraftingTable's validator.
Counts above are fixture expectations, not constants in the generic scheduler.

## Future product direction

Planning Studio remains future work. It should author the same validated, versioned plans/maps
and attributed decision proposals consumed by import today. It must share preview, impact review,
exact binding, acceptance and reconciliation commands; authoring never silently changes an active
roadmap or waives evidence. Import remains a supported path.

Remote qualification adapters are also future work. Imported resource names alone do not establish
an available environment; unsupported required semantics remain blocked with an explicit reason.
Neither capability is an unfinished item in the completed six-increment roadmap.

See [Planning Studio boundaries](decisions/ADR-028-roadmaps-and-planning-studio-boundaries.md),
[sequential execution](decisions/ADR-029-sequential-roadmap-execution.md), and
[controlled parallelism](decisions/ADR-030-controlled-parallel-roadmaps.md).
