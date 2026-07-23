# ADR-004 — Diff viewer choice

- **Status:** deferred
- **Date:** 2026-07-23

## Context

Diff review arrives with change requests and worktrees in CT-04. CT-01 explicitly excludes diff viewing.

## Decision

Deferred until CT-04. The CT-01 UI contains no diff surface and adds no diff dependency.

## Notes for the future decision

Requirements from the implementation plan (§11.6): changed-file tree, unified or side-by-side view, syntax highlighting, inline findings, and generation-to-generation comparison. Candidates include a maintained diff component versus rendering `git diff` output with a small highlighter. Choose against real AQ-01 diffs, not synthetic examples.
