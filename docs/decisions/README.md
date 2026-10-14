# Architecture decision records

One Markdown file per material, hard-to-reverse decision, named `ADR-NNN-<slug>.md`. ADRs are
history: a later decision supersedes or refines an earlier one instead of rewriting it, and a
change to a decision is a dated amendment section inside its ADR. The current design is
described in [`../architecture.md`](../architecture.md) and [`../security.md`](../security.md);
an ADR holds the reasons.

## Header

Every ADR opens with its title and one list of header fields, in this order:

```text
# ADR-NNN: Title

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Supersedes:** ADR-NNN (what), …              optional
- **Superseded by:** ADR-NNN or register item     with status superseded, only then
- **Superseded in part by:** …                    with status partly superseded, only then
- **Refines:** ADR-NNN, …                         optional
- **Amended:** YYYY-MM-DD (R-…): what changed     optional, one line per amendment
- **Reviewed:** YYYY-MM-DD for …                  optional
```

Status is one of `proposed`, `accepted`, `partly superseded`, `superseded` or `deferred`.
Supersession is recorded at both ends: an ADR superseded by another names it, and the newer one
names the older under Supersedes. A decision retired by a remediation item without a new ADR
names the register item (`R-…`, see [the register](../review/2026-09-system-review/register.md)).
Write a context, the decision, its consequences and the alternatives considered. Later concerns
stay deferred rather than designed prematurely.

`scripts/check-docs.test.mjs` (part of `pnpm test`) checks every header and this index: each
ADR appears below once, with the title, status, date and relations of its header.
When the index is out of date, `node scripts/check-docs.mjs` prints the rows it should hold.

## Reading chains

Some decisions are spread over several records. Read the latest first:

- **Agent backends:** ADR-020 (the execution model and Claude Code; it superseded ADR-004, 006 and
  007), ADR-022 and ADR-023 (Codex; ADR-005 before them), ADR-068 (what the journal keeps).
- **Work items and merges:** ADR-021 (lifecycle and the review-gated merge; ADR-014 before it),
  ADR-025 (cycles), ADR-026 (integration branches), ADR-033 (delegated integration merges and
  explicit finalization), ADR-032 (conflict resolution).
- **Roadmaps:** ADR-029 and ADR-030 (sequential and parallel execution), ADR-073 (stopping,
  winding down and cleaning up).
- **Finalization:** ADR-042 (every finalization is staged) over ADR-033, refined by ADR-035, 036,
  038, 040 and 041; ADR-049 (cross-project finalization) and ADR-050 (saved-plan evidence).
- **Cross-project maps:** ADR-028 (boundaries), ADR-043 (imports), ADR-045 (slices and parent
  acceptance), ADR-046 (transition gates), ADR-047 and ADR-058 (pinned builds, dependency
  refresh), ADR-048 (supervision), ADR-053 and ADR-054 (scoped and native verification), ADR-074
  (Python toolchains and PyPI wheels for checks), ADR-060 (candidate checkpoints), ADR-069 (pin
  transitions), ADR-071 (slice verification).
- **Stops and recovery:** ADR-063 (controller obligations and operator questions), ADR-067
  (typed attention), ADR-037, 051, 052, 056, 057, 059, 062 and 065 (the bounded recoveries and
  decision preparation), ADR-066 (drained restarts).
- **Attention and notifications:** ADR-070 (attention items) over ADR-027.
- **Storage:** ADR-034 (placement and retention; scratch retention from ADR-031), ADR-039, ADR-068.
- **Browser:** ADR-015 (navigation and planning views), ADR-072 (the neighbourhood graph), ADR-003
  (events and the query store).

## Index

| ADR | Title | Status | Date | Relations |
|---|---|---|---|---|
| [ADR-001](ADR-001-server-and-web-framework.md) | Server and web framework | accepted | 2026-07-23 |  |
| [ADR-002](ADR-002-sqlite-and-migrations.md) | SQLite library and migration strategy | accepted | 2026-07-24 |  |
| [ADR-003](ADR-003-sse-event-contract.md) | Durable workspace SSE event contract | accepted | 2026-07-23 |  |
| [ADR-004](ADR-004-diff-viewer.md) | Diff viewer choice | superseded | 2026-07-23 | superseded by ADR-020 |
| [ADR-005](ADR-005-codex-integration.md) | Codex integration path | superseded | 2026-07-23 | superseded by ADR-022 |
| [ADR-006](ADR-006-local-tls.md) | Local TLS deployment | superseded | 2026-07-23 | superseded by ADR-020 |
| [ADR-007](ADR-007-agent-seam-deferred-to-ct-05.md) | Agent seam deferred to CT-05 | superseded | 2026-07-23 | superseded by ADR-020 |
| [ADR-008](ADR-008-toolchain-and-quality-gates.md) | Toolchain and quality gates | accepted | 2026-07-23 |  |
| [ADR-009](ADR-009-authentication-sessions-and-csrf.md) | Authentication, sessions, and CSRF | accepted | 2026-07-24 |  |
| [ADR-010](ADR-010-atomic-audit-and-workspace-events.md) | Atomic audit and workspace-event writes | accepted | 2026-07-24 |  |
| [ADR-011](ADR-011-plan-bundle-import-and-versioning.md) | Plan bundle import, versioning, and artifact preservation | partly superseded | 2026-07-24 | superseded in part by ADR-043 |
| [ADR-012](ADR-012-planning-domain-and-dependency-semantics.md) | Planning domain and dependency semantics | accepted | 2026-07-24 |  |
| [ADR-013](ADR-013-journal-vocabulary-catalogs.md) | Journal vocabulary catalogs | accepted | 2026-07-24 |  |
| [ADR-014](ADR-014-work-item-admission-and-draft-contracts.md) | Work-item admission and non-executable draft contracts | superseded | 2026-07-24 | superseded by ADR-021 |
| [ADR-015](ADR-015-browser-navigation-and-planning-views.md) | Browser navigation and planning views | partly superseded | 2026-07-24 | superseded in part by ADR-072 |
| [ADR-016](ADR-016-trusted-local-git-inspection-boundary.md) | Trusted local Git inspection boundary | superseded | 2026-07-26 | superseded by R-B8 |
| [ADR-017](ADR-017-repository-evidence-and-persistence.md) | Repository evidence and persistence | superseded | 2026-07-28 | superseded by R-B8, R-H6 |
| [ADR-018](ADR-018-repository-journal-correlation.md) | Repository journal correlation | superseded | 2026-07-29 | superseded by R-H6, R-B8 |
| [ADR-019](ADR-019-optional-repository-feature-and-evidence-translation.md) | Optional repository feature and evidence translation | superseded | 2026-08-11 | superseded by R-B8 |
| [ADR-020](ADR-020-execution-model-and-claude-code-backend.md) | Execution model and the Claude Code backend | accepted | 2026-09-04 | supersedes ADR-004, ADR-006, ADR-007 |
| [ADR-021](ADR-021-work-item-lifecycle-and-review-gated-merge.md) | Work item lifecycle and the review-gated merge | accepted | 2026-09-05 | supersedes ADR-014 |
| [ADR-022](ADR-022-codex-backend-and-turn-per-process-sessions.md) | Codex backend and turn-per-process sessions | partly superseded | 2026-09-09 | supersedes ADR-005; superseded in part by ADR-023 |
| [ADR-023](ADR-023-codex-app-server.md) | Codex app-server integration | accepted | 2026-09-09 | supersedes ADR-022 |
| [ADR-024](ADR-024-complete-handoffs-and-review-findings.md) | Complete handoffs and consolidated review findings | accepted | 2026-09-10 |  |
| [ADR-025](ADR-025-bounded-work-item-cycles.md) | Bounded work-item cycles with operator merge approval | accepted | 2026-09-10 |  |
| [ADR-026](ADR-026-plan-integration-branches.md) | Plan integration branches and review freshness | accepted | 2026-09-10 |  |
| [ADR-027](ADR-027-persistent-attention-notifications.md) | Persistent attention notifications | partly superseded | 2026-09-10 | superseded in part by ADR-070, R-G9 |
| [ADR-028](ADR-028-roadmaps-and-planning-studio-boundaries.md) | Roadmaps and Planning Studio boundaries | accepted | 2026-09-11 |  |
| [ADR-029](ADR-029-sequential-roadmap-execution.md) | Sequential roadmap execution | accepted | 2026-09-11 |  |
| [ADR-030](ADR-030-controlled-parallel-roadmaps.md) | Controlled parallel roadmaps | accepted | 2026-09-11 |  |
| [ADR-031](ADR-031-worktree-finalization-and-review-housekeeping.md) | Worktree finalization and review housekeeping | partly superseded | 2026-09-11 | superseded in part by ADR-034, R-G5 |
| [ADR-032](ADR-032-delegated-integration-conflict-resolution.md) | Delegated integration conflict resolution | accepted | 2026-09-12 |  |
| [ADR-033](ADR-033-delegated-integration-and-plan-finalization.md) | Delegated integration and explicit plan finalization | partly superseded | 2026-09-12 | superseded in part by ADR-042, R-B10; refines ADR-021, ADR-025, ADR-029, ADR-032 |
| [ADR-034](ADR-034-storage-placement-and-retention.md) | Storage placement and retention | accepted | 2026-09-12 | supersedes ADR-031 |
| [ADR-035](ADR-035-compact-finalization-reports.md) | Compact finalization reports and scoped recovery guidance | accepted | 2026-09-13 | refines ADR-024, ADR-033 |
| [ADR-036](ADR-036-finalization-remediation-authorization.md) | Explicit additional finalization remediation | accepted | 2026-09-13 | refines ADR-033, ADR-035 |
| [ADR-037](ADR-037-background-work-completion-recovery.md) | Bounded recovery of incomplete background work | accepted | 2026-09-14 | refines ADR-020, ADR-025, ADR-033 |
| [ADR-038](ADR-038-finalization-finding-decisions.md) | Explicit finalization finding decisions | accepted | 2026-09-15 | refines ADR-033, ADR-036 |
| [ADR-039](ADR-039-post-run-build-cache-cleanup.md) | Clean build caches when runs end | accepted | 2026-09-15 | refines ADR-034, ADR-037 |
| [ADR-040](ADR-040-finalization-recovery-agent-selection.md) | Change the finalization agent at recovery | accepted | 2026-09-15 | refines ADR-033, ADR-038 |
| [ADR-041](ADR-041-plan-completion-and-integration-cleanup.md) | Plan completion and optional integration branch cleanup | accepted | 2026-09-15 | refines ADR-026, ADR-033 |
| [ADR-042](ADR-042-staged-plan-finalization.md) | Staged plan finalization | accepted | 2026-09-15 | supersedes ADR-033 |
| [ADR-043](ADR-043-package-imports-and-concurrency-previews.md) | ZIP packages and bound concurrency-map drafts | accepted | 2026-09-15 | supersedes ADR-011 |
| [ADR-044](ADR-044-return-unstarted-items-to-proposed.md) | Return unstarted agenda items to Proposed | accepted | 2026-09-15 |  |
| [ADR-045](ADR-045-slice-execution-and-parent-acceptance.md) | Slice execution and parent acceptance | accepted | 2026-09-16 |  |
| [ADR-046](ADR-046-transition-gates-and-resource-reservations.md) | Transition gates and resource reservations | accepted | 2026-09-16 |  |
| [ADR-047](ADR-047-pinned-builds-and-reviewed-evidence.md) | Pinned builds and reviewed evidence | accepted | 2026-09-16 |  |
| [ADR-048](ADR-048-cross-project-supervision.md) | Cross-project supervision and explicit target scope | accepted | 2026-09-16 |  |
| [ADR-049](ADR-049-reviewed-map-amendments-and-finalization.md) | Reviewed amendments and cross-project finalization | accepted | 2026-09-16 |  |
| [ADR-050](ADR-050-generated-plan-acceptance-evidence.md) | Generated saved-plan evidence and explicit operator review | accepted | 2026-09-17 |  |
| [ADR-051](ADR-051-design-question-recovery.md) | Bounded design-question recovery | accepted | 2026-09-17 |  |
| [ADR-052](ADR-052-historical-baseline-preparation.md) | Controller-owned historical baseline preparation | accepted | 2026-09-17 |  |
| [ADR-053](ADR-053-scoped-verification-and-local-ci.md) | Scope-specific verification and local CI | accepted | 2026-09-17 |  |
| [ADR-054](ADR-054-managed-native-verification.md) | Managed native verification and workstation readiness | accepted | 2026-09-17 |  |
| [ADR-055](ADR-055-repository-policy-evidence.md) | Repository policy and operator decisions across execution scopes | accepted | 2026-09-17 |  |
| [ADR-056](ADR-056-owning-slice-review-recovery.md) | Owning-slice remediation from independent reviews | accepted | 2026-09-17 |  |
| [ADR-057](ADR-057-bounded-roadmap-scope-recovery.md) | Bounded roadmap recovery across independent review stages | accepted | 2026-09-18 |  |
| [ADR-058](ADR-058-reviewed-dependency-refresh.md) | Reviewed dependency refresh and precise evidence reuse | accepted | 2026-09-19 | refines ADR-047, ADR-053, ADR-054 |
| [ADR-059](ADR-059-shared-design-decisions.md) | Shared design decisions and bounded predecessor waits | accepted | 2026-09-19 |  |
| [ADR-060](ADR-060-candidate-checkpoint-evidence.md) | Candidate checkpoint evidence and assigned baseline cases | accepted | 2026-09-20 |  |
| [ADR-061](ADR-061-host-verification-settings.md) | Visible host verification capacity | accepted | 2026-09-22 |  |
| [ADR-062](ADR-062-bounded-provider-recovery.md) | Bounded recovery from model-service failures | accepted | 2026-09-22 |  |
| [ADR-063](ADR-063-controller-obligations-and-operator-questions.md) | Controller obligations and operator questions | accepted | 2026-09-22 |  |
| [ADR-064](ADR-064-agent-profile-delegation.md) | Agent selection is operational delegation | accepted | 2026-09-22 |  |
| [ADR-065](ADR-065-future-delegation-and-decision-preparation.md) | Future delegation and independent decision preparation | accepted | 2026-09-22 |  |
| [ADR-066](ADR-066-drained-restarts-and-session-resume.md) | Drained restarts and session resume | accepted | 2026-09-23 |  |
| [ADR-067](ADR-067-typed-attention.md) | Typed attention declared by the controller | accepted | 2026-09-23 |  |
| [ADR-068](ADR-068-journal-retention.md) | Journal retention: raw lines on failure only, tool-result bodies beside the run | accepted | 2026-09-24 | refines ADR-020, ADR-034, ADR-039 |
| [ADR-069](ADR-069-upstream-pin-transitions.md) | Map-declared upstream pin transitions | accepted | 2026-09-25 |  |
| [ADR-070](ADR-070-attention-items.md) | Attention items, a delivery log and push gates | accepted | 2026-09-25 | supersedes ADR-027 |
| [ADR-071](ADR-071-slice-verification-stays-a-separate-gate.md) | Slice verification stays a separate gate | accepted | 2026-10-07 |  |
| [ADR-072](ADR-072-roadmap-neighbourhood-graph.md) | A roadmap's neighbourhood graph | accepted | 2026-10-09 | supersedes ADR-015 |
| [ADR-073](ADR-073-winding-down-a-roadmap.md) | Winding down a roadmap | accepted | 2026-10-13 | refines ADR-029, ADR-041, ADR-049 |
| [ADR-074](ADR-074-python-toolchains-and-pypi-wheels.md) | Python toolchains and PyPI wheels for checks | accepted | 2026-10-13 | refines ADR-053 |
