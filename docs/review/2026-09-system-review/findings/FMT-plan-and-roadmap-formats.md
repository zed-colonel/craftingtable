# FMT — Plan and roadmap formats (ground truth) review

Reviewer area: the plan-bundle format, the concurrency-map v0.3 format, the saved roadmap definition,
and every place the daemon consumes them. Read-only review at `main` @ `bf08c0b` (2026-09-22).
Live DB inspected read-only (`plan_versions`, `work_items`, `concurrency_definitions`,
`concurrency_bindings`, `roadmap_definitions`, `roadmaps`).

Legend used throughout the specification:

| Code | Meaning |
| --- | --- |
| **V** | validated only (import/save rejects or warns), not read afterwards |
| **D** | displayed only (browser UI / API projection) |
| **C** | copied into agent context (brief text, `sourceFields` JSON, materialized plan documents, `craftingtable-scope-evidence.json`) — a form of "displayed", but to agents |
| **A** | drives automation (the "where" is given) |
| **I** | ignored (retained verbatim at most) |

---

## Summary

- There are **three formats**, not two: (1) the plan bundle / `exo-work-breakdown-v1` work breakdown,
  (2) the `cross_stack_concurrency_map` v0.3 ZIP, and (3) the saved **roadmap definition** (plus the
  map **binding revision** and roadmap **operational state** that sit beside it). A fourth, implicit
  format — the AQ/WI/EXO *supplement documents* (case matrices, `aq-baseline.lock.json`,
  `worker_provider_planning_reference`) — is also interpreted by the map validator
  (`packages/planning/src/concurrency.ts:376-458`).
- The plan-bundle format is small, well-bounded, deterministic and well tested (ADR-011/012). Its
  weaknesses are minor: an unbounded `phase` field that the database rejects (FMT-08), silent
  truncations (FMT-14), dead "recognized field" constants and discarded top-level projections
  (FMT-12), and transport-dependent digests (FMT-13).
- The concurrency map is **not a generic format**. The application-owned schema hard-requires the
  AQ-baseline stack shape: an `implemented_upstream` repository and `aq_baseline_binding`, at least
  two merge locks (so ≥2 planned applications), a `previous_definition` snapshot, ≥1 acceptance case,
  `aq_baseline_case_ids`, `requires_kata_host`, and an ID grammar stricter than the plan grammar
  (FMT-05). A single-repository plan cannot be sliced; a first-ever map cannot be written without
  fabricating a "previous" map. The future Development Studio cannot generate this format for any
  project that is not the AQ/WI/EXO stack.
- Many automation features are enabled by **matching prose or magic identifiers** in the imported
  map rather than typed fields: `STACK-PLAN-ACCEPTED` + four exact English requirement strings
  (including "approval of CS-D01 through CS-D18" and "WI/EXO"), the architecture-decision review
  contract (three exact strings + role `repository-maintainer`), evidence profile id
  `contract-checkpoint`, resource ids `isolated-development-workspace` / `controlled-native-test-host`,
  reviewer role `independent-security-reviewer-if-required-by-source` (which silently gates the
  security-review workflow), a `review`/`independent-reviewer` role whitelist that exists only for
  test fixtures, and a regex on the free-prose `source_maturity` (FMT-04).
- The daemon has **no compiled model of a map**. 22 server service files read raw
  `definition.source.*` (~157 direct accesses) and each re-derives semantics (FMT-01). The same
  semantic is implemented several times with drift:
  requirement satisfaction ×3 (FMT-02), required-dependency enforcement ×6 (FMT-09), parent evidence
  producers ×4 and scope requirement/case sets ×3 (FMT-10), milestone graph ×2 with a
  **demonstrated divergence**: an import-valid map on which `targetClosure` throws
  "Circular retained milestone requirements" (FMT-03).
- Effective roadmap automation (`integrationMerge`/`integrationConflicts`) is resolved three
  different ways; the notification service and the integration-refresh path ignore the new
  `delegationAssignments` (added in `bf08c0b`), so a delegation change can produce spurious
  "awaiting merge" attention or suppress a needed one (FMT-07). This is a direct instance of the
  operator's "notifications while the controller transitions" pain point.
- The "Studio seam" (`analyzeConcurrencyDefinition`, ADR-049) has no server caller and yields a
  **different digest** (canonical-JSON) from the ZIP path (raw YAML bytes) for the same definition,
  so a Studio-submitted copy of an imported map would be recorded as a revision *conflict* (FMT-11).
- The only Cargo build adapter is wired to the format: every valid map has an implemented upstream,
  Start requires a runtime generation, and runtime discovery requires Cargo/rustc and matches
  `aq_baseline_binding.crate_version` (FMT-06).
- Operator decision points are implicit in the formats (inferred from checkpoint `kind` plus prose
  signatures, all-or-nothing map adoption, `deferred_decisions` ignored) — a root cause of the
  scattered decision UI (FMT-19). STACK-PLAN-ACCEPTED evidence is bound to a digest of the whole
  roadmap definition, so any queued-settings edit re-asks that operator decision (FMT-17).
- Tests: the planning package and the real map fixture are well covered, but the execution-layer
  tests (`server-execution.test.ts`) insert **hand-built definitions that the importer would reject**
  (FMT-15). There is one real map fixture and no minimal generic map.
- There is no in-repo written specification of either format; the closest is the external
  `IMPORT-SPEC.md` inside the fixture ZIP, which itself warns that "a generic production importer
  should … [supply] plan-specific invariants through a separately reviewed contract rather than
  hardcoding" (FMT-12). The specification section below is intended to become that document.

---

## Map

### Components and sizes

| Layer | Files | Lines (non-test) | Responsibility |
| --- | --- | --- | --- |
| `packages/planning` | `bundle.ts`, `parse.ts`, `normalize.ts`, `graph.ts`, `digest.ts`, `limits.ts`, `diagnostics.ts`, `exo-work-breakdown-schema.ts`, `archive.ts`, `plan-archive.ts`, `concurrency.ts`, `concurrency-schema.ts` (1 558 lines of inline JSON Schema) | 4 314 | Pure parsing/validation: plan bundle analysis, safe YAML, ZIP reader, plan-ZIP selection, map schema + semantic validation, digests |
| `packages/domain` (format part) | `planning.ts`, `concurrency-source.ts` (TS mirror of the schema), `concurrency-graph.ts` (`concurrencyMilestones`, `targetClosure`), `concurrency-amendment.ts` (fingerprints/diff), `roadmap.ts`, `cross-project.ts`, `execution-scope.ts`, `imports.ts`, `map-amendment.ts` | 1 123 | Types + the milestone model used for closures/amendments |
| `packages/contracts` | `planning.ts`, `roadmap.ts`, `cross-project.ts`, `package-imports.ts`, `execution-scope.ts` | — | Zod wire schemas (roadmap save, cross-project config, map node view) |
| `packages/storage` | `repositories/planning/*`, `repositories/imports.ts`, `roadmaps.ts` | — | Immutable `plan_versions`, `work_items`, `work_item_dependencies`, `plan_artifacts`, `concurrency_definitions.record_json` (~330 KB JSON, parsed on every `definition()` call), `concurrency_bindings`, `roadmap_definitions` (immutable revisions), `roadmaps.state_json` |
| Server consumers | `plan-import-service`, `package-import-service`, `execution-scope`, `cross-project-service`, `runtime-evidence-policy`, `plan-acceptance-policy`, `build-verification-policy`, `architecture-decision-policy`, `phase-resources`, `map-*-policy`, `native-verification-policy`, `technical-checkpoint-policy`, `roadmap-delegation-policy` (4 326 lines) + large readers in `roadmap-service` (2 292), `runtime-evidence-service` (2 632), `work-cycle-service` (4 029), `map-amendment-service` (697), `workflow-policy`, `brief.ts`, `agent-run-service` | — | Binding, scope resolution, phase gates, evidence, closure → roadmap entries, briefs |

### Data flow

```text
Plan bundle (multipart discrete files)  ─┐
Plan ZIP  → inspectPlanArchive/preparePlanArchive ─┴→ analyzePlanBundle (parse → normalizePlan → analyzePlanGraph → digest)
   → PlanImportService: project / plan_bundle / plan_version(immutable, normalized_source_json = raw top level)
     / plan_artifacts(bytes) / work_items(sourceFields = raw item) / work_item_dependencies(required|recommended)
     / plan_archive_links (ZIP path)

Map ZIP → analyzeConcurrencyArchive → readArchive → strict YAML → analyzeConcurrencyDefinition
          (Ajv schema → semantic checks incl. source snapshots/supplements → validator milestone DAG)
   → PackageImportService: import_archives, concurrency_definitions(immutable), archive_import_attempts
   → operator saves binding revision (alias → exact plan version [+ its branch settings] | upstream repository)
   → CrossProjectService.adopt (all decisions) → map_adoptions
   → CrossProjectService.save: targetClosure(definition, target, selection) → RoadmapEntry[] with executionScope
       (slice:started → 'slice', slice:verified → 'slice-verification', work_item:accepted → 'parent-acceptance';
        checkpoints and slice:merged produce no entry)
   → RoadmapService.save → roadmap_definitions revision N (immutable) + roadmaps.state_json (operational)
   → scheduler / WorkCycleService / ExecutionService consult execution-scope.ts phase gates,
     runtime-evidence-policy (evidence, prerequisites), phase-resources (reservations),
     cross-project-service (milestone satisfaction), briefs (scope text, sourceFields JSON, plan documents)
```

### Live data (read-only snapshot)

- 5 plan versions: AQ-CONT-1 v1 (14 items, 24 required edges), WI-FABRIC-2 v1/v2 (14/38),
  EXO-V3 v1/v2 (19/68). Top-level keys actually used by authors go far beyond the recognized set
  (`plan_revision`, `aq_gates`, `critical_path`, `maturity_labels`, `aq_baseline_alignment`,
  `worker_execution_profile`, …); item keys include `aq_baseline_acceptance_cases`, `aq_gate`,
  `maturity`, `sequence`, `implementation_plan_section`, `worker_execution_scope`.
- 1 concurrency definition `EXO-STACK-CONCURRENCY-DRAFT-1` rev `0.3.0` (digest `51563f70…`):
  3 repositories, 30 source files, 18 decisions, 15 evidence profiles, 95 checkpoints (58
  `architecture_decision`), 33 parents, 69 slices, 3 resource profiles, 76 acceptance cases, 48
  baseline cases, 3 planning targets; validator graph 335 nodes / 1 221 edges.
- 4 roadmaps; the cross-project roadmap `b81d5f92…` is `paused`, 11 definition revisions, each with
  **171 entries** (69 development + 69 verification + 33 acceptance), `prioritize-full` on
  `FULL-STACK-RELEASE`, `parentAcceptance: automatic`, no overrides, no `delegationAssignments` yet,
  one `agentAssignments` row, `scopeRecovery.enabled = true`.

---

## Format specification (the invariant any refactor must preserve)

### 1. Plan bundle

#### 1.1 Transports

**Discrete multipart** (`POST …/plans/import`, `apps/server/src/routes/planning.ts:110`):
the multipart **field name is the role**; the filename is a label only.

**Plan ZIP** (`packages/planning/src/plan-archive.ts`): archive read in memory by `readArchive`
(`archive.ts`; stored/deflate only, single disk, no ZIP64, UTF-8/ASCII names, ≤8 MiB compressed,
≤32 MiB expanded, ≤2 MiB/member, ≤512 entries, no links/special files, no traversal, no
case-insensitive duplicate paths, CRC/size checked, no file-used-as-directory). The operator selects
one `implementationPlan` path and one `workBreakdown` path; they must be in the **same directory**
and not under a path segment named `provenance`, `archive`, `source-snapshots` or `__MACOSX`.
The UI only offers candidates matching `/implementation-plan\.md$/i` and
`/work-breakdown\.ya?ml$/i` (`plan-archive.ts:218-223`; API accepts any path). Every file with an
accepted extension **in that same directory**, except `*.sha256`, becomes an artifact: the two
selected files take the required roles, **all others become `supporting`**
(`plan-archive.ts:252-287`). A package manifest (`SHA256SUMS` or `*.sha256` in that directory) is
applied only if it names the selected plan file; then every listed member must match
(`plan-archive.ts:257-278`). All selected members must be valid UTF-8. The original ZIP bytes are
retained separately (`import_archives`) and linked (`plan_archive_links`). The ZIP must be
previewed; import re-checks `archiveDigest` (`package-import-service.ts:107`).

#### 1.2 Artifacts and limits

| Item | Rule | Class |
| --- | --- | --- |
| Roles | `implementation-plan` (exactly 1, must be Markdown), `work-breakdown` (exactly 1, must be YAML), `assumption-ledger`, `validation-manifest`, `decision-log` (≤1 each, any accepted class), `supporting` (≤60) — `packages/domain/src/planning.ts:31-45`, `limits.ts:99-102` | roles other than the two required: **D + C** only (no code treats them specially; `ImportPlanPage.tsx:15-17` labels them) |
| Filenames | NFC, trimmed, 1–200 chars, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no trailing `.`/`-`, accepted extension `.md .markdown .yaml .yml .json .txt .sha256`, unique case-insensitively (`bundle.ts:122-164`) | V |
| Media type | canonical type derived from extension; declared type must be in an allowlist (octet-stream tolerated) | V (canonical type enters the digest) |
| Size | ≤64 artifacts, ≤2 MiB each, ≤8 MiB total, non-empty (`limits.ts:19-29`); multipart fields ≤8, parts ≤80, field value ≤512 B | V |
| `.sha256` artifacts | lines `^<64 hex> [ *]<name>$`; a listed submitted file must match (error), an unlisted name is a warning (`bundle.ts:171-214`) | V |
| `.json` artifacts | must `JSON.parse` | V |
| `.yaml` artifacts | must be safe single-document YAML (see 1.3) | V |
| Markdown | bytes preserved, never interpreted; dependencies are never inferred from prose | C (materialized for agents as plan documents, `agent-run-service.ts:737`) |

**Digest v1** (`digest.ts`): SHA-256 over `"craftingtable-plan-bundle-digest-v1" 0x00 u32(count)` then,
sorted bytewise by (role, filename), `u32 len role | role | u32 len name | name | u32 len mediaType |
mediaType | u64 len bytes | bytes`. Withheld if any submitted artifact was rejected.
**A**: plan-version identity; `UNIQUE(workspace_id, content_digest)` makes re-import idempotent
(`duplicate` outcome, no new rows).

#### 1.3 YAML safety (`parse.ts`)

YAML 1.2 `core` schema, no custom tags, `strict`, `uniqueKeys`; any parser error **or warning** is
fatal; exactly one document; aliases bounded (`maxAliasCount` 100) at materialization; depth ≤32,
nodes ≤20 000; keys `__proto__`/`constructor`/`prototype` rejected; non-finite numbers rejected.
The map path additionally uses `strictReferences` (no aliases, anchors, explicit tags, merge keys or
non-string keys).

#### 1.4 Work breakdown — source profile `exo-work-breakdown-v1`

Only profile; stored as `plan_versions.source_profile` with a CHECK constraint.

**Top level** (`normalize.ts:246-461`, `exo-work-breakdown-schema.ts`)

| Field | Rule | Class |
| --- | --- | --- |
| `document` | required, non-empty string; trimmed; **silently truncated to 300** | **D** (plan version title, project name default sliced to 120, `plan-version-imported` event) |
| `pull_requests` | required list; empty → error `missing-work-items`; >2000 → error | **A** (work items) |
| `repository`, `baseline_commit`, `contract`, `stack_revision`, `status`, `phase` | projected into `NormalizedPlan` then **discarded** (no reader anywhere) | **I** |
| `clean_break`, `integration_branch`, `tag`, `release_order`, `forbidden_release_symbols` | listed in `RECOGNIZED_TOP_LEVEL_FIELDS` but not projected; constant is dead code | **I** |
| every other key | retained verbatim in `plan_versions.normalized_source_json` (never read back) | **I** (the work-breakdown file itself is **C** as a plan document) |

**Work items** (`pull_requests[]`)

| Field | Rule | Class |
| --- | --- | --- |
| `id` | required string; NFC+trim; ≤64; `^[A-Za-z0-9][A-Za-z0-9._-]*$`; unique within the version (duplicates error, item skipped) | **A**: identity within the version; dependency resolution; map binding (`source_item_id`) |
| `title` | required non-empty string; **silently truncated to 300** | **D + C** (brief heading, roadmap entry title for whole-item entries) |
| `depends_on` | **key required**; `null` or list of well-formed ids; ≤64 entries; must resolve in the same version; no self edge; acyclic (iterative DFS, ≤20 cycles reported); duplicates de-duplicated with warning | **A**: readiness SQL (`storage/…/planning/index.ts:619-620`), roadmap blocker (`roadmap-service.ts:1942`), sequential save ordering (`roadmap-service.ts:611`), automation start (`work-cycle-service.ts:3845`), merge ancestry (`branch-service.ts:395`), scope phase gates (`execution-scope.ts:131`); also **C** |
| `recommends` | optional; `null` or id list; unknown id → warning and dropped; never blocking | **D + C** |
| `risk` | required non-empty string; lower-cased; `low|medium|high|critical` else `unspecified` + warning; raw kept in `sourceFields` | **D + C** (no automation) |
| `primary_areas` | **key required**; list of strings; **silently capped to 32 entries × 64 chars**; `[]` allowed | **D + C** (no automation, not used for exclusion) |
| `exit_gate` | required non-empty; **silently truncated to 1000** | **C** (brief "Exit gate:") + **D**; the automated gate uses the reviewer-reported `exitGate.met`, not the text |
| `phase` | optional string, **no length bound** (DB/contract require ≤64 — FMT-08) | **C** (brief) + API only |
| any other key (`status`, `sequence`, `maturity`, `aq_gate`, `aq_baseline_acceptance_cases`, …) | retained verbatim in `work_items.source_fields_json` | **C** (full JSON in every brief, cut at 20 000 chars, `brief.ts:175-178,290-300`) and **V/A for maps**: `source_record_sha256` fingerprints the *entire* raw record; `aq_baseline_acceptance_cases` is compared to the map's `aq_baseline_case_ids` (`concurrency.ts:290-293`) |

Ordinal (source array position) is display order only. Readiness vocabulary:
`planning-ready | dependency-blocked | active | completed`.

**Stable diagnostic codes** (part of the import response): `too-many-artifacts`,
`total-size-exceeded`, `unknown-artifact-role`, `invalid-logical-filename`, `unsupported-media-type`,
`artifact-too-large`, `empty-artifact`, `duplicate-logical-filename`,
`artifact-role-format-mismatch`, `required-artifact-missing`, `duplicate-artifact-role`,
`checksum-mismatch` (error), `checksum-unmatched-entry` (warning), `invalid-yaml`,
`multiple-yaml-documents`, `yaml-too-complex`, `unsupported-yaml-scalar`, `unsafe-yaml-key`,
`invalid-work-breakdown`, `missing-work-items`, `too-many-work-items`, `invalid-work-item-id`,
`duplicate-work-item-id`, `invalid-work-item-field`, `unrecognized-risk` (warning),
`self-dependency`, `missing-required-dependency`, `duplicate-required-dependency` (warning),
`unknown-recommended-dependency` (warning), `required-dependency-cycle`. Sorted by content, ≤500.

#### 1.5 Persistence and versioning invariants

Project → one `plan_bundle` family → immutable `plan_versions` (no-update/no-delete triggers).
First import sets `activePlanVersionId`; later versions never silently replace it (ZIP import may
activate explicitly only with an expected-active check and an idle project,
`package-import-service.ts:119-148,213-248`). Failed imports retain artifacts and diagnostics with
no plan version and no workspace event.

---

### 2. Concurrency map v0.3 (`cross_stack_concurrency_map`)

#### 2.1 Container and identity

- ZIP (same `readArchive` profile). Exactly one member anywhere whose basename is
  `cross-stack-concurrency-map.yaml`; its directory is the **root** for `snapshot_path`s
  (`concurrency.ts:72-83`). Other members are inert (scripts, schemas, reports never run).
- Strict YAML (1.3 + `strictReferences`); normalized JSON ≤2 MiB.
- Schema: the application-owned JSON Schema 2020-12 in `concurrency-schema.ts`, compiled once with
  Ajv (`strict: true`, **`allErrors: false`** — only the first schema error is reported, ≤20).
  `additionalProperties: false` everywhere; string fields generally `maxLength: 16000`; arrays
  `maxItems: 2000`.
- **Digest**: ZIP path = SHA-256 of the raw YAML bytes (`concurrency.ts:92`); direct-definition path
  = SHA-256 of canonical JSON (`concurrency.ts:543`) — see FMT-11.
- Identity `(map_id, revision)`: same pair + same digest → `duplicate`; different digest →
  `conflict` (`package-import-service.ts:275-286`). Definition row immutable.
- Import never creates executable entries; the definition is an inactive draft
  (`summary.executable: false`).

#### 2.2 Top-level fields

| Field | Rule | Class |
| --- | --- | --- |
| `$schema` | const `cross-stack-concurrency-map.schema.json` | V |
| `document` | 1–16000 | D (summary) |
| `kind` | const `cross_stack_concurrency_map` | V |
| `schema_version` | const `0.3.0` | V |
| `map_id` | 1–200 | A (identity/conflict), D |
| `revision` | 1–200 | A (identity), V (vs previous), D |
| `status` | const `draft` | V |
| `created_date` | `YYYY-MM-DD` | V |
| `automatic_activation` | const `false` | V |
| `terminal_checkpoint` | checkpoint id, must exist | A (`published` flag, `cross-project-service.ts:343`) |
| `limitations[]` | ≥1 string | D |
| `deferred_decisions[]` | `{id ^[A-Z][A-Z0-9-]+$, title, source_due, reason}`, ids unique | V only (never surfaced) |

#### 2.3 `source_files[]` (≥1) and `source_archives[]` (≥1)

| Field | Rule | Class |
| --- | --- | --- |
| `source_files[].id` | unique, ≤200, no control chars | A (reference target) |
| `.original_path` | safe path | **A**: binding matches a plan artifact by **basename** + sha (`package-import-service.ts:410-415,480-481`); D |
| `.snapshot_path` | safe path; `root + snapshot_path` must exist in the ZIP with matching sha | V |
| `.sha256` | 64 hex | A (binding exactness) / V (snapshot) |
| `.format` | `markdown|yaml|json`; non-markdown snapshots parsed as strict YAML and become "content" for supplement checks | V |
| `.role` | const `source_only_not_an_importable_plan` | V |
| `.repository` | known alias | A (per-repo source set) |
| `source_archives[]` | `{repository, filename, sha256, artifact_revision}`; exactly one per repository | V; `sha256` compared to plan archive provenance → **warning** `archive-provenance-missing` only; D |

#### 2.4 `repositories[]` (≥1, ≤32 by semantic check)

| Field | Rule | Class |
| --- | --- | --- |
| `id` | alias, ≤128 (ids of parents/slices require `^[a-z][a-z0-9_-]*` prefix) | **A**: binding key, lanes, project-level override key, `repository` of milestones |
| `repository` | free text | D (name) |
| `contract`, `source_stack_label`, `runtime_revision_status` (`unbound|source-archive-pinned`) | — | I |
| `planning_profile`, `artifact_revision` | — | V (provider-reference check, `concurrency.ts:404-418`); `artifact_revision` also in plan-acceptance facts |
| `target_branch` | string or null; null required for upstream | V; D (suggested); warning if plan branch differs |
| `source_baseline_commit` | 40-hex or null | **A**: historical baseline ref (`baseline-preparation.ts:105`) |
| `source_plan`, `source_work_breakdown` | source-file ids | V (binding: artifact roles must be `implementation-plan`/`work-breakdown`) |
| `supplement_sources[]` | source-file ids | V (declared set must equal the repo's full source set) |
| `merge_lock` | lock id or null (null for upstream); must be a lock owned by this repo | V / A via slices |
| `role` | `implemented_upstream | planned_application` | **A**: upstream is non-runnable (no parents, no branch, no lock), binds a repository not a plan, supplies runtime pins (`runtime-evidence-policy.ts:178-200`) |

#### 2.5 `decisions[]` (≥1)

`{id ^[A-Z][A-Z0-9-]+$, title, proposed_resolution, source_notes[≥1], status: const proposed_requires_approval}`.
**A**: adoption must list **every** decision id (`cross-project-service.ts:393-401`); `decision_refs`
on slices/checkpoints gate phases/evidence until adopted; full adoption authorizes source early-start
rules (`execution-scope.ts:356-374`). `title`/`proposed_resolution` D. `source_notes` I (only in
amendment fingerprints).

#### 2.6 `semantics` (all required)

All members are consts (`requirement_operator: all_of`, `missing_or_stale_evidence: blocked`,
`slice_lifecycle: [started, merged, verified]`, `merge_inherits_start_requirements: true`, …,
`baseline_case_receipts_required: true`); `parent_acceptance` is free text.
**V only** — the semantics are hard-coded in the server; the block is an assertion that the
author expects exactly those semantics. Any other value or extra key rejects the import.

#### 2.7 `evidence_profiles[]` (≥1)

| Field | Class |
| --- | --- |
| `id` | A (referenced by slices/checkpoints; `work-item-exit` is a const for parents; `contract-checkpoint` is a magic id, FMT-04) |
| `required_evidence[]` (≥1 strings) | **A**: verbatim requirement strings that scope review evidence, evidence submissions and checkpoint attestations must each address (`execution-scope.ts:68-75`, `runtime-evidence-policy.ts:84-94`); also matched literally to enable plan/decision generators (FMT-04) |
| `reviewer_roles[]` (≥1) | **A**: review qualification gates (`execution-scope.ts:329-344`, `execution-service.ts:615-632`), allowed roadmap role assignments (`cross-project-service.ts:456-460`), independent-review requirement in submissions, security-review trigger by literal role (FMT-04) |
| `independence_required` | const `true`; V (also checked in `supportsArchitectureDecision`) |

#### 2.8 `scheduling_policy`

Consts `mode: eligibility_not_a_calendar`, `no_duration_or_speedup_estimates: true`,
`hold_merge_lock_while_waiting_for_checkpoint: false`, `recheck_before_merge: true` (V);
`suggested_focus_target` must be a planning target (V + D, never auto-selected);
`agent_capacity`, `resource_reservations`, `required_execution_isolation`, `priority_hint`,
`feedback_is_not_dependency`, `target_selection`, `resource_profile_binding` are prose (**I**).

#### 2.9 `resource_locks[]` (**minItems 2**) and `resource_profiles[]` (≥1)

| Field | Class |
| --- | --- |
| `resource_locks[].id` | A via `slices[].merge_lock` |
| `.repository` | A: merge phase requires `lock.repository == binding alias`, reservation key `repository:<rootPath>` capacity 1 (`phase-resources.ts:188-199`) |
| `.capacity` (const 1), `.stage` (const `merge`) | V |
| `.scope` | I |
| `resource_profiles[].id` | **A by magic id**: `isolated-development-workspace` → local-development/verification pool; `controlled-native-test-host` → local-verification only with native approval; any other id → authorization blocker "no managed execution adapter" (`phase-resources.ts:150-182`, `native-verification-policy.ts:32-60`) |
| `.description` | D |
| `.requires_hardware_virtualization` | A (Kata evidence requirement, blocks local adapters) |
| `.fixture_authorization_required` | A (blocks `isolated-development-workspace` adapter; requires external/native environment) |

#### 2.10 `checkpoints[]` (≥1)

| Field | Class |
| --- | --- |
| `id` `^[A-Z][A-Z0-9-]+$` | A (requirement target, evidence subject) |
| `title` | D |
| `kind` (`plan_approval, architecture_decision, contract, release_candidate, release, integration_evidence, semantic_review, profile, partial_milestone, baseline_acceptance`) | **A**: `plan_approval`/`architecture_decision` require full map adoption before evidence (`runtime-evidence-policy.ts:486-490`, `cross-project-service.ts:175-179`) and count as "local" for build policy; `architecture_decision` enables operator decision proposals/shared-decision routing (`architecture-decision-policy.ts:18-33`, `workflow-policy.ts:143-150`); `contract`/`profile`/`semantic_review` may use agent checkpoint review (`technical-checkpoint-policy.ts`, `runtime-evidence-service.ts:915-921`); `plan_approval` + exact prose enables generated plan evidence; others: external evidence only |
| `owner` | `stack` or a repository alias; A (tested repositories / pins, `runtime-evidence-policy.ts:117`) |
| `requires[]` | A (milestone edges; evidence prerequisites) |
| `evidence_profile` | A |
| `pass_criteria[]` | A (checkpoint evidence requirement strings); V (source-profile criteria preserved, previous contract/release criteria not dropped) |
| `source_refs[]` `{source_id, section, start_line?, end_line?}` | V (ids, line ranges ≤ snapshot line count); D; C |
| `status_on_import` (const `unresolved`), `invalidation` (const) | V |
| `decision_refs[]` | A (adoption gate) |
| `evidence_owners[]` | V only (must be parents; must match supplement) |
| `historical_producer_work_items[]` | I |

#### 2.11 `work_items[]` (parents, ≥1)

| Field | Rule | Class |
| --- | --- | --- |
| `id` | `^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*$` and must equal `<repository>/<source_item_id>` | A (scope identity, requirement target) |
| `repository` | planned application alias | A |
| `source_item_id` | must be an id in the bound work breakdown; every original item appears exactly once | **A** (binding to `work_items.source_id`) |
| `planning_order` | int ≥1 | **I** |
| `title` | must equal the source item title (raw) | V; D |
| `source_record_sha256` | must equal `sha256(canonical JSON of the raw source item)` — both at import and at binding | **A** (binding exactness) |
| `source_maturity` | free text | **A by regex** `/^independent\b/i` (build policy, `build-verification-policy.ts:11,39`) |
| `depends_on[]` | must equal the source item's `depends_on` (prefixed with alias) | V; A in domain milestone model (`concurrency-graph.ts:324,338`) and scope ledger; runtime gates use the *plan* edges |
| `primary_areas[]` (≥1), `risk` | must equal raw source values | V only |
| `source_exit_gate` | must equal raw source `exit_gate` | **A**: parent-acceptance evidence requirement + brief scope (`execution-scope.ts:72,575,587`) |
| `source_test_reference` `{source_id, section, start_line, end_line}` | V | C (brief `sources`), D |
| `required_slices[]` (≥1) | must equal the set of slices owned; acceptance must require each `verified` | A (parent acceptance, finalization) |
| `acceptance_requires[]` | must include `depends_on` parents accepted and required/profile/case producer slices verified | A |
| `acceptance_evidence_profile` | const `work-item-exit` | A |
| `source_profile_case_ids[]` | must equal cases owned in `acceptance_coverage` | A (parent case obligations) |
| `profile_evidence_slices[]` | slices | A (producers) |
| `aq_baseline_case_ids[]` | must equal source `aq_baseline_acceptance_cases` and owned baseline cases | A (cases; disables scoped build policy) |

#### 2.12 `slices[]` (≥1)

| Field | Rule | Class |
| --- | --- | --- |
| `id` | `^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*/[a-z][a-z0-9-]*$`, prefix = parent id | A (execution scope id; roadmap entry `sourceId`) |
| `work_item` | parent id | A |
| `title` | — | D; roadmap entry title; brief |
| `mode` | `domain|implementation|integration|conformance|release|release_readiness` | **A**: only `domain` and qualifying `implementation` get `scoped-checks` build policy (`build-verification-policy.ts:8-22`) |
| `scope` | text | **A**: the slice's exit gate/evidence requirement, brief |
| `excludes[]` (≥1) | — | C (brief), D, amendment fingerprint |
| `start_requires[]`, `merge_requires[]`, `verify_requires[]` | typed requirements; unique per list | **A** (phase gates; merge inherits start; verify inherits merge; implicit `started→merged→verified`) |
| `evidence_profile` | known profile | A |
| `merge_lock` | lock whose repository is the parent's | A (merge reservation) |
| `workspace_policy` | const `isolated-worktree-and-test-state` | V |
| `early_start_exception` | bool | **A**: removes implicit parent-predecessor barrier from `started` in the domain graph and, when adopted/authorized, from runtime start/merge/verify gates (not accept) |
| `source_refs[]` (≥1) | as checkpoints | V; C (brief context) |
| `decision_refs[]` | known decisions | A (adoption gate; early-dev authorization forbidden when non-empty) |
| `grants_effect_authority` | const `false` | V |
| `partial_scope` | `full|domain|embedded-proof|supervisor-proof` | **V only** (never read) |
| `resources_by_phase` `{start[≥1], merge[≥1], verify[≥1]}` | known resource ids | **A** (reservations, native/Kata gating) |
| `planning_target_class` | — | **I** |
| `aq_baseline_case_ids[]` | must equal baseline cases produced by this slice | A (cases; disables scoped build policy) |

#### 2.13 Requirement object (`$defs.requirement`)

Exactly one of `{kind: work_item, id: <parent>, state: accepted}`,
`{kind: slice, id: <slice>, state: started|merged|verified}`,
`{kind: checkpoint, id: <checkpoint>, state: passed}`. Milestone key `kind:id:state`.

#### 2.14 Coverage and targets

| Field | Class |
| --- | --- |
| `acceptance_coverage[]` (≥1) `{id, source_id, source_record_sha256, checkpoint, owner_work_item, producing_slices[≥1], requires_kata_host, evidence_status_on_import: unresolved}` | **A**: case obligations for slices (producers), parents (owner) and checkpoints; case evidence must carry the exact `source_record_sha256`; `requires_kata_host` adds a verify blocker and a Kata-environment evidence requirement (`execution-scope.ts:282-296`, `runtime-evidence-policy.ts:346-363`). V: source case record, owner (`owner_pr`), checkpoint and Kata flag must match the supplement document |
| `baseline_acceptance_coverage[]` `{id, source_id, source_record_sha256, owner_work_item, producing_slice, capability_gate, status_on_import}` | A (as above; checkpoint cases filtered by the candidate slice) |
| `planning_targets[]` (≥1) `{id, checkpoint, scope, is_release}` | `id`/`checkpoint` **A** (closure root); `scope`, `is_release` D |

#### 2.15 `previous_definition` and `aq_baseline_binding` (both required)

| Field | Class |
| --- | --- |
| `previous_definition.{revision, snapshot_path, sha256, archive_sha256, approval_inherited:false}` | **V only**: snapshot must exist/hash-match/parse; its `revision` must match; its upstream work items must equal `retired_work_items`; previous `contract`/`release` checkpoint criteria and requirements must be retained (with retired AQ parents replaced by the baseline acceptance checkpoint) (`concurrency.ts:461-506`) |
| `aq_baseline_binding.repository` | must be the `implemented_upstream` alias; **A** (runtime pin/evidence inputs) |
| `.archive_sha256` | must equal that repo's `source_archives` sha; V |
| `.source_tree_sha256`, `.source_tree_file_count`, `.conformance_package_revision`, `.implementation_commit` (const null) | V against each `source_lock_ids` snapshot; `conformance_package_revision` **A** (pin conformance identity, `runtime-evidence-service.ts:283-287,663`) |
| `.historical_pre_contract_commit` | **A** (runtime pin may not equal it) |
| `.crate_version` | **A** (every discovered Cargo package must have this version, `runtime-evidence-service.ts:270-278`) |
| `.acceptance_checkpoint` | must exist; **A** (evidence inputs pin only the upstream) |
| `.publication_checkpoint` | must exist; V |
| `.retired_work_items` | must not be runnable parents; V |
| `.source_status`, `.historical_commit_is_current_implementation_pin`, `.consumer_conformance_status`, `.publication_status`, `.active_work_item_count` (consts), `.contract`, `.retired_adr_checkpoints`, `.retired_deferred_decisions` | V / I |

#### 2.16 Implicit supplement-document semantics (validated from source snapshots)

`concurrency.ts:394-440`: any parsed snapshot with `cases[]` whose entries have `owner_pr` must be
covered exactly by map cases; `kind: worker_provider_planning_reference` documents must match the
owning repository's `planning_profile`, `artifact_revision` and per-file hashes; profile documents'
`checkpoints[].criterion` must appear in the checkpoint's `pass_criteria`, their `evidence_owners`
must match, and `requires_checkpoints` / `required_aq_gates_for_real_integration` must appear as
checkpoint requirements; lock documents must match the baseline fields.

#### 2.17 Semantic validation rules (all must pass; ≤100 diagnostics)

Unique ids per collection; repository limit 32; one source archive per repository; every source
file's repository known, paths safe, snapshot present and hash-exact, non-markdown parseable;
previous definition as above; no duplicate requirement within a phase list; each repository's
declared sources equal its full source set; upstream: no branch/lock/parents; planned: lock owned
and branch present; parent coverage/digest/title/exit gate/risk/areas/dependencies/baseline cases
equal the raw source; locks owned; parents on planned repos with a known profile, required slices
= owned slices, acceptance retains dependencies and producers, case ownership complete; slices
have a valid parent prefix, profile, lock repository, resources and baseline producers; checkpoint
owners/profiles/evidence owners known; cases reference known sources/owners/checkpoints and the
owner awaits every producer; supplement semantics (2.16); target checkpoints and terminal checkpoint
exist; every predecessor key exists and the **validator's** expanded graph is acyclic (see FMT-03
for how this graph differs from the domain model).

#### 2.18 Executed phase semantics (server, not format)

- Start: explicit `start_requires` + (unless early development is authorized/adopted) every
  original *plan* predecessor completed **and** map-accepted; adopted decision refs; binding,
  active plan, repository, amendment and runtime-pin checks; resources.
- Merge: start + `merge_requires` + a started run; merge-lock reservation; checkpoint evidence may be
  staged by architecture-decision clauses.
- Verify: merge + `verify_requires` + recorded slice merge + no active owning attempt + Kata case
  rule + reviewer qualification.
- Accept (parent): all plan predecessors accepted (no early exemption), `acceptance_requires`,
  every producer slice verified, every required slice merged and verified at its merge SHA, no
  active slice attempts, reviewer qualification, receipt with complete scope evidence
  (`scopeEvidenceIssues`).
- Satisfaction of `slice:*` milestones is observed from worktrees/runs/merges/receipts/accepted
  evidence; `checkpoint:passed` only from accepted evidence submissions; `work_item:accepted` from
  completion + a current parent-acceptance receipt.

---

### 3. Plan binding revision (operator-authored, per definition)

`ConcurrencyBindingRevision {definitionId, revision (1,2,…; latest is current), bindings[]}` with
`ConcurrencyPlanBinding {alias, projectId?, planVersionId?, repositoryId?, integrationBranch?,
branchSettingsVersion?, sourceArtifacts[{sourceId, artifactId, sha256}], workItems[{sourceId,
workItemId, sourceRecordDigest}]}` (`packages/domain/src/imports.ts:50-75`).
Rules (`package-import-service.ts:347-463`): upstream aliases bind an active registered repository
and no plan; planned aliases bind an exact plan version whose artifacts contain every source file
(basename + sha, correct primary roles) and whose items match every parent's `source_record_sha256`;
branch settings are copied if configured; different aliases must bind different plan versions;
optimistic `expectedRevision`. Every map-scoped execution identity carries `(definitionId,
bindingRevision)`; a newer binding revision supersedes older scopes. Adoption rows are per binding
revision.

---

### 4. Roadmap definition (saved roadmap entity)

#### 4.1 Immutable definition revision (`roadmap_definitions`)

`RoadmapDefinition {roadmapId, revision, name, crossProject?, entries[], scheduling?, automation?,
createdAt, createdByUserId}` (`packages/domain/src/roadmap.ts:63-74`, wire
`roadmapDefinitionSchema` in `contracts/src/roadmap.ts`).

| Field | Rule | Class |
| --- | --- | --- |
| `name` | 1–120 | D |
| `scheduling.mode` | `sequential|parallel` (default sequential; cross-project forced `parallel`); cannot change with in-flight attempts | **A** (scheduler order/concurrency) |
| `scheduling.maxInFlight` / `maxPerRepository` | 1–16 | **A** (`roadmap-service.ts:1979-2065`; per-repo limit takes the minimum across running roadmaps) |
| `scheduling.maxIntegrationRefreshes` | 1–20 | **A** (`work-cycle-service.ts`) |
| `automation.{integrationMerge, integrationConflicts}` | `manual|automatic` | **A** (delegated merges / conflict resolution) — resolved inconsistently (FMT-07) |
| `automation.resolutionProfile` | agent profile | A (conflict resolution agent) |
| `crossProject` | see 4.3 | A |

#### 4.2 Entries (1–100 via the manual save route; unbounded via cross-project save — live: 171)

Input (`roadmapEntryInputSchema`): `id` (uuid), `workItemId`, `executionScope?` `{kind:
slice|slice-verification|parent-acceptance, definitionId, bindingRevision, sourceId}`,
`reviewerRoles?` (cross-project only), `profiles` (design/implement/review/remediate + optional
specialists), `policy` `{maxNits 0–100, maxRemediationRounds 0–20, maxRunMinutes 1–1440}`,
`instructions` (≤16000), `automation?`, `exclusionGroups?` (≤20 unique, manual roadmaps).
Frozen by the server at save: `projectId`, `planVersionId`, `sourceId` (slice id or plan id),
`title`, `repositoryId`, `integrationBranch` (from plan branch settings).

| Field | Class |
| --- | --- |
| order of `entries` | **A** (sequential order; parallel priority; cross-project = closure order) |
| `workItemId`, `executionScope` | **A** (what is executed; completion: slice → merged, verification → verified, acceptance → accepted, whole item → attempt completed) |
| `profiles` | **A** (agent selection at launch; superseded by operational `agentAssignments`, `agent-profile-policy.ts`) |
| `policy` | **A** (cycle completion limits) |
| `instructions` | **C** (cycle instructions / brief) and recorded as operator guidance (`operator-decisions.ts`) |
| `automation` | **A** (see FMT-07) |
| `reviewerRoles` | **A** (reviewer qualification; security-review trigger) |
| `exclusionGroups` | **A** (exclusion-blocked) |
| frozen `repositoryId`/`integrationBranch` | **A** (blocker if plan branch settings drift) |
| `title`, `sourceId`, `projectId`, `planVersionId` | D / identity |

Save rules (`contracts/src/roadmap.ts:44-73`, `roadmap-service.ts:509-650`): unique entry ids and
scopes; a work item cannot mix whole-item and scoped entries or two map bindings; started entries
keep identical settings and (sequential) their leading order; sequential roadmaps must order
in-roadmap required predecessors first; plan branch settings and an active repository are
required; manual roadmaps may only delegate `slice` scopes and may not set reviewer roles; roadmaps
with a pending amendment or `crossProject` cannot be edited through the plain form.

#### 4.3 Cross-project configuration

`CrossProjectConfiguration {definitionId, bindingRevision, targetId, selection:
target-only|prioritize-full, parentAcceptance: manual|automatic, defaults: MapActivitySettings,
overrides[{level: project|activity|individual, key, settings}]}` with `MapActivitySettings
{reviewerRoles?, profiles, policy, instructions, automation}`.
Entries are **generated** by `CrossProjectService.save` (`cross-project-service.ts:443-575`) from
`targetClosure`: `slice:started` → development (`slice`), `slice:verified` → verification
(`slice-verification`), `work_item:accepted` → acceptance (`parent-acceptance`); checkpoint and
`slice:merged` milestones produce no entries (checkpoints are satisfied only by accepted evidence).
Settings resolve defaults → project (alias) → activity → individual (`activity:sourceId`), each
override replacing the whole settings set; started entries keep their prior settings; a
`started` without its `merged` in the closure is rejected. Reviewer roles must be declared by some
evidence profile. Target/selection/binding cannot change except via a reviewed amendment.
`parentAcceptance` **A** (automatic acceptance recording, `roadmap-service.ts:1248`,
`notification-service.ts:268`).

#### 4.4 Operational state (mutable `roadmaps.state_json`, outside the definition)

`status`, `version`, `reason`, `attempts[]` (frozen `definitionRevision`, reserved worktree/cycle,
`recovery`, `dependencyRefresh`), `entryHolds`, `delegationAssignments[]` (automation + reviewer
roles per entry set), `agentAssignments[]` (model selections), `decisionPreparations[]`,
`scopeRecovery`. These change automation without a new definition revision.

---

## Findings

### FMT-01: No compiled format model — 22 services re-interpret raw map JSON
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence: 157 direct `*.source.{work_items,slices,checkpoints,evidence_profiles,…}` accesses in
  22 server files (top: `runtime-evidence-policy.ts` 28, `runtime-evidence-service.ts` 21,
  `package-import-service.ts` 18, `cross-project-service.ts` 17, `execution-scope.ts` 13,
  `plan-acceptance-policy.ts`, `build-verification-policy.ts`, `architecture-decision-policy.ts` 9
  each). Lookups are linear `find`/`filter` over 69 slices / 95 checkpoints / 76+48 cases inside
  per-node loops (e.g. `crossProjectState` evaluates `scopePhaseBlockers` for each of 335 nodes).
  `storage/src/repositories/imports.ts:15,149` `JSON.parse`s the ~330 KB `record_json` on every
  `definition()` call outside a `mapReadSnapshot`.
- Impact: every semantic rule of the format exists in several hand-written variants (FMT-02, 03, 09,
  10), so a change to one rule (or a format v0.4) must be found and made in many places; drift is
  already present. Maintainers cannot answer "what does field X do" without a repo-wide grep. The
  parse/scan cost is paid per read (performance impact is a HYPOTHESIS; the snapshot cache
  mitigates it only inside read passes).
- Recommendation: add a pure `CompiledMap` in `packages/planning` (or `domain`) built once per
  `(definitionId, digest)` and cached for the process lifetime (definitions are immutable):
  id-indexed maps, per-slice phase requirement lists (with inheritance already applied), parent
  producer set, scope requirement/case sets, resource needs per phase, milestone graph, closure
  function. Expose a pure `evaluate(milestone, observations)` where `observations` is a port the
  server implements (slice started/merged/verified, checkpoint evidence accepted, parent accepted).
  Migrate services to it one by one behind golden tests (see Remediation direction).
- Effort: L
- Related: FMT-02, FMT-03, FMT-09, FMT-10, controller simplification (pain point 3)
- Plan/roadmap format impact: none (internal model of the existing format).

### FMT-02: Requirement satisfaction is implemented three times, with drift
- Severity: high
- Category: bug / architecture
- Status: CONFIRMED (divergences confirmed by reading; runtime consequences HYPOTHESIS)
- Evidence:
  - `execution-scope.ts:212-281` (`scopePhaseBlockers`: phase gates),
  - `runtime-evidence-policy.ts:471-585` (`prerequisiteIssues`: evidence prerequisites),
  - `cross-project-service.ts:48-89` (`milestoneSatisfied`: supervisor view, roadmap completion
    `roadmap-service.ts:1855-1890`).
  Differences: `prerequisiteIssues` filters owning worktrees by raw field comparison and does not
  exclude amendment-retired worktrees for `started`, while the others use `sameExecutionScope`
  (retired trees still count as "started" there); `scopePhaseBlockers` passes the merge
  `candidateScope` to `acceptedEvidence` and honours `stagedDecision` for checkpoints,
  `prerequisiteIssues` honours `stagedDecision` only for slice subjects and never passes a
  candidate scope, `milestoneSatisfied` honours neither (the view re-adds decision coverage
  separately, `cross-project-service.ts:113-136`).
- Impact: the supervisor graph, the phase gate and the evidence prerequisite can disagree about the
  same milestone (e.g. a checkpoint satisfied by staged clauses for one slice shows as unsatisfied in
  the view; a retired attempt satisfies `started` in one path but not another). The operator sees a
  node "Waiting for requirements" while automation proceeds, or vice versa — the "minutes working
  out dependencies" pain point.
- Recommendation: one pure evaluator over the `CompiledMap` (FMT-01) with an explicit context
  argument (`phase`, `candidateScope`, `stagedCoverage`) and one server-side observation adapter.
  Before refactoring, capture golden outputs of all three functions over the fixture map plus
  synthetic observation sets to prove equivalence (and to decide deliberately where they should
  differ).
- Effort: M
- Related: FMT-01, FMT-03, FMT-10
- Plan/roadmap format impact: none.

### FMT-03: Validator milestone graph differs from the domain milestone model (demonstrated)
- Severity: medium
- Category: bug
- Status: CONFIRMED (reproduced with (review-session analysis script, not retained) against built `dist`)
- Evidence: the validator builds its DAG from explicit lists only (`concurrency.ts:217-232`); the
  domain model used by `targetClosure`, amendments and the supervisor adds implicit edges:
  slice `started` requires every parent `depends_on` accepted unless `early_start_exception`, and
  parent `accepted` requires all producer slices from `acceptance_coverage`/`baseline_…`
  (`packages/domain/src/concurrency-graph.ts:311-343`). Reproduction: take the live map, remove
  the explicit `work_item` requirement from `wi/WI-03/integration.start_requires`, and add
  `{slice wi/WI-03/integration verified}` to `wi/WI-02/integration.start_requires` →
  `analyzeConcurrencyDefinition` accepts it with 0 diagnostics, while
  `targetClosure(…,'FULL-STACK-RELEASE','prioritize-full')` throws
  `Circular retained milestone requirements.` The current live map is unaffected only because its
  authors listed every parent predecessor explicitly on every non-early slice (verified:
  0 slices rely on the implicit edge).
- Impact: an importable (and adoptable/bindable) map can make the cross-project view, save,
  amendment preview and completion throw a generic error after import. A Studio-generated map that
  relies on the documented implicit barrier ("merge inherits start", original parent barriers) would
  hit this.
- Recommendation: build the validator's cycle check from `concurrencyMilestones` (single graph
  definition) and keep the extra reference checks. Add a regression test with the reproduction
  above.
- Effort: S
- Related: FMT-01, FMT-02
- Plan/roadmap format impact: none (tightens import to match existing semantics; maps already valid
  under both remain valid — the live map and fixture pass).

### FMT-04: Automation features are enabled by matching prose and magic identifiers in the map
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - Generated plan evidence: `plan-acceptance-policy.ts:14-46` requires checkpoint id
    `STACK-PLAN-ACCEPTED`, `kind plan_approval`, owner `stack`, and the profile's
    `required_evidence` to equal four English strings including *"approval of CS-D01 through
    CS-D18, or a separately versioned replacement definition"* and *"exact WI/EXO application
    project/plan-version bindings and the immutable implemented AQ source/build dependency
    binding"*, `pass_criteria` equal to three sentences and reviewer roles `['stack-integration-owner']`.
    `cross-project-service.ts:251-254,283-290,315-319` hard-codes the same checkpoint id for the "plan acceptance
    pending" setup requirement.
  - Operator architecture decisions: `architecture-decision-policy.ts:12-33` requires three exact
    evidence strings and the single role `repository-maintainer`; `workflow-policy.ts:143-150` and
    `:176-192` downgrade `shared-decision` questions to `work-item` when this signature is absent.
  - Delegated checkpoint review: `runtime-evidence-service.ts:915-921` — non-delegated recovery
    only for `kind === 'contract' && evidence_profile === 'contract-checkpoint'`.
  - Security review: `work-cycle-service.ts:2272-2280,2305-2308` and `workflow-policy.ts:159`
    trigger/permit the separate security review only if the roadmap assigns the literal role
    `independent-security-reviewer-if-required-by-source`.
  - Reviewer qualification bypass: `execution-scope.ts:338-339`, `execution-service.ts:618-621`
    treat a single role `review` or `independent-reviewer` as always satisfied. Neither appears in
    the live map; `independent-reviewer` appears only in `server-execution.test.ts` fixtures.
  - Resources: `phase-resources.ts:153,165`, `native-verification-policy.ts:37,58`,
    `runtime-evidence-service.ts:2025` key on ids `controlled-native-test-host` and
    `isolated-development-workspace`.
  - Build policy: `build-verification-policy.ts:11,39` classifies parents with the regex
    `/^independent\b/i` over the free-prose `source_maturity` (live values include
    "Independent classification; reference implementations depend on WI-06/WI-09" and
    "independent/mixed", both of which match). Replaying the policy over the live map
    ((review-session analysis script, not retained)) shows it is currently conservative only because such parents also
    own `integration` slices.
- Impact: a Development Studio (or a human) producing a semantically equivalent map with different
  wording, ids or role names silently loses plan-acceptance generation, operator decision routing,
  checkpoint delegation, native verification and the security review — without any diagnostic. A
  one-word edit to a reviewer role disables a safety review. The test-only role whitelist is an
  undeclared bypass of reviewer qualification for any map that uses those role names.
- Recommendation: (1) immediately move every recognizer into one `map-capabilities` module with a
  named function per capability and a table-driven test over the fixture, and surface on the
  definition detail page which capabilities were recognized ("Plan-acceptance generator: supported /
  not supported because …"); (2) remove the `review`/`independent-reviewer` whitelist and give the
  execution tests real reviewer assignments; (3) as a last resort (Appendix A) add typed fields in a
  format revision (`evidence_profiles[].review_contract`, `resource_profiles[].adapter`,
  `reviewer_roles` with `purpose: security`, `slices[].verification_mode`) and keep the v0.3
  string recognizers only as a compatibility profile.
- Effort: M (centralize + surface), L (typed fields)
- Related: FMT-05, FMT-06, FMT-15, FMT-19
- Plan/roadmap format impact: step (1)/(2) none; step (3) is a format revision (Appendix A).

### FMT-05: The concurrency-map format is hard-wired to the AQ/WI/EXO stack shape
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence: `concurrency-schema.ts` requires `aq_baseline_binding` (`:1279`, required list `:1467`),
  `previous_definition` (`:1124`), `resource_locks` **minItems 2** (`:511`),
  `acceptance_coverage` minItems 1 (`:1246`), `decisions`/`checkpoints`/`planning_targets` ≥1,
  `aq_baseline_case_ids` on every parent and slice, `requires_kata_host` on every case, parent id
  grammar `^[a-z][a-z0-9_-]*/[A-Z][A-Z0-9_-]*$` (`:697`) and `acceptance_evidence_profile` const
  `work-item-exit` (`:805`). Semantic checks require the baseline repository to be
  `implemented_upstream` with a matching archive (`concurrency.ts:441-460`), each planned repository
  to own a distinct merge lock (so ≥2 planned applications), a parseable previous map whose upstream
  items equal `retired_work_items` (`:461-506`), and interpret AQ/WI-specific supplement keys
  (`owner_pr`, `worker_provider_planning_reference`, `required_aq_gates_for_real_integration`,
  work-breakdown `aq_baseline_acceptance_cases`; `:290-293,376-440`).
- Impact: (a) slices, phase gates, checkpoints and evidence exist **only** for multi-repository
  stacks with an implemented Rust upstream; a single application cannot be decomposed into slices;
  (b) a first map requires a fabricated previous definition; (c) plan ids like `ct-04a1` or
  `CT-04A.1` (valid plan ids) cannot be mapped; (d) the Studio cannot generate maps for new projects.
  The external spec shipped with the map says generic importers should not hard-code
  plan-specific invariants (`IMPORT-SPEC.md` §11).
- Recommendation: keep v0.3 as-is for the existing plans (ground truth). Define a v0.4 profile
  (Appendix A) in which `aq_baseline_binding`→optional generic `upstream_bindings[]`,
  `previous_definition` optional, lock/coverage minimums 0, AQ-prefixed fields renamed, supplement
  checks moved into declared, typed "supplement profiles", and the ID grammar aligned with the plan
  grammar. Dispatch on `schema_version` into two validators that produce the same `CompiledMap`.
- Effort: L
- Related: FMT-04, FMT-06, FMT-11, Appendix A
- Plan/roadmap format impact: new format version; v0.3 must remain accepted unchanged.

### FMT-06: Runtime pinning is Cargo-only and forced on every map
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence: every valid map has an `implemented_upstream` (FMT-05); Start is blocked until a
  runtime generation exists when an upstream exists (`cross-project-service.ts:304-326`,
  `runtime-evidence-policy.ts:443-452`); runtime discovery rejects repos without "publishable Cargo
  packages" and requires `cargo`/`rustc` and `crate_version` equality
  (`runtime-evidence-service.ts:268-298`); `requiredUpstreams` also makes planned applications
  referenced by start/merge requirements upstream pins of their consumers
  (`runtime-evidence-policy.ts:178-200`). ADR-047 names Cargo as "the first build adapter", but
  nothing in the format declares the build system. The e2e test fabricates a Cargo crate at
  version `0.2.0` to satisfy the fixture (`e2e/package-imports.spec.ts:20-24`).
- Impact: no non-Rust stack can reach Start through the cross-project path; the Studio cannot
  describe a TypeScript or Python upstream.
- Recommendation: add a per-repository `build_system` (or `dependency_adapter`) notion to the
  runtime layer, defaulting to `cargo` for v0.3 maps; allow maps without upstream pins to skip the
  runtime-generation blocker. Format change only in v0.4.
- Effort: M
- Related: FMT-05; runtime/evidence reviewer area
- Plan/roadmap format impact: v0.4 optional field; none for v0.3.

### FMT-07: Effective roadmap automation is resolved three different ways
- Severity: medium (latent; high once delegation assignments are used)
- Category: bug / reliability
- Status: CONFIRMED by code; no live `delegationAssignments` yet (feature added in `bf08c0b`)
- Evidence: `roadmap-delegation-policy.ts:10-24` (`effectiveDelegation`: assignment ?? entry ??
  definition ?? default) is used by the scheduler (`roadmap-service.ts:1309,2192`);
  `work-cycle-service.ts:3191-3198` (integration refresh eligibility) uses entry ?? definition ??
  default; `notification-service.ts:256-275` (attention suppression for awaiting-merge/conflicts)
  uses entry ?? definition — neither consults `delegationAssignments`.
- Impact: if the operator changes delegation to `automatic`, the notification service still raises
  "awaiting merge" attention that the scheduler then clears by merging (a notification fired during
  an automated transition — pain point 3). If changed to `manual` over a definition that says
  `automatic`, the scheduler waits for a manual merge while the notification service suppresses
  the attention, so the item waits silently. Integration refresh for sequential roadmaps follows
  the old policy.
- Recommendation: route all three through `effectiveDelegation` (bound to the attempt's frozen
  definition revision, as the scheduler does) and add a test that applies an assignment and asserts
  identical decisions in scheduler, notification and refresh.
- Effort: S
- Related: controller/notification reviewers; FMT-01
- Plan/roadmap format impact: none (roadmap definition semantics clarified).

### FMT-08: Work-item `phase` is unbounded in the normalizer but ≤64 in the database and wire contract
- Severity: medium
- Category: bug
- Status: CONFIRMED (normalizer accepted a 120-char phase with no diagnostic, (review-session analysis script, not retained));
  the resulting HTTP status is a HYPOTHESIS (likely 500)
- Evidence: `normalize.ts:401` (`optionalString`, no limit) vs `work_items.phase CHECK (phase IS NULL
  OR length(phase) <= 64)` (live schema) and `contracts/src/planning.ts:161` (`max(64)`);
  `PLAN_LIMITS` has no phase bound; `storage/src/repositories/planning/index.ts:493` inserts as-is.
- Impact: a plan with a long `phase` passes preview and fails the import transaction with a storage
  constraint error instead of an actionable diagnostic; nothing is recorded (the failure path is
  skipped because analysis succeeded). A generator writing descriptive phases would hit it.
- Recommendation: add `maxPhaseLength: 64` to `PLAN_LIMITS` and emit `invalid-work-item-field`
  (or truncate with a warning, matching title/exit-gate behaviour) — prefer an error to stay
  honest; add a normalizer test.
- Effort: S
- Related: FMT-14
- Plan/roadmap format impact: documents an existing implicit limit (no existing plan affected;
  live plans have no `phase`).

### FMT-09: Required-dependency (`depends_on`) enforcement is duplicated in six places
- Severity: medium
- Category: architecture / reliability
- Status: CONFIRMED
- Evidence: storage readiness SQL (`storage/…/planning/index.ts:619-620`), roadmap save ordering
  (`roadmap-service.ts:611-624`), roadmap blocker incl. "predecessor has an in-flight attempt"
  (`roadmap-service.ts:1941-1962`), automation start (`work-cycle-service.ts:3844-3855`), merge
  ancestry (`branch-service.ts:393-415`), scope phase gates requiring *both* plan completion and map
  parent acceptance (`execution-scope.ts:131-152`). Each applies `scopeAllowsEarlyDevelopment`
  differently (e.g. the roadmap blocker applies it even to `slice-verification` entries; ancestry
  skips only uncompleted predecessors). The map additionally carries its own `depends_on` (validated
  equal to the plan) and the domain graph adds implicit edges from it (FMT-03).
- Impact: changing the dependency rule (e.g. a recommended edge becoming blocking, or a new
  early-start rule) requires six coordinated edits; inconsistent blocker messages appear in
  different panels for the same dependency.
- Recommendation: one `dependencyBlockers(item, scope, purpose)` policy returning typed reasons,
  consumed by all six; the storage SQL remains an index but its semantics are tested against the
  policy.
- Effort: M
- Related: FMT-02, FMT-01
- Plan/roadmap format impact: none.

### FMT-10: Producer sets and scope requirement/case sets are re-derived in several places
- Severity: low
- Category: simplification
- Status: CONFIRMED
- Evidence: parent evidence producers computed in `concurrency-graph.ts:312-321`,
  `execution-scope.ts:641-653`, `native-verification-policy.ts:41-60`, and implied by validator
  checks (`concurrency.ts:315-319,371-375`). Scope requirements/cases: `scopeRequirements`/`scopeCases`
  (`execution-scope.ts:68-87`), `subjectRequirements` (`runtime-evidence-policy.ts:33-104`, adds
  checkpoint `pass_criteria` and candidate filtering), and `scopedReviewIssue`
  (`execution-scope.ts:563-582`) which checks only the scope/exit-gate requirement (used for the
  slice merge gate, `execution-service.ts:413-423`, and cycle decisions) while `scopeEvidenceIssues`
  requires all profile evidence and cases (receipts, checkpoint candidates).
- Impact: the two-level evidence rule (merge needs the scope requirement; verification/acceptance
  need all) is real behaviour but undocumented and encoded by which helper each call site picks.
- Recommendation: fold into `CompiledMap.scopeSpec(scope)` returning `{mergeRequirements,
  verificationRequirements, cases, producers}` and document the rule in the format spec.
- Effort: S
- Related: FMT-01
- Plan/roadmap format impact: none.

### FMT-11: The "Studio seam" is unused and produces a different definition digest
- Severity: medium
- Category: architecture / bug
- Status: CONFIRMED ((review-session analysis script, not retained): ZIP path `51563f70…`, definition path
  `b9e3a907…` for the same source)
- Evidence: `analyzeConcurrencyArchive` returns `sha256(yaml bytes)` (`concurrency.ts:92`);
  `analyzeConcurrencyDefinition` returns `sourceRecordDigest(source)` (`:543`). No server code calls
  `analyzeConcurrencyDefinition` (only tests). Definition identity/conflict compares digests
  (`package-import-service.ts:283`); the digest also feeds decision binding digests and saved-plan
  facts. Authoring still requires source snapshots of every plan file inside the ZIP with hashes, a
  previous definition, and archive hashes of the plan packages; binding matches plan artifacts by
  basename (`package-import-service.ts:410-415`), so two supplements with the same basename in one
  repository cannot be bound and any added/changed text file in the plan directory forces a new plan
  version and a new map. Ajv runs with `allErrors: false` (`concurrency.ts:31`), so authoring feedback
  is one schema error at a time.
- Impact: ADR-049's promise that ZIP and future Studio "produce the same immutable definition" is
  not true today; a Studio-submitted copy of an imported map would be a `conflict`. Generation of maps
  is impractical (provenance bundling, basename coupling, single-error feedback).
- Recommendation: define one canonical digest (canonical JSON of the normalized source) for both
  entrypoints, keeping the raw YAML sha as `archive provenance` only; migrate existing rows by
  storing both (additive column) rather than rewriting history. Add a server entry that accepts a
  normalized definition plus references to *already imported plan versions* (their artifact ids)
  instead of embedded snapshots; switch Ajv to `allErrors: true` with a cap.
- Effort: M
- Related: FMT-05, FMT-18, Appendix A
- Plan/roadmap format impact: digest definition changes for new imports (existing definition ids
  and digests must remain valid and comparable — requires a dual-digest transition).

### FMT-12: No in-repo format specification; dead and misleading format code/docs
- Severity: low
- Category: docs / dead-code
- Status: CONFIRMED
- Evidence: `RECOGNIZED_TOP_LEVEL_FIELDS`, `RECOGNIZED_WORK_ITEM_FIELDS`, `REQUIRED_WORK_ITEM_FIELDS`
  (`exo-work-breakdown-schema.ts:16-59`) have no importer (only `dist/`); the doc comment claims
  they list projected fields, but `clean_break`, `integration_branch`, `tag`, `release_order`,
  `forbidden_release_symbols`, item `status`/`repository` are not projected. `NormalizedPlan`
  projects `repository`, `baselineCommit`, `contract`, `stackRevision`, `status`, `phase`
  (`normalize.ts:439-458`) that nothing reads. ADR-012 states the planning package depends on
  `domain` and `yaml` only; it now depends on `ajv` and `node:zlib`. ADR-011 limits (12 files,
  10 supporting) are superseded by code (64/60) via ADR-043. The only prose specification of the map
  is the external `IMPORT-SPEC.md` inside the fixture ZIP.
- Impact: future agents and the Studio have no authoritative description of what is accepted and
  what each field does; misleading constants invite wrong assumptions.
- Recommendation: commit the "Format specification" section of this report as
  `docs/formats.md` (plan bundle, map v0.3, binding, roadmap definition, with the V/D/C/A/I table),
  delete the dead constants and unused projections, and amend ADR-012's dependency sentence.
- Effort: S
- Related: all
- Plan/roadmap format impact: none (documentation).

### FMT-13: The same plan imported by discrete upload and by ZIP gets different digests
- Severity: low
- Category: bug
- Status: CONFIRMED (by reading)
- Evidence: ZIP selection drops `*.sha256` files and forces every non-primary file to role
  `supporting` (`plan-archive.ts:252-287`); discrete upload accepts `.sha256` artifacts and lets the
  operator choose `validation-manifest`/`assumption-ledger`/`decision-log` roles. Role, filename and
  bytes are all digest inputs (`digest.ts:330-360`).
- Impact: duplicate detection (a stated ADR-011 goal) fails across transports; re-importing the AQ
  bundle as a ZIP creates a new version (and, for mapped plans, would break the exact binding). The
  optional roles have no behaviour beyond labelling.
- Recommendation: either document that transports produce distinct versions, or normalize: exclude
  checksum manifests from the digest in both paths (they are verification inputs, not plan content)
  and treat optional roles as labels outside the digest. Any change must keep existing digests
  valid (dual-digest or digest format version 2).
- Effort: S
- Related: FMT-11
- Plan/roadmap format impact: digest semantics (new format version if changed).

### FMT-14: Silent truncation of plan fields that agents treat as the contract
- Severity: low
- Category: bug / reliability
- Status: CONFIRMED
- Evidence: `normalize.ts:237` (title → 300, exit gate → 1000 with no diagnostic), `:149-160`
  (`primary_areas` → first 32 entries, each → 64 chars, no diagnostic), `:450` (`document` → 300).
- Impact: the brief's "Exit gate:" line and the UI show a truncated acceptance criterion without any
  warning; only the raw `sourceFields` JSON further down the brief keeps the full text. A generated
  plan with long exit gates would silently weaken the headline criterion.
- Recommendation: emit `warning` diagnostics (`field-truncated`) whenever a value is cut, and show
  them on the plan version page.
- Effort: S
- Related: FMT-08
- Plan/roadmap format impact: none (diagnostics only).

### FMT-15: Execution tests bypass the importer with definitions it would reject
- Severity: medium
- Category: testing
- Status: CONFIRMED
- Evidence: `server-execution.test.ts:7580-7700` (`slicedFixture`) and
  `roadmap-capacity.test.ts` insert definitions directly with `storage.imports.addDefinition`,
  using parent id `AQ-01` (fails the id pattern), a single repository with no upstream or baseline
  (fails `aq_baseline_binding` and the 2-lock minimum), `acceptance_coverage: []` (minItems 1), empty
  `resources_by_phase` arrays (minItems 1), fake digests (`'b'.repeat(64)`), and reviewer role
  `independent-reviewer` — the role the production whitelist exempts (FMT-04). There is exactly one
  real map fixture and no minimal valid map.
- Impact: the execution/phase-gate behaviour is verified against states the product can never
  reach through import, and the product-reachable combinations (real ids, resources, baseline) are
  covered only by the one large fixture. The whitelist exists to make these fixtures pass.
- Recommendation: write a minimal *valid* synthetic map (smallest stack the v0.3 schema admits)
  through `analyzeConcurrencyDefinition` in a shared test helper, use it for slice execution tests,
  and add a guard test that every `addDefinition` in tests goes through the validator. With v0.4
  (Appendix A) add a single-repository map fixture.
- Effort: M
- Related: FMT-04, FMT-05
- Plan/roadmap format impact: none.

### FMT-16: Roadmap entry limits are inconsistent and settings are duplicated in every entry and revision
- Severity: low
- Category: simplification
- Status: CONFIRMED
- Evidence: manual roadmap save caps entries at 100 (`contracts/src/roadmap.ts:48`); the
  cross-project save builds entries validated individually and bypasses the cap
  (`cross-project-service.ts:565`) — the live roadmap has 171. Every entry stores a full copy of
  `profiles`, `policy`, `instructions`, `automation`; each of the 11 live revisions stores all 171
  entries (definition rows ~200 KB each, `roadmaps.state_json` 248 KB).
- Impact: arbitrary limit asymmetry; storage/transfer growth per settings edit; a roadmap view
  serializes the whole definition. (Performance impact HYPOTHESIS.)
- Recommendation: store map-generated settings once (defaults/overrides already exist in
  `crossProject`) and derive per-entry settings on read, keeping the frozen per-entry copy only for
  started entries; make the entry limit a single documented constant.
- Effort: M
- Related: FMT-17
- Plan/roadmap format impact: roadmap definition storage shape (must keep reading existing
  revisions).

### FMT-17: STACK-PLAN-ACCEPTED evidence is bound to a digest of the whole roadmap definition
- Severity: medium
- Category: ux / architecture
- Status: CONFIRMED
- Evidence: `plan-acceptance-policy.ts:83-127` hashes facts including `roadmap: roadmap.definition`
  (all entries with instructions/profiles/policy, `createdAt`, revision), resource capacities and the
  full binding; `generatedPlanIssues` also requires the same `definitionRevision` (`:172-175`). The
  hash is `JSON.stringify` of an object, so it also depends on key insertion order.
- Impact: any roadmap save (e.g. editing queued instructions of one of 171 entries, or capacity)
  invalidates the operator's plan acceptance and re-asks that decision before Resume — a recurring
  operator decision caused by the binding scope, not by a plan change.
- Recommendation: bind plan acceptance to the facts the checkpoint's requirements name (map digest,
  bindings, adopted decisions, reviewer assignments, target) and exclude free-text instructions,
  agent/model profiles and timestamps; hash canonical JSON. Decide explicitly (ADR) which edits
  should re-open acceptance.
- Effort: S
- Related: FMT-19, FMT-18
- Plan/roadmap format impact: none (evidence binding rule).

### FMT-18: Canonical JSON for source-record fingerprints is an undocumented cross-language contract
- Severity: low
- Category: docs / reliability
- Status: CONFIRMED (two canonicalizers); non-ASCII mismatch is a HYPOTHESIS
- Evidence: `canonicalSourceRecord` sorts keys with default UTF-16 order and uses
  `JSON.stringify` for scalars (`concurrency.ts:46-59`); `canonicalDefinition` (amendment
  fingerprints) sorts with `localeCompare` (`packages/domain/src/concurrency-amendment.ts:86-94`);
  plan-acceptance and decision digests hash plain `JSON.stringify`. The map's
  `source_record_sha256` values were produced by the external author's tooling; the live records are
  ASCII-only, so escaping differences (e.g. Python `ensure_ascii`) have not been exercised.
- Impact: a generator in another language, or a record containing non-ASCII characters, may compute
  a different fingerprint and fail binding with `source-record-mismatch`.
- Recommendation: specify the canonical form (RFC 8785 JCS or the exact current JS behaviour) in
  `docs/formats.md`, use one canonicalizer everywhere, and add a non-ASCII fixture.
- Effort: S
- Related: FMT-11
- Plan/roadmap format impact: specification only (must not change existing digests).

### FMT-19: Operator decision points are implicit in the formats
- Severity: medium
- Category: architecture / ux
- Status: CONFIRMED
- Evidence: decisions an operator must make are spread over: map `decisions[]` (all-or-nothing
  adoption, `cross-project-service.ts:393-401`), `plan_approval` checkpoint (generated-evidence
  acceptance, FMT-04/17), `architecture_decision` checkpoints (proposal + approval, recognized by
  prose signature), early-development authorization (`scope_scheduling_authorizations`), evidence
  acceptance for every other checkpoint, parent acceptance when `parentAcceptance: manual`,
  `deferred_decisions[]` (validated, never shown), binding/active-plan choices, and roadmap
  delegation assignments. None of these is declared as "operator decision" in the formats; the
  server infers it from `kind` + profile text. The plan bundle has no decision construct at all
  (`decision-log` is a label).
- Impact: each inference path grew its own UI and notification handling (pain point 1:
  "multiple locations where operator decisions are asked/recorded"); `deferred_decisions` are
  invisible; partial adoption is impossible even when only one decision is contentious.
- Recommendation: introduce, without changing the import format, a single server-side
  "decision point" projection derived from the `CompiledMap` (type, subject, required authority,
  evidence contract, current state) that every UI surface and the notification outbox consume.
  Format-level typing is Appendix A.
- Effort: M
- Related: FMT-04, FMT-17; UI-unification reviewer
- Plan/roadmap format impact: none for the projection; Appendix A for typed decision nodes.

---

## Remediation direction

Sequencing (each step keeps current plans/roadmaps and the live `b81d5f92…` roadmap viable):

1. **Safety fixes, no model change (S each):** FMT-08 (phase bound), FMT-07 (single
   `effectiveDelegation` for scheduler/notifications/refresh), FMT-03 (validator uses
   `concurrencyMilestones`), FMT-14 (truncation warnings), remove the reviewer-role whitelist and fix
   the fixtures (part of FMT-04/15).
2. **Pin behaviour with golden conformance tests** before any refactor: for the fixture map and the
   live-shaped map, record `targetClosure` outputs, the generated roadmap entries for each target ×
   selection, `buildVerificationPolicy` per scope (the table in (review-session analysis script, not retained)),
   `scopePhaseBlockers`/`prerequisiteIssues`/`milestoneSatisfied` over synthetic observation sets,
   `subjectRequirements` per subject, capability recognizer results. Add a minimal valid synthetic
   map (FMT-15).
3. **Compiled model (FMT-01, 02, 09, 10):** a pure `CompiledMap` + `evaluate(milestone,
   observations, context)` in `packages/planning`, cached by `(definitionId, digest)`; a single
   server `MapObservations` adapter over storage; migrate `execution-scope`, `runtime-evidence-policy`,
   `cross-project-service`, `roadmap-service.complete`, `build-verification-policy`,
   `native-verification-policy`, `phase-resources` to it. One dependency policy for plan
   `depends_on`.
4. **Capability registry and decision projection (FMT-04, FMT-19):** one module owns all v0.3
   recognizers; the definition page shows which capabilities are active; a unified decision-point
   projection feeds UI and notifications.
5. **Studio seam (FMT-11, FMT-12, FMT-18):** canonical digest (dual during transition), documented
   canonical JSON, `docs/formats.md`, a normalized-definition entrypoint that references imported
   plan versions instead of embedded snapshots.
6. **Last resort — format v0.4 / plan v2 (Appendix A)**, validated into the same `CompiledMap`, with
   v0.3 and `exo-work-breakdown-v1` accepted unchanged forever.

Target design: `planning` owns *formats → compiled model → pure evaluation*; the server owns only
*observations* (DB/Git facts), *authority* (who may decide) and *side effects*. Every consumer asks
the model ("which requirements block this scope at merge?", "which decision points are open?")
instead of reading `definition.source`.

---

## Appendix A — Gaps and improvements to the formats themselves (last-resort items)

1. **One unified format family.** Today a single-project plan (`pull_requests`) cannot express
   slices, checkpoints, evidence or resources; those exist only in the cross-stack map, which
   requires ≥2 applications and an upstream baseline. Proposal: plan v2 = the work breakdown plus
   optional per-item `slices[]`, `checkpoints[]`, `evidence_profiles`, `resources`; a *stack*
   document that references plan versions (by content digest, not embedded snapshots) and adds only
   cross-plan edges, targets and upstream bindings. A roadmap is then "stack/plan + target +
   settings".
2. **Explicit operator-decision points.** Typed decision nodes: `{id, question, options?,
   authority: operator|agent|external, blocks: [milestone keys], evidence_contract, default?}`;
   partial adoption per decision; `deferred_decisions` promoted to visible, dated decision points.
3. **Typed capabilities instead of prose signatures.** `evidence_profiles[].review_contract:
   plan-acceptance | architecture-decision | technical-checkpoint | external`;
   `reviewer_roles[]` as objects `{id, purpose: technical|security|release|…}`;
   `resource_profiles[].adapter: local-development | native | kata | none`;
   `slices[].verification_mode: scoped | current-upstream` (replaces the `source_maturity` regex);
   `repositories[].build_system: cargo | none | …`.
4. **Decomposition feedback hooks.** A structured `planning_feedback` record (kinds from
   `init/craftingtable-planning-implementation-feedback-loop-addendum.md` §4: decomposition
   recommended, hidden dependency, resequencing, acceptance gap, …) that agents emit in their
   workflow report and that maps to an *amendment patch* (add/split slice, add edge, change scope)
   applied to a definition to produce a new revision — instead of today's free-text summary plus a
   whole re-imported ZIP (`MapAmendment {candidate: MapSelection, summary}`).
5. **Generic upstream/baseline model.** Replace `aq_baseline_binding` with optional
   `upstream_bindings[]`; rename `aq_baseline_case_ids`/`baseline_acceptance_coverage` to neutral
   names; make `requires_kata_host` a resource requirement; move supplement-document checks
   (`owner_pr`, provider references, lock files) into declared supplement profiles.
6. **Relaxed cardinalities.** `previous_definition` optional (first map), `resource_locks` ≥0 (a
   single-repo stack), `acceptance_coverage`/`decisions` ≥0, `status` beyond `draft`.
7. **ID grammar alignment.** Map parent/slice ids should accept every valid plan id
   (`[A-Za-z0-9][A-Za-z0-9._-]*`) with an explicit alias separator.
8. **Machine-readable scheduling hints.** Replace prose `priority_hint`/`planning_order` (ignored)
   with a numeric priority or an explicit "unlocks" weighting the scheduler can use; state whether
   closure order is authoritative.
9. **Plan bundle v2 details.** Bound every string field (incl. `phase`) with explicit errors;
   recognize and persist `repository`/`baseline_commit`/`integration_branch` so branch settings can
   be pre-filled; make checksum manifests verification-only (outside the digest); promote
   `recommends` rationale and `risk` into automation hints (e.g. risk-based review profiles).
10. **Canonicalization spec.** Adopt RFC 8785 (JCS) for all source-record and definition digests.

---

## Appendix B — Conformance fixtures any refactor must keep passing

Fixtures:
- `fixtures/plan-bundles/aq-cont-1/` (6 files; the AQ-CONT-1 discrete bundle) with expectations
  in `work-items/CT-03/CT-03-aq-import-expectations.yaml` (14 items, 24 required edges, one root
  `AQ-01`, exact edge list, retained fields).
- `fixtures/plan-bundles/invalid/*.yaml` (16 hostile/invalid work breakdowns: alias bomb, duplicate
  ids, duplicate edge, invalid ids, long cycle, malformed, missing dependency, missing fields, no
  items, unknown recommend, script injection, self dependency, two-node cycle, unknown tag,
  unrecognized risk, unsafe key).
- `fixtures/concurrency/cross-stack-concurrency-draft-v0.3.0-aq-baseline-alignment.zip`
  (`3df30b94…`; map YAML `51563f70…`; 335 nodes / 1 221 edges; 33 parents / 69 slices / 95
  checkpoints / 76 + 48 cases).
- `fixtures/concurrency/wi-fabric-2-foundational-package-r5-aq-baseline-alignment.zip`
  (`151dd46c…`) and `exo-v3-comprehensive-design-package-r6-aq-baseline-alignment.zip`
  (`5e430bea…`) — the plan ZIPs the map binds to.
- Live data (not a committed fixture, but the viability target): WI v2 / EXO v2 plan versions, map
  `EXO-STACK-CONCURRENCY-DRAFT-1` with binding revision 4, roadmap `b81d5f92…` revision 11
  (171 entries). A refactor should be replayed against a copy of the live DB.

Unit/integration tests (run with `npx vitest run <file>`; all 114 planning + policy tests pass at
`bf08c0b`):
- `packages/planning/src/aq-fixture.test.ts` — AQ bundle end to end (counts, edges, retained
  fields, checksum manifest, digest).
- `packages/planning/src/bundle.test.ts`, `normalize.test.ts`, `parse.test.ts`, `graph.test.ts`,
  `digest.test.ts` — plan-bundle rules and diagnostics.
- `packages/planning/src/archive.test.ts` — ZIP reader safety.
- `packages/planning/src/concurrency.test.ts` — exact v0.3 map accepted (digest, node/edge counts),
  weakened semantics rejected, cycles, dangling refs, source-record changes, coverage, snapshot
  hashes, aliases, normalized-definition seam, definition comparison.
- `packages/planning/src/concurrency-targets.test.ts` — `targetClosure` target-only vs
  prioritize-full semantics.
- `apps/server/src/server-plan-import.test.ts` — HTTP import of the AQ fixture, duplicates, new
  versions, failures, auth/CSRF.
- `apps/server/src/server-package-imports.test.ts` — WI/EXO ZIP imports, inactive map, exact
  binding, active-version rules, revision conflict, branch pinning.
- `apps/server/src/server-planning-queries.test.ts`, `server-planning-events.test.ts`,
  `restart.test.ts` — AQ fixture projections/events/restart.
- `apps/server/src/services/build-verification-policy.test.ts`,
  `runtime-input-policy.test.ts` — policies over the real map fixture.
- `apps/server/src/server-execution.test.ts` § "execution slices and parent acceptance" (line 7799+)
  and `roadmap-capacity.test.ts` — slice/parent phase gates (note FMT-15: these use synthetic
  definitions that bypass the validator).
- Web: `apps/web/src/features/planning/CrossProjectPanel.test.tsx`, `planning-views.test.tsx`,
  `RuntimeEvidencePanel.test.tsx`, `apps/web/src/features/execution/execution-views.test.tsx`.

End-to-end (Playwright; do not run in a shared session): `e2e/planning.spec.ts` (AQ import, admit,
duplicate/failed outcomes, hostile content), `e2e/package-imports.spec.ts` (WI/EXO ZIPs + map
binding on desktop and phone, fabricated Cargo upstream), `e2e/roadmaps.spec.ts`,
`e2e/delegation.spec.ts`, `e2e/finalization.spec.ts` (AQ fixture through roadmaps/finalization).

Gaps to add before refactoring: golden tests listed in Remediation step 2, a minimal valid
synthetic map, a non-ASCII source-record fixture, the FMT-03 reproduction, a long-`phase` plan, and a
test that one plan imported by ZIP and by discrete upload yields the documented (same or different)
digest.

Scratch reproductions used in this review (read-only, outside the repo):
(review-session analysis script, not retained), `fmt-cycle4.mjs`, `fmt-digest.mjs`, `fmt-bvp.mjs`
(under `(review-session analysis artifact, not retained)`).
