# Architecture decision records

Use one Markdown file per material decision:

```text
ADR-001-server-and-web-framework.md
ADR-002-sqlite-and-migrations.md
ADR-003-sse-event-contract.md
ADR-004-diff-viewer.md
ADR-005-codex-integration.md
ADR-006-local-tls.md
ADR-007-agent-execution-boundary.md
ADR-008-toolchain-and-quality-gates.md
ADR-009-authentication-sessions-and-csrf.md
ADR-010-atomic-audit-and-workspace-events.md
ADR-011-plan-bundle-import-and-versioning.md
ADR-012-planning-domain-and-dependency-semantics.md
ADR-013-journal-vocabulary-catalogs.md
ADR-014-work-item-admission-and-draft-contracts.md
ADR-015-browser-navigation-and-planning-views.md
ADR-016-trusted-local-git-inspection-boundary.md
ADR-017-repository-evidence-and-persistence.md
ADR-018-repository-journal-correlation.md
ADR-019-optional-repository-feature-and-evidence-translation.md
ADR-020-execution-model-and-claude-code-backend.md
ADR-021-work-item-lifecycle-and-review-gated-merge.md
ADR-022-codex-backend-and-turn-per-process-sessions.md
ADR-023-codex-app-server.md
ADR-024-complete-handoffs-and-review-findings.md
ADR-025-bounded-work-item-cycles.md
ADR-026-plan-integration-branches.md
ADR-027-persistent-attention-notifications.md
ADR-028-roadmaps-and-planning-studio-boundaries.md
ADR-029-sequential-roadmap-execution.md
ADR-030-controlled-parallel-roadmaps.md
ADR-031-worktree-finalization-and-review-housekeeping.md
ADR-032-delegated-integration-conflict-resolution.md
ADR-051-design-question-recovery.md
```

Each ADR should contain:

- status: proposed, accepted, superseded, or deferred;
- context;
- decision;
- consequences;
- alternatives considered;
- date.

Write an ADR only for a decision that is material and hard to reverse. Later
concerns stay deferred rather than being designed prematurely.
