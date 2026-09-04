# CT-04A Operator Feedback and Design Review Disposition

Status: **Accepted by Operator**  
Adoption date: 2026-07-26  
Parent milestone: `CT-04A — Trusted Git boundary and repository registration`  
Reviewed proposed plan: `work-items/CT-04/CT-04A-proposed-implementation-plan.md`  
Reviewed plan SHA-256: `575df9d9caf427661696f747f6083dc8fa6adce81a3a7785db125b6b8791ddcb`  
Independent review: `review-findings/CT-04/CT-04A-design-review.md`  
Source baseline: `abc5f37815ad76430cae989224afde817d77a047`  
Review checkout / protected-package pin: `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`  
Protected acceptance SHA-256: `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64`  
Primary implementer: Codex / GPT 5.6 Sol  
Independent design reviewer: Claude Code / Opus 5  
Operator: Keith Sanders  

## 1. Purpose of this document

This document records the operator's disposition of the CT-04A independent design review and establishes the next planning sequence. It is intended to be read together with:

1. the original CT-04A proposed implementation plan;
2. the independent CT-04A design review; and
3. the parent CT-04 process protocol and protected acceptance specification.

It is **not** an accepted implementation plan and does not authorize source-code implementation.

Its immediate purpose is to direct the implementer to produce a new, source-specific proposal for a narrower first slice:

```text
CT-04A1 — Trusted Git inspection boundary
```

The second slice:

```text
CT-04A2 — Repository registry and project binding
```

will be planned only after CT-04A1 has been implemented, independently reviewed, accepted, and merged into the CT-04 integration branch.

## 2. Overall operator disposition

The independent review is accepted as a **narrow fail requiring design revision**, not as a rejection of the proposed architecture.

The following parts of the original proposal are affirmed and should survive the revision unless a later source-grounded review finds a concrete defect:

- a closed internal `FixedGitCommand` union rather than an arbitrary command/argv carrier;
- a constructed child-process environment rather than cloning and scrubbing `process.env`;
- no shell execution;
- bounded stdout and stderr;
- deadline, termination, and partial-output rejection;
- exact primary-checkout admission;
- repeated path and repository admission before durable registration;
- no remote Git operations;
- no branch, worktree, diff, agent, check, review, or merge behavior in CT-04A;
- explicit treatment of SQLite `MATCH SIMPLE` and nullable ownership dimensions;
- authorization before host inspection;
- state, audit, and workspace-event writes before post-commit notification.

The original unified CT-04A proposal is **not authorized for implementation** because the corrected scope crosses the process split threshold and contains two independently reviewable assurance domains:

```text
A. Safe observation through a local Git / filesystem / process boundary.
B. Authorized and durable registration of those observations into
   workspace-owned state, audit, events, bindings, and browser projections.
```

The operator therefore adopts the A1/A2 split described below.

## 3. Process learning adopted for CraftingTable

Development contracts are allowed to **fan out further during source-specific planning**.

A parent milestone or slice is not required to remain a single implementation unit merely because the original planning package gave it one identifier. If Phase A reveals materially larger scope, multiple assurance domains, or a change crossing too many architectural layers, the implementer must propose decomposition rather than silently expanding the generation.

The governing rule is:

> Decomposition is recursive. A work contract may be decomposed during architecture planning, and any child may be decomposed again when source-specific planning exposes a safer or more coherent boundary.

This is not planning failure. It is a normal result of learning from the actual source.

The following triggers require an explicit split proposal:

- more than roughly 60 changed files;
- multiple new authority boundaries;
- a major schema change plus substantial browser behavior;
- more than three architectural layers changing together;
- an implementation plan whose proof obligations cannot be reviewed independently;
- a change whose failure domains require materially different adversarial matrices;
- any recurrence of the CT-03 pattern in which a release-sized change is disguised as one agent generation.

## 4. Adopted CT-04A decomposition

### 4.1 Parent milestone remains CT-04A

`CT-04A` remains the parent milestone and retains the original end-to-end objective:

> CraftingTable can safely inspect an existing local primary Git repository and durably register and bind that repository within the correct workspace.

The numbering and scope of `CT-04B` through `CT-04E` remain unchanged.

### 4.2 CT-04A1 — Trusted Git inspection boundary

CT-04A1 owns only the host-observation boundary:

```text
untrusted requested path
    ↓
path admission
    ↓
fixed Git operation
    ↓
constructed child environment
    ↓
bounded process execution
    ↓
strictly parsed repository observation
```

Expected scope:

- `packages/git/**`;
- Git-specific fixtures and test support;
- the forbidden-scope checker changes needed to permit process execution only inside the reviewed Git package;
- the trusted-Git-boundary ADR;
- pure Git configuration types and parsing where they do not make the daemon depend on Git at startup;
- path admission and canonicalization;
- repository-class inspection;
- fixed command construction;
- executable and version validation;
- environment construction;
- process timeout, termination, and output limits;
- repository identity observations;
- ownership refusal;
- external-execution feature observations;
- field-level comparison of current and recorded observations;
- real-Git and purpose-built process-fault fixtures.

CT-04A1 must expose an observational interface conceptually similar to:

```ts
interface RepositoryInspector {
  inspect(request: RepositoryInspectionRequest):
    Promise<RepositoryObservation>;
}
```

The result may report structural observations and field-level differences. It must not decide durable application semantics such as:

- `active`;
- `identity-evidence-changed`;
- `identity-mismatch`;
- Owner reaffirmation;
- retirement;
- project binding;
- audit actions;
- workspace events.

Those belong to CT-04A2.

CT-04A1 expressly excludes:

- domain repository records;
- public HTTP contracts;
- SQLite migration 0003;
- repository registration routes;
- project binding;
- audit and workspace events;
- browser projection or activity rendering;
- a hard Git or repository-root dependency in normal daemon startup;
- any CT-04B-or-later behavior.

### 4.3 CT-04A2 — Repository registry and project binding

CT-04A2 will consume the accepted CT-04A1 interface and own:

- repository domain records and wire contracts;
- migration 0003;
- durable repository and inspection evidence;
- repository state transitions;
- registration, reinspection, reaffirmation, retirement, and binding;
- explicit binding retirement / unbind;
- authorization;
- audit;
- workspace events and structural correlation;
- post-commit notifier ordering;
- browser workspace-event projection and activity rendering;
- operator-facing Git feature configuration;
- end-to-end parent CT-04A protected acceptance cases.

CT-04A2 may not:

- import `node:child_process`;
- construct Git arguments;
- interpret raw Git output;
- perform its own filesystem admission;
- weaken the A1 process environment or bounds;
- create a second Git execution path.

The dependency rule is:

> CT-04A2 may request a repository observation. It may not know how Git produced it.

### 4.4 Parent acceptance remains authoritative

The protected cases do not all partition perfectly into isolated A1 and A2 cases. Some require both the host inspector and durable service path.

Therefore:

- CT-04A1 receives internal and protected-equivalent cases for the Git/process/path boundary;
- CT-04A2 receives the storage, authorization, journal, state-machine, and browser cases;
- the **complete original CT-04A protected acceptance suite remains the parent exit gate** after A2 is integrated.

CT-04A must not be marked complete after A1 alone.

### 4.5 Further decomposition remains available

CT-04A2 must perform a fresh source-grounded Phase A after A1 is accepted. If its corrected scope again crosses the process threshold, it must propose another split, likely between:

```text
CT-04A2
    domain, contracts, migration, storage, and state machine

CT-04A3
    service, routes, notifier, authorization, browser projection,
    and operator-facing lifecycle
```

No such split is pre-authorized now. It must be justified from the accepted A1 source and the actual A2 plan.

## 5. Required operator decisions

The following decisions resolve the review's operator-choice section.

| Review decision | Operator disposition |
|---|---|
| Split CT-04A? | **Yes.** Adopt A1/A2 as described above. |
| Identity evidence tiers | Exclude `st_dev` from terminal identity. Track it as evidence. A `dev`-only change becomes non-terminal `identity-evidence-changed`, blocking mutation until explicit Owner reaffirmation. Core Git/path/object-format or inode changes remain terminal mismatch. |
| Journal correlation | Rebuild `workspace_events` in migration 0003 to add structural `repository_id` correlation with workspace ownership enforcement and preserved sequence semantics. Payload-only correlation is rejected. |
| Keep repository retirement? | **Yes.** Keep explicit Owner retirement with a full acceptance group. Retirement remains distinct from ordinary recovery. |
| Add binding-retire / unbind? | **Yes.** Add explicit Owner/Editor binding retirement. Repository retirement must not be the only way to correct a binding. |
| Registration audit policy | Reuse a single `repository.register` action with existing `outcome` values (`succeeded`, `denied`, `failed`) and bounded metadata. |
| Hard Git / root startup dependency? | **No.** A1 is an injected library boundary. When A2 activates the feature, the daemon must still be able to run planning-only workloads without configured Git roots; repository operations report a typed feature-unavailable state. |
| Repositories not owned by daemon UID | Refuse with a classified, actionable `ownership-refused` result. No `safe.directory` escape hatch is introduced in CT-04A. |

## 6. Finding dispositions

### F-01 — Protected-spec gate uses the wrong comparison pin

**Decision:** Accepted.

Required change:

- distinguish the source baseline from the protected-package pin;
- compare `protected/**` against `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4`;
- preserve the literal protected checksum in the plan;
- add a negative probe proving a modified scratch copy is rejected.

A1 owns this process correction because it is the next implementation slice.

### F-02 — Target tree omits forced browser and projection changes

**Decision:** Accepted and assigned to A2.

The A1 split removes all event-kind, storage-mapper, and browser-projection changes from A1.

The future A2 plan must explicitly include:

- `packages/storage/src/repositories/workspace-events.ts`;
- `apps/web/src/lib/workspace-projection.ts`;
- its projection tests;
- `apps/web/src/components/ActivityPanel.tsx`;
- strict exhaustive switching with no permissive default branch;
- explicit stale-scope behavior for every new repository event.

A2 adds no new repository views unless its contract says so, but it necessarily extends event projection and activity rendering.

### F-03 — Git version floor is too low

**Decision:** Accepted.

A1 must:

- require at least Git `2.32.0`;
- document the feature contribution of each floor: object format, absolute path format, and `GIT_CONFIG_GLOBAL`;
- treat absence of `HOME` as defense in depth rather than the primary control;
- reject synthetic `2.31.x`;
- test legitimate vendor suffixes as required by F-21.

### F-04 — `st_dev` creates noisy terminal identity mismatch

**Decision:** Accepted with modification.

A1 must return field-level identity observations and comparison results. It must not assign durable repository states.

The target evidence model is:

```text
Core identity evidence
    canonical top-level
    canonical common Git directory
    object format
    inode evidence for top-level and common Git directory

Environmental evidence
    device IDs
```

A2 will apply these policies:

- `dev`-only delta with all core evidence unchanged → `identity-evidence-changed`;
- mutation blocked while evidence is changed;
- explicit Owner reaffirmation may accept the new device evidence without changing `RepositoryId` or active bindings;
- inode, canonical-path, Git-common-directory, or object-format delta → terminal `identity-mismatch`;
- delete the unimplementable claim that daemon startup can prove future `st_dev` stability.

### F-05 — Retirement lacks acceptance coverage

**Decision:** Accepted; retirement is retained in A2.

A2 must add named cases covering:

- role denial before host access;
- atomic repository and binding retirement;
- one notifier after commit;
- idempotent repeated retirement;
- inability to unretire or mutate a retired row;
- inability to bind or reactivate a retired repository;
- path and identity release only after retirement;
- fresh registration creates a new repository identity;
- direct-storage negative cases.

### F-06 — Cascading binding retirement has no event

**Decision:** Accepted.

A2 must add:

```text
project-repository-binding-retired
```

with strict payload containing:

- `projectId`;
- `bindingId`;
- `repositoryId`.

One event is emitted per retired binding in the same transaction. Events carry structural project and repository correlation. The browser projection must mark every affected project stale. One post-commit notifier wake is sufficient for the transaction.

### F-07 — Repository event correlation is payload-only

**Decision:** Accepted; choose schema rebuild.

Migration 0003 must rebuild the append-only workspace-event table using the established migration-0002 pattern and preserve:

- all prior rows;
- global sequence values;
- append-only triggers;
- indexes;
- catalog semantics;
- prior structural correlations.

It must add nullable `repository_id` with workspace-owned composite enforcement and appropriate kind/correlation checks. Repository-correlated events may not rely only on JSON payload discipline.

### F-08 — Worktree-scoped configuration is missed

**Decision:** Accepted with modification.

A1 will not add another Git command at this stage. Instead it will:

- include `extensions.worktreeConfig` in the local configuration-name scan;
- treat its presence as restrictive by itself;
- classify the repository as having later-mutation risk;
- document which surfaces are intentionally not enumerated and why the A1 read-only command set cannot activate them.

Future mutating slices must re-inspect all relevant execution surfaces before mutation.

### F-09 — Dubious ownership is unmodeled

**Decision:** Accepted.

A1 must expose `ownership-refused` as a typed result with actionable diagnostics and no raw Git stderr leakage.

Policy:

- only repositories acceptable under the daemon's normal ownership context are supported;
- no `safe.directory` configuration override is introduced;
- tests use a real ownership mismatch when the host permits it, with a deterministic proxy otherwise;
- the limitation is documented operationally.

### F-10 — Cross-workspace duplicate registration lacks service coverage

**Decision:** Accepted and assigned to A2.

A2 must distinguish:

```text
same workspace + same active identity
    idempotent success; return existing record; no duplicate event

foreign workspace + active identity
    non-disclosing conflict; no foreign ID or workspace information

foreign workspace + retired identity
    registration permitted if all current uniqueness rules pass
```

All paths require service-level tests in addition to direct database tests.

### F-11 — Registration observation is mislabeled as mutable policy

**Decision:** Accepted with modification.

Do not create an immutable table named `repository_policies`.

A2 should model append-only observation evidence, conceptually:

```text
repository_inspections
```

Each explicit registration or reinspection recollects identity and external-execution evidence and appends an immutable inspection record. The current repository projection may point at the latest inspection and expose `lastVerifiedAt`.

Mutable repository policy is deferred until a later slice first needs an actual operator-editable policy field.

An unchanged explicit inspection may update the current verification reference and audit evidence without creating a workspace state-change event.

### F-12 — Version columns lack transition rules

**Decision:** Accepted and assigned to A2.

A2 must require:

- every permitted state transition increments `version` by exactly one;
- a version-only update fails;
- same-status no-op updates do not occur;
- audit records carry prior and resulting versions where applicable;
- the transaction re-reads current state before applying a transition;
- concurrency behavior is explicitly documented and tested under the daemon's SQLite write model.

### F-13 — Composite membership FK admits revoked memberships

**Decision:** Accepted as a boundary clarification.

The database proves membership-row existence, not active membership or role.

A2 service authorization must enforce active membership and role before host access or mutation. Tests must include revoked members for repository and binding actors.

The accepted plan must not claim that the FK provides a guarantee it does not provide.

### F-14 — No way to correct a mistaken project binding

**Decision:** Accepted; add explicit binding retirement in A2.

Owner and Editor may retire an active project-repository binding. The operation must:

- leave other project bindings untouched;
- leave repository status and identity reservation untouched;
- emit the binding-retired event;
- audit the transition;
- be idempotent;
- preserve historical binding rows.

One repository may be actively bound to more than one project in the same workspace.

### F-15 — `active` lacks recency evidence

**Decision:** Accepted with modification.

A2 responses must expose the time of the most recent successful inspection. That may be derived from the latest immutable inspection record rather than stored as an unconstrained mutable timestamp.

Rules:

- explicit unchanged inspection records verification evidence and audit;
- no workspace state-change event is emitted when authoritative state is unchanged;
- CT-04A performs no automatic startup reconciliation;
- list/read operations report stored evidence and its age honestly.

### F-16 — Denied and failed registration audit policy is undefined

**Decision:** Accepted.

Use one audit action:

```text
repository.register
```

with the established outcome field:

```text
succeeded | denied | failed
```

Rules:

- role denial is audited before host inspection and produces zero inspector calls;
- classified path/Git failures are audited without success state or events;
- metadata is bounded;
- metadata contains no repository configuration values, environment data, credentials, or raw subprocess stderr;
- the exact path-disclosure policy must be fixed in the A2 plan and tested.

### F-17 — Unified scope crosses the split trigger

**Decision:** Accepted with modification.

Adopt the A1/A2 split in this document. Preserve CT-04A as the parent. Do not finalize A2's source-specific plan until A1 has landed.

The full parent protected suite remains the final exit gate.

### F-18 — Git and roots become hard daemon startup dependencies

**Decision:** Accepted with modification.

A1 is an injected library and testable boundary; it does not change normal server startup.

A2 must preserve planning-only operation without configured repository roots or Git feature activation. Repository operations should expose a typed unavailable/configuration result when the feature is not configured.

The daemon must not become unusable for CT-01 through CT-03 workflows merely because repository registration is unconfigured.

### F-19 — State-machine and direct-storage claims lack tests

**Decision:** Accepted and assigned to A2.

The A2 plan must add explicit proof for:

- `unavailable -> active` with the same identity;
- reappearance with changed core identity → mismatch, never active;
- bind rejection against every non-active state at service and storage boundaries;
- inspection evidence immutability;
- identity and ownership immutability;
- row deletion rejection;
- transition reversal rejection;
- retirement irreversibility;
- nullable and revoked-membership dimensions;
- concurrent duplicate registration and concurrent inspection outcomes.

### F-20 — Display name is unbounded and underspecified

**Decision:** Accepted and assigned to A2.

Rules:

- 1–120 characters;
- reject control characters, including newline and tab;
- omitted name defaults to repository basename only if that basename passes the same validation;
- otherwise require an explicit valid name;
- immutable in CT-04A because no rename operation is included.

### F-21 — Version parser and prompt-test limitation

**Decision:** Accepted and assigned to A1.

A1 must parse:

```text
leading `git version <major>.<minor>[.<patch>]`
```

and ignore legitimate trailing vendor content.

Tests must include plain, Apple, and Windows-style version strings plus malformed and unsupported cases.

The credential/prompt test remains a purpose-built process proxy because the accepted A1 read-only Git commands cannot naturally provoke a real credential prompt. That limitation must be stated explicitly.

### F-22 — Diagram and source-assessment presentation defects

**Decision:** Accepted.

The A1 proposal must:

- redraw the dependency diagram correctly;
- record the source-assessment drift concerning the README phase label;
- retain only claims verified against the current checkout.

## 7. Coverage-gap disposition

The review's coverage-gap section is accepted as an input to the revised planning sequence.

### A1 must prove

- Git version and vendor parsing;
- fixed command selection;
- argument and option-injection resistance;
- constructed environment;
- no inherited Git override variables;
- ownership refusal;
- path/root/symlink admission;
- primary-checkout-only classification;
- local external-execution feature observation;
- `extensions.worktreeConfig` restrictive classification;
- timeout, termination, and independent output overflow;
- malformed and invalid UTF-8 output rejection;
- exact field framing;
- raw identity evidence and field-level comparison;
- no partial success after process failure;
- no hard daemon startup dependency.

### A2 must prove

- repository and workspace ownership;
- active-membership and role enforcement;
- same-workspace idempotency and foreign-workspace non-disclosure;
- immutable inspection evidence;
- evidence-change and mismatch state transitions;
- Owner reaffirmation preserving ID and bindings;
- repository retirement;
- binding retirement;
- full audit outcome policy;
- structural event correlation;
- browser projection and activity exhaustiveness;
- post-commit notifier ordering;
- durable replay after missed notifier;
- migration sequence preservation;
- direct-SQL negative matrix;
- optimistic transition/version rules;
- exact display-name rules;
- no startup reconciliation claim;
- unchanged inspection behavior;
- parent CT-04A end-to-end cases.

## 8. Required planning and implementation sequence

The following sequence is authoritative.

### Step 1 — Preserve review evidence

Commit or otherwise durably record:

- the original proposed implementation plan;
- the independent design review;
- this operator disposition.

Do not rewrite those historical artifacts when the new A1 plan is created.

### Step 2 — Produce CT-04A1 proposed implementation plan

The implementer must perform a fresh read-only source inspection and produce:

```text
work-items/CT-04/CT-04A1-proposed-implementation-plan.md
```

The proposal must:

- follow the A1 boundary in this disposition;
- reconcile every A1-assigned review finding;
- contain an exact source tree and scope estimate;
- contain an A1-specific acceptance and adversarial matrix;
- state every production Git command and environment field;
- define the observational output and error model;
- define what remains intentionally deferred to A2;
- include a finding-reconciliation appendix;
- stop without modifying production source.

### Step 3 — Focused independent A1 design review

A fresh reviewer session evaluates only:

- the trusted process boundary;
- path admission;
- Git command/version/environment policy;
- ownership policy;
- identity observation and comparison semantics;
- external-execution observation;
- A1 scope and file budget;
- A1 protected proof coverage.

The reviewer must not redesign A2.

### Step 4 — Operator disposition of the A1 review

The operator accepts, modifies, rejects, or escalates each new A1 finding and records the disposition using the repository's design-review-disposition template.

### Step 5 — A1 accepted plan

The implementer produces:

```text
work-items/CT-04/CT-04A1-accepted-implementation-plan.md
```

with a reconciliation appendix mapping:

```text
review finding
    → operator disposition
    → accepted-plan section
    → proof cases
```

Implementation remains unauthorized until the operator approves and commits the accepted plan.

### Step 6 — Implement, verify, review, and accept A1

The implementer implements A1 in one bounded generation unless the accepted A1 plan itself triggers another split.

After a stable commit:

- deterministic verification runs against the exact head;
- an independent exact-head code review runs;
- remediation addresses invariant classes rather than isolated lines;
- any new commit invalidates prior review and verification evidence;
- the accepted A1 result merges into the CT-04 integration branch.

### Step 7 — Produce source-grounded A2 package

Only after A1 is accepted should the A2 source assessment and implementation proposal be produced.

The A2 plan must consume the actual accepted A1 API and error model. It must not assume interfaces from the original unified proposal.

### Step 8 — Reapply the split trigger to A2

A2 Phase A must recalculate:

- files changed;
- architectural layers;
- schema complexity;
- browser surface;
- authority boundaries;
- proof obligations.

If it crosses the threshold, propose A2/A3 before implementation.

### Step 9 — Complete the parent CT-04A gate

After the durable registry and binding path are integrated, run the complete original CT-04A protected acceptance suite against the composed A1+A2 implementation.

Only then may CT-04A be marked complete and CT-04B begin.

## 9. Required content of the CT-04A1 proposal

The A1 proposal must include, at minimum:

1. source baseline and protected-package pin as separate facts;
2. exact current seams in `packages/git`, testing, server composition, and scope checks;
3. corrected dependency diagram;
4. exact A1 file tree and scope estimate;
5. fixed Git command union;
6. Git executable resolution and `2.32.0` floor with vendor parsing;
7. constructed environment and defense-in-depth notes;
8. timeout and output bounds;
9. path/root/symlink policy;
10. daemon-UID ownership policy;
11. primary-checkout-only policy;
12. repository observation schema;
13. core versus environmental identity evidence;
14. current external-execution observation boundaries;
15. field-level comparison semantics without durable application states;
16. typed error taxonomy;
17. real-Git fixtures and process-fault proxies;
18. A1 adversarial matrix;
19. protected-spec immutability gate using the correct pin;
20. explicit exclusions and A2 handoff contract;
21. reconciliation of F-01, F-03, F-04's A1 portion, F-08, F-09, F-17, F-18, F-21, and F-22.

## 10. Re-review scope after this disposition

The original review requests a short re-review of the identity state machine, event catalog/correlation, and corrected tree if F-04, F-06, F-07, and F-17 were accepted.

The adopted split changes that sequence:

- A1 receives a focused design review of the trusted Git observation boundary and evidence model;
- A2 later receives a separate design review of the durable state machine, migration, event catalog/correlation, authorization, and browser projection;
- the original unified proposal is not sent back for a monolithic re-review.

This preserves independent review while preventing A1 from being blocked on speculative A2 schema design.

## 11. Authorization boundary

Upon operator adoption, this document authorizes the implementer to produce the **CT-04A1 proposed implementation plan only**.

It does not authorize:

- source-code implementation;
- migration 0003;
- HTTP routes;
- public contracts;
- repository state or bindings;
- event-kind changes;
- browser changes;
- CT-04A2 planning beyond explicit handoff notes;
- CT-04B-or-later behavior.
