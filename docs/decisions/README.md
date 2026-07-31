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
```

Each ADR should contain:

- status: proposed, accepted, superseded, or deferred;
- context;
- decision;
- consequences;
- alternatives considered;
- date.

The active work contract decides which records may move from deferred to
accepted. Later concerns stay deferred rather than being designed prematurely.
