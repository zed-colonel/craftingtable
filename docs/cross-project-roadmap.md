# Cross-project concurrency roadmap

Status: **increments 1–6 delivered**. Import, exact binding, execution slices, phase scheduling,
pinned environments/evidence, supervision, amendments and finalization coordination are available.
Delivery does not adopt production map decisions, start work or approve any merge.

This document preserves the operator-approved direction and package-specific details for
work across sessions. Update delivery status and record material deviations here as work
lands. Runtime behavior and accepted ADRs remain authoritative until each change ships.
See [ADR-028](decisions/ADR-028-roadmaps-and-planning-studio-boundaries.md),
[sequential roadmaps](decisions/ADR-029-sequential-roadmap-execution.md),
[parallel roadmaps](decisions/ADR-030-controlled-parallel-roadmaps.md),
[integration/finalization authority](decisions/033-delegated-integration-and-plan-finalization.md),
and [staged finalization](decisions/042-staged-plan-finalization.md).

## Product outcome and boundaries

The user-facing result is a **cross-project roadmap**. The concurrency map defines work,
phase-specific requirements, checkpoints and evidence obligations. The roadmap binds that
definition to exact projects/plans/repositories and adds model profiles, policies, selected
scope, capacity, execution attempts and progress. It extends the existing roadmap capability.
It is not a second scheduling engine or a general workflow language.

Import and the eventual Planning Studio must produce the same validated domain definition
and use the same adoption rules. Keep authoring, adoption and execution separate. Preserve
manual operation, existing whole-item roadmaps, bounded recovery, mobile supervision,
notifications, and the operator's exclusive approval of promotion into main/protected branches.
CraftingTable must not depend on AQ, WI or EXO runtime code.

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

## Required progress model

| Fact | Meaning |
| --- | --- |
| Slice merged | The reviewed slice landed in its recorded integration branch. |
| Slice verified | Required checks and case evidence passed for the slice's code, upstream pins and environment. |
| Parent accepted | All original work-item obligations, predecessor requirements, required slices and assigned evidence are satisfied. |
| Project finalized | Full-plan finalization passed and the operator explicitly approved the exact candidate/destination merge. |
| Published | Separate release/publication evidence exists where required by the map. |

A slice merge must not complete its parent. A prerequisite becoming satisfied makes a
checkpoint eligible for evaluation; it does not pass the checkpoint. Evidence eligibility,
execution authority and available resources are distinct. An intermediate target reached
is not a completed full plan or a published release.

The current whole-item merge/completion path, one-unmerged-worktree-per-item guard, roadmap
entry identity and capacity accounting all need deliberate extensions. Existing whole-item
roadmaps retain their behavior. A manually driven action inside an adopted cross-project
roadmap must honor the same applicable gates as automation.

Execution slices here are independently implemented portions of work items. They are not
the correctness/conformance review scopes called slices in staged plan finalization.

## Delivery sequence

### 1. Import, preview and exact plan binding — delivered

Add **Import concurrency map** under Roadmaps. Accept the reference ZIP through a bounded
archive adapter; validate before persisting an inactive immutable definition. Keep parsing,
pure semantic validation, project binding and execution separate.

- Validate archive paths, duplicate members, links, entry counts and expanded bytes. Parse
  bounded UTF-8 YAML with explicit handling/rejection of unsupported aliases, duplicate keys,
  merge keys and tags. Never run uploaded validators or arbitrary commands.
- Dispatch by known document kind/schema. Validate IDs, references, phase requirements,
  source bindings, parent coverage and the expanded milestone graph for cycles. Unknown
  required semantics must produce an error, never silently become ordinary predecessor links.
- Bind repository aliases to exact project IDs, plan-version IDs, work items, registered
  repositories and existing plan branch settings. Suggested names such as `wi-fabric-2`
  and `exo-v3` do not authorize changing branches. Never choose an implicit latest plan.
- Match source documents and relevant whole-item source records, including supporting
  acceptance/environment documents. Source IDs alone are not identity across plan versions.
  Preserve raw archive provenance separately from CraftingTable's canonical bundle digest.
- The operator explicitly requested full ZIP imports over existing projects for this increment.
  Both import paths now support 64 artifacts / 60 supporting files. ZIP import previews current
  documents, retains the full archive, adds an immutable version, and offers guarded explicit
  activation. Old versions/history remain intact; new branch settings need explicit configuration.
- Map snapshots supply provenance, not duplicate imported plans. Missing/mismatched plans
  are diagnostics with a binding remedy, not permission to manufacture a compatible plan.
- Preserve import attempts/diagnostics, immutable source and definition identity. Reimporting
  identical content is idempotent; conflicting content under the same map/revision is rejected.
- Preview project/branch bindings, parent/slice/gate counts, proposed decisions, targets,
  baseline gaps, resource requirements and unsupported capabilities. Permit inspecting a
  valid definition whose execution requirements are not yet configured; keep activation blocked.
- Adoption is an explicit recorded operator decision; **Start** separately delegates execution.
  Imported proposals and requirements do not arrive approved. A coherent adoption review may
  record multiple decisions together without requiring a separate click for every checkpoint.

Acceptance: the supplied v0.3 package can be inspected and bound to the matching revised
plans, with useful diagnostics for wrong/missing versions or capabilities. Import creates
no cycles, worktrees, completion flags or checkpoint passes. Unsupported execution remains
unavailable rather than being approximated. No duplicate plans are created. Tests cover
malformed archives/documents, cycles, version mismatch, idempotency and authorization.

### 2. Executable slices and parent acceptance — delivered 2026-09-16

Extend roadmap entries/attempts to identify a whole item or a specific owned slice.
Independently executing slices get their own branch, worktree and attempt. Reuse the existing
design/implement/review/remediate cycle, handoff, recovery and conflict machinery.

Briefs and review contracts must carry slice scope, exclusions, prerequisites and relevant
acceptance obligations. Use durable evidence references and compact context so the larger
map does not recreate the finalization handoff/report bloat problem.

WI slices merge into the bound WI integration branch; EXO slices into EXO's. AQ is a pinned
upstream, not a new implementation queue. Landing a slice records integration only. Parent
acceptance evaluates the original exit gate, required predecessor acceptance, owned slice
verification and all assigned evidence. Some case evidence is produced by another slice;
its owner still cannot be accepted without it. Do not turn evidence ownership into a
reverse start dependency and accidentally create a cycle.

Acceptance: `wi/WI-02/domain` can land without completing WI-02 or releasing dependencies
that require WI-02 acceptance; `wi/WI-02/integration` and retained parent obligations still
matter. Multiple authorized slices can coexist without bypassing worktree/mutation guards.
Legacy whole-item behavior and manual controls remain usable.

Delivered: frozen scope identities in worktrees/cycles/roadmaps, independently executable
sibling slices, compact evidence artifacts, slice merge and verification records, and a
separate parent acceptance review/command. The work-item UI exposes these scopes and the
roadmap editor accepts slice entries. Real-Git tests cover sibling execution, fresh review,
independent acceptance and prevention of premature parent completion.

The reference map still cannot execute: checkpoint/qualified case evidence, decision adoption
and pinned upstream environments remain closed gates.
No production WI/EXO work is started by this increment. Parent acceptance remains a manual
command after an independent review; later integrated supervision may delegate that command
under an explicit policy without changing its evidence requirements.

### 3. Transition-specific scheduling and resources — delivered

Evaluate explicit requirements at start, merge, verification and parent acceptance, including
implicit phase ordering. Preserve parent barriers while permitting the early development
explicitly authorized by adopted slice rules. Recheck applicable gates at mutation boundaries.

Reuse global/per-repository concurrency limits, exclusion groups, exact-commit reviews,
automatic integration policies and serialized repository mutations. Introduce phase-specific
resource reservations and distinguish dependency, evidence, review, authorization and resource
blockers. Reserve atomically, release when no longer needed, and never hold a merge lock
while waiting for a checkpoint or qualification host.

A merged slice awaiting verification must release its development capacity. Otherwise it
could starve the later producers needed to verify/accept it. Repository refresh, conflict
resolution and fresh review continue to apply independently in each repository.

Acceptance: after adoption and applicable configuration, `wi/WI-01/implementation` and
`exo/EXO-01/domain` can start concurrently; AQ baseline evaluation can proceed independently.
One blocked slice does not stop independent siblings. Verification waiting cannot exhaust all
development slots. Restart preserves reservations/evidence and retains explicit resume behavior.

Delivered: shared typed phase gates, explicit per-slice early-development authorization,
atomic durable run/operation resource reservations, separate development and verification
admission pools, and phase/reservation visibility on work-item pages and roadmap progress.
Resource/dependency waits retry without operator attention; restart releases interrupted claims
while retaining their history and requiring explicit resume. Merged slices and review-only
worktrees no longer occupy development slots. Real-Git tests cover contention, cancellation,
restart, all-or-none claims, early development/parent barriers, qualification waits and a
later sibling merging first followed by integration refresh and fresh review.

Implementation boundary: local development resources use the existing worktree/scratch adapter;
installation admission capacities are daemon environment settings. Native/Kata resource names
remain unavailable rather than pretending to enforce qualification. Early-development approval
can authorize only a declared rule without unresolved decision references; complete map decision
adoption remains increment 5. The reference WI/EXO/AQ map still needs increments 4–5 before Start.
See [ADR-046](decisions/046-transition-gates-and-resource-reservations.md).

### 4. Pinned dependency environments and durable evidence — delivered

Record exact upstream commits/artifacts, conformance versions, tested code, fixture and
environment identity, required cases, verification runs and reviewer/decision provenance.
The execution adapter must actually supply the recorded dependencies to builds/tests;
a prompt mentioning hashes is insufficient. Avoid shared mutable test data/service namespaces.

AQ is already implemented: the map specifies version 0.2.0 / conformance revision 16 but
leaves `implementation_commit` unbound. Reconcile with the real completed repository and
finalization evidence. A historical source commit is not its current build pin. Reuse applicable
existing evidence explicitly; do not reopen the retired AQ work items or infer new gates passed.

Checkpoint evidence must satisfy the applicable profile and assigned case coverage. Detect
missing, duplicate, stale, wrong-scope or incompatible receipts. An implementer's assertion or
an eligible gate is not independent verification. Changing relevant code, upstream pins,
requirements or environments makes affected evidence require reassessment; preserve its history.
Changing WI during finalization can therefore affect downstream EXO evidence too.

Represent the map's isolated development, controlled native qualification and actual Kata
qualification environments distinctly. Bind them explicitly to available resources and required
operator authorization. A native host cannot stand in for Kata. Provide UI evidence submission
and review for externally performed checks; delegate execution only through adapters capable
of enforcing the configured boundary. Do not imply that CraftingTable provisions a cluster,
grants live credentials, or establishes security isolation merely by assigning a profile name.

Acceptance: the same code tested against different upstream pins cannot reuse an incompatible
pass. Missing qualification resources block only affected phases. Existing AQ history remains
intact. `AQ-BASELINE-ACCEPTED` and `AQ-PUBLISHED` remain distinct: the WI AQ release gate does
not require AQ publication, while the EXO AQ gate does under this map.

Delivered: immutable runtime generations and exact Git/Cargo pins, per-run snapshots and
source-enforcing Cargo launches, frozen clean-commit build records, external native/Kata
qualification packages, exact profile/case validation, independent reviewer attestations,
explicit operator decisions and browser review/download controls. Existing successful AQ
review history can be explicitly reused only when its source tree matches the current pin;
AQ baseline acceptance never supplies publication approval. Repinning or changing environments
requires reassessment; merge/acceptance rechecks current provenance. Native/Kata execution
remains external until an enforcing execution adapter exists. Decision checkpoints and map
adoption remain closed pending increment 5. See [ADR-047](decisions/047-pinned-builds-and-reviewed-evidence.md).

### 5. Cross-project supervision and target selection — delivered 2026-09-16

Make the roadmap navigable as project lanes/groups with expandable parent/slice cards and
a focused dependency view. On mobile, retain a usable grouped list and detail navigation.
Every blocker must identify the supplying work/checkpoint/resource, its current progress,
and the available action. Show independent progress and the exact scope of completion.

Offer roadmap profile/policy defaults, project/activity overrides and individual overrides.
Do not require manually configuring every slice. Keep per-attempt effective settings durable.
Pushover uses existing persistence/retry/reminder behavior for actionable questions, failed
recovery and approvals; expected dependency waiting is not an attention event.

Expose the package's targets:

| Target | Scope |
| --- | --- |
| `WI-EMBEDDED-WORKER-PROOF-1` | Native WI process-provider proof; no EXO or Kata prerequisite. |
| `EXO-EMBEDDED-VIABILITY-1` | Bounded EXO viability on actual Kata with embedded AQ/WI; package's suggested focus. |
| `FULL-STACK-RELEASE` | Full retained obligations through `EXO-PUBLISHED`. |

Differentiate selecting a target's prerequisite scope from prioritizing its ancestors inside
a full roadmap. The import's suggested focus is not an automatic scope decision. Show the
closure and excluded work before starting. Reaching a selected intermediate target does not
accept excluded parents or waive later release obligations. Distinguish target reached,
selected-roadmap scope complete, full-plan accepted, finalized and published in the UI.

Acceptance: the operator can trace a blocked EXO slice to its WI requirement and the action
that advances it without terminal work. Target selection is explicit and preserves all
requirements. Genuine questions always pause for operator input.

Delivered: target-only closure and full-roadmap prioritization, explicit exact-binding scheduling
adoption, inherited settings with project/activity/individual overrides, generated slice development,
independent verification and parent-acceptance activities. Explicit agent reviewer responsibilities
are bound to attempts and retained on receipts; they confer no external qualification authority. Adoption does not pass checkpoints;
independent decision/qualification evidence remains required. The supervisor provides grouped
project/parent lanes, dependency tracing, evidence links and separate completion dimensions.
Parent acceptance defaults to manual and may be delegated explicitly. Review findings/questions
pause for scope recovery; read-only review snapshots cannot implement fixes. Integration drift
fast-forwards clean review snapshots and requires fresh review. Current target evidence is checked
again before completion. Pushover aggregates eligible checkpoint work through existing retries and
reminders, without alerting on ordinary dependency/resource waits. Native/Kata execution remains
external. Superseded map bindings and invalidated completed verification require a new roadmap;
reviewed amendment/reconciliation is increment 6. See [ADR-048](decisions/048-cross-project-supervision.md).
No production map was adopted and no WI/EXO work was started during delivery.

### 6. Amendments, finalization and Planning Studio seam — delivered 2026-09-16

New maps/plans create reviewed revisions with an impact preview: changed requirements,
queued work, in-flight attempts and evidence applicability. Never silently rebind to latest.
Pause affected new dispatch while reconciling changes; preserve running attempts' original
bindings and history, and recheck before subsequent transitions. Prior approvals/evidence do
not automatically migrate to a new definition. Prevent competing delegation for the same work;
retain the current one-delegated-roadmap-per-workspace boundary unless separately revised.

Import and future Studio proposals use the same normalized definition, validation and adoption
services. Agent-discovered scope changes become explicit planning proposals outside automatic
remediation. Resolve material implementation decisions in short ADRs as delivery proceeds.

A project's full work-item acceptance unlocks its existing staged finalization. Finalization
works against a pinned integration snapshot with its existing hold and evidence rules. Final
promotion is always the operator's exact-commit decision, regardless of roadmap auto-merge
settings. Publication requires separate evidence where the map demands it; a tag name, release
note or merge to main is not sufficient by itself.

Acceptance: replacing a plan/map shows affected work and stale evidence without rewriting
completed history. Intermediate target completion cannot finalize an incomplete plan. No map,
agent, checkpoint or automation setting approves protected-branch promotion.

Delivered: immutable proposals and decisions with current impact digests, queued-work/requirement/
evidence previews, exact replacement binding and explicit plan activation. Pending proposals hold
workspace delegation; live sessions retain their context. Reviewed revisions preserve old attempts,
branches and completion history, with optional ancestry-checked integration code reuse and fresh
verification/acceptance. Same-binding reconciliation replaces stale reviews after runtime changes.
The UI links full original parent acceptance to staged finalization; map/runtime/integration snapshots
remain frozen and final promotion remains an exact-commit operator command. Provider promotion
requires explicit downstream repinning and reassessment, not implicit publication approval.
The shared bounded normalized-definition validator is the future Studio authoring seam; agent scope
changes surface as questions and can be recorded as attributed proposals. See [ADR-049](decisions/049-reviewed-map-amendments-and-finalization.md).

## Delivery and resumption notes

Implement the increments in the sequence above, designing their shared identities and
requirements together. Useful UI for each new capability belongs with its backend increment;
step 5 adds the integrated supervision experience rather than delaying all controls until then.
The first deliverable is intentionally reviewable without being executable. Do not enable
cross-map execution until every required semantic in its selected scope is enforced.

Use v0.3 as a conformance fixture with smaller focused fixtures for behavioral tests. Do not
hard-code WI/EXO IDs, counts or package-specific Python validation into the production engine.
Validate source/binding errors, partial completion, phase eligibility, incompatible evidence,
resource starvation, restart recovery, concurrent Git mutations, amendments and protected merge
authority. Required repository checks apply to each implementation increment.

Before implementation, re-read repository guidance and the current relevant services/contracts;
this document records observed gaps, not a frozen description of future code. Important starting
points are `packages/domain/src/roadmap.ts`, `apps/server/src/services/roadmap-service.ts`,
`apps/server/src/services/plan-import-service.ts`, `packages/planning/src/bundle.ts`,
`packages/planning/src/limits.ts`, `apps/server/src/services/execution-service.ts`, and
`apps/web/src/features/planning/ImportPlanPage.tsx`.

Delivery status: **increments 1–6 delivered**. See [ADR-043](decisions/043-package-imports-and-concurrency-previews.md).
Reference-fixture checks reconstruct 335 milestones and 1,221 edges. WI and EXO ZIPs
retain 27 and 28 current planning documents respectively. Desktop/phone tests cover
upload, exact binding and reload; daemon tests cover source mismatch, stale binding
revisions, conflicting imports, durable records, preserved versions and activation guards.
Production plan imports and exact bindings remain intact. AQ remains a registered upstream
awaiting explicit pin configuration and reviewed evidence in the new runtime controls.
The six-increment implementation sequence is complete. Planning Studio authoring and enforcing remote
qualification adapters remain future capabilities. Production adoption, configuration and Start remain
explicit operator actions.
No production work, map decisions or baseline/publication gates were authorized by increment 4.

## UI settings backlog

- [x] **Host verification capacity** (requested 2026-09-21; delivered 2026-09-22).
  Settings exposes the installation-wide `local-verification` limit (1–32), current slot
  holders with run/work-item links, and recorded cycle capacity waits. Roadmaps link to it;
  reviews not yet dispatched remain visible in roadmap supervision. Development capacity
  stays separate. Saved values survive restarts and override the verification environment
  default. Lowering the limit preserves active runs; increasing it admits only eligible work.
  Owner authorization, version checks and audit apply. Pause roadmap scheduling before saving,
  then generate and accept updated saved-plan evidence. Dependencies and all evidence/merge
  gates remain enforced. See [ADR-061](decisions/ADR-061-host-verification-settings.md).

- [ ] **Provider-failure recovery** (investigated 2026-09-22). Distinguish transport/provider
  failures from invalid reports and source findings. EXO-02's parent review ended on Codex's
  structured `serverOverloaded` error with `willRetry: false`; current recovery starts another
  same-step run with handoff in the existing worktree, without consuming a remediation round.
  Proposed next increment: bounded, durable same-model retries with backoff and a separate
  service-retry allowance; show provider reason, next retry, attempts, Retry now and Pause.
  Preserve partial work and run lineage; require terminal process/child cleanup, fresh phase
  gates and an explicit complete successful report. Respect roadmap pauses and restart holds.
  Investigate safe same-session continuation with current run paths, sandbox and build receipt
  identity before using the adapter's thread-resume support; ordinary retries currently create
  a fresh session. Never switch models silently. Authentication, exhausted allowances, unknown
  failures and ambiguous tool completion require operator review. Automatic retries and model
  switching are not delivered by the settings increment.

- [ ] **Parent build applicability** (discovered during provider-failure investigation,
  2026-09-22). EXO-02 is imported as independent, has only a domain slice and no AQ
  baseline cases, but its same-repository EXO-01 acceptance prerequisite makes the build
  classifier fall back to current-upstream builds. Reconcile ordinary accepted predecessor
  requirements with independent parent build applicability, preserving every acceptance gate.
  Its interrupted parent review also reports lock metadata changes under the supplied current
  patches; reassess that finding after the environment policy is corrected, before delegating
  a source repair. Do not accept the interrupted report file as a successful review.
