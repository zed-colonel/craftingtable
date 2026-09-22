# ADR-061 — Visible host verification capacity

- Status: accepted
- Date: 2026-09-22

The verification pool is shared across workspaces and separate from development and roadmap
in-flight limits. Expose its 1–32 capacity in Settings, alongside current reservations and
recorded cycle waits. An owner of every active workspace can read and update the installation
setting through authenticated, CSRF-protected commands. Saves use an expected version and an
audit record. Schema 25 adds setting provenance to the existing resource-limit table.

Until the first browser save, the daemon environment/default remains authoritative. A saved
verification value takes precedence on subsequent starts. Development still uses its environment
configuration. No other admission, dependency, review or merge authority changes.

Require roadmap scheduling to be paused before changing the capacity. Capacity remains part
of saved-plan acceptance, so a changed value requires fresh evidence generation and explicit
acceptance before affected cross-project work resumes. Saving neither approves nor resumes.
Use the current verification limit for new reservations; historical claims retain their original
limit for provenance. Increasing permits independent eligible reviews to overlap. Decreasing
never terminates existing work and blocks new claims until use falls below the current limit.

Settings reads use existing reservation and cycle records rather than recomputing the entire
cross-project graph. Recorded waits are labelled accordingly; undispatched work and dependency
reasons remain in Roadmaps. An explicit refresh preserves unsaved capacity edits. The browser
never auto-refreshes the page or launches recovery from this control.
