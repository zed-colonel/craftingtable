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
```

Each ADR should contain:

- status: proposed, accepted, superseded, or deferred;
- context;
- decision;
- consequences;
- alternatives considered;
- date.

CT-01 should decide only what is required for the executable skeleton. Later decisions may be created as concise `deferred` records rather than designed prematurely.
